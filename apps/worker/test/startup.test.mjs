import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.mjs";
import { startServer } from "../src/server.mjs";
import { Runner } from "../src/runner.mjs";

test("손상된 DB의 시작 실패는 연결과 이번 잠금만 정리하며 원본을 덮어쓰지 않는다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "otter-startup-corrupt-"));
  const database = join(directory, "otter.db");
  const original = Buffer.from("복구해야 하는 손상된 원본 · 비공개 데이터");
  await writeFile(database, original);
  let closed = 0;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, "close", function () {
    closed++;
    return close.call(this);
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(startServer({ directory, port: 0 }), {
      code: "OTTER_DATA_UNAVAILABLE",
    });
    assert.equal(closed, attempt, "실패한 생성자의 DB 연결도 닫힌다");
    assert.deepEqual(await readFile(database), original);
    await assert.rejects(lstat(join(directory, "worker.lock")), {
      code: "ENOENT",
    });
  }
  // 수리나 자동 초기화를 하지 않는다. 새 폴더에서는 별도의 빈 작업공간을 열 수 있다.
  const fresh = await startServer({
    directory: join(directory, "new-profile"),
    port: 0,
  });
  assert.deepEqual(fresh.store.all("projects"), []);
  await fresh.close();
  assert.deepEqual(await readFile(database), original);
});

test("DB 이후 초기화 실패와 포트 충돌을 정리하고 기존 실행부·기록을 유지한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-startup-init-"));
  const database = join(directory, "otter.db");
  const fixture = new Store(database);
  const org = fixture.insert("companies", {
    name: "보존할 회사",
    mode: "single",
  });
  fixture.db
    .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
    .run("workerId", "{broken-private-value");
  fixture.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(startServer({ directory, port: 0 }), (error) => {
      assert.equal(error.code, "OTTER_DATA_UNAVAILABLE");
      assert.match(error.message, /작업 기록/);
      assert.doesNotMatch(error.message, /broken-private-value/);
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(lstat(join(directory, "worker.lock")), {
      code: "ENOENT",
    });
  }
  const inspect = new DatabaseSync(database, { readOnly: true });
  assert.equal(
    JSON.parse(
      inspect.prepare("SELECT data FROM companies WHERE id=?").get(org.id).data,
    ).name,
    org.name,
  );
  assert.equal(
    inspect.prepare("SELECT value FROM metadata WHERE key='workerId'").get()
      .value,
    "{broken-private-value",
  );
  inspect.close();
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../src/server.mjs", import.meta.url))],
      {
        env: { ...process.env, OTTER_V2_DATA: directory, OTTER_V2_PORT: "0" },
        timeout: 5000,
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /작업 기록/);
      assert.doesNotMatch(error.stderr, /broken-private-value|SyntaxError/);
      assert.equal(error.stdout, "");
      return true;
    },
  );
  await assert.rejects(lstat(join(directory, "worker.lock")), {
    code: "ENOENT",
  });

  const first = await startServer({
    directory: join(directory, "healthy"),
    port: 0,
  });
  const secondDirectory = join(directory, "port-conflict");
  try {
    await assert.rejects(
      startServer({
        directory: secondDirectory,
        port: Number(new URL(first.origin).port),
      }),
      { code: "EADDRINUSE" },
    );
    await assert.rejects(lstat(join(secondDirectory, "worker.lock")), {
      code: "ENOENT",
    });
    const lockBefore = await readFile(
      join(directory, "healthy", "worker.lock"),
    );
    await assert.rejects(
      startServer({ directory: join(directory, "healthy"), port: 0 }),
      /잠금/,
    );
    assert.deepEqual(
      await readFile(join(directory, "healthy", "worker.lock")),
      lockBefore,
    );
    assert.equal(
      (
        await fetch(first.origin + "/api/health", {
          headers: { Authorization: `Bearer ${first.token}` },
        })
      ).status,
      200,
    );
    const second = await startServer({ directory: secondDirectory, port: 0 });
    await second.close();
  } finally {
    await first.close();
  }
});

test("포트를 연 뒤 실행 큐 초기화가 실패해도 HTTP 서버와 자신의 잠금을 정리한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "otter-startup-listen-"));
  const probe = await startServer({ directory, port: 0 });
  const port = Number(new URL(probe.origin).port);
  await probe.close();
  t.mock.method(Runner.prototype, "pump", () => {
    throw new Error("검사 큐 초기화 실패");
  });
  await assert.rejects(startServer({ directory, port }), /검사 큐 초기화 실패/);
  await assert.rejects(lstat(join(directory, "worker.lock")), {
    code: "ENOENT",
  });
  t.mock.restoreAll();
  const again = await startServer({ directory, port });
  await again.close();
});

test("다른 원격 소유자와 종료 중 바뀐 잠금을 보존한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-startup-owner-"));
  const owner = randomUUID();
  const first = await startServer({
    directory,
    port: 0,
    headless: true,
    controllerId: owner,
    slots: 1,
  });
  await first.close();
  await assert.rejects(
    startServer({
      directory,
      port: 0,
      headless: true,
      controllerId: randomUUID(),
      slots: 2,
    }),
    /다른 Otter/,
  );
  await assert.rejects(lstat(join(directory, "worker.lock")), {
    code: "ENOENT",
  });
  const second = await startServer({
    directory,
    port: 0,
    headless: true,
    controllerId: owner,
    slots: 1,
  });
  assert.equal(second.store.metadata("controllerId"), owner);
  const lock = join(directory, "worker.lock"),
    held = join(directory, "owned.lock");
  await rename(lock, held);
  const foreign = JSON.stringify({ pid: process.pid, marker: "다른 잠금" });
  await writeFile(lock, foreign, { flag: "wx" });
  try {
    await assert.rejects(second.close(), /소유권이 변경/);
    assert.equal(await readFile(lock, "utf8"), foreign);
  } finally {
    // 검사에서 옮긴 자신의 잠금만 복원한다. 다른 잠금도 삭제하지 않고 별도 보존한다.
    await rename(lock, join(directory, "foreign.lock"));
    await rename(held, lock);
    await second.close();
  }
  assert.equal(
    await readFile(join(directory, "foreign.lock"), "utf8"),
    foreign,
  );
});
