import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  access,
  symlink,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../worker/src/store.mjs";
import { startServer } from "../../worker/src/server.mjs";
import { saveRecordBackup } from "../src/backup.mjs";

test("실제 WAL 기록은 독립 사본으로 검증·보존하고 기존 파일·원본·링크는 덮어쓰지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-backup-test-"));
  const source = join(directory, "source.db");
  const path = join(directory, "records.sqlite");
  const store = new Store(source);
  try {
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    const company = store.insert("companies", { name: "백업 회사" });
    const project = store.insert("projects", {
      companyId: company.id,
      root: join(directory, "project"),
    });
    const task = store.insert("tasks", {
      projectId: project.id,
      status: "queued",
      prompt: "실행하면 안 되는 보존 업무",
    });
    for (const table of ["documents", "messages", "reports"])
      store.insert(table, {
        projectId: project.id,
        body: "기록 내용 " + table,
      });
    store.db
      .prepare("INSERT INTO remote_cache VALUES(?,?,?)")
      .run("remote", "project", '{"cached":true}');
    await writeFile(
      join(directory, "auth-fixture.json"),
      "별도로 보존할 인증 파일",
    );
    assert.ok((await stat(source + "-wal")).size > 0);
    const result = await saveRecordBackup(store, path);
    const bytes = await readFile(path);
    assert.equal(result.saved, true);
    assert.equal(result.path, path);
    assert.equal(result.bytes, bytes.length);
    assert.equal(
      result.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(access(path + "-wal"), { code: "ENOENT" });
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(copy.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(
        copy.prepare("PRAGMA journal_mode").get().journal_mode,
        "delete",
      );
      assert.deepEqual(
        JSON.parse(
          copy.prepare("SELECT data FROM tasks WHERE id=?").get(task.id).data,
        ),
        task,
      );
      for (const table of [
        "companies",
        "projects",
        "documents",
        "messages",
        "reports",
        "remote_cache",
      ])
        assert.equal(
          copy.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
          1,
        );
      assert.deepEqual(
        JSON.parse(
          copy
            .prepare(
              "SELECT value FROM metadata WHERE key='otter.recordBackup'",
            )
            .get().value,
        ),
        {
          format: 1,
          scope: "local-records",
          createdAt: result.createdAt,
        },
      );
    } finally {
      copy.close();
    }
    assert.equal(
      store.db
        .prepare("SELECT value FROM metadata WHERE key='otter.recordBackup'")
        .get(),
      undefined,
    );
    for (const destination of [path, source])
      await assert.rejects(
        saveRecordBackup(store, destination),
        /덮어쓰지 말고/,
      );
    if (process.platform !== "win32") {
      const link = join(directory, "link.sqlite"),
        missing = join(directory, "missing.sqlite");
      await symlink(source, link);
      await assert.rejects(saveRecordBackup(store, link), /덮어쓰지 말고/);
      const dangling = join(directory, "dangling.sqlite");
      await symlink(missing, dangling);
      await assert.rejects(saveRecordBackup(store, dangling), /덮어쓰지 말고/);
      await assert.rejects(access(missing), { code: "ENOENT" });
    }
    for (const destination of ["relative.sqlite", "", null, path + "\n"])
      await assert.rejects(saveRecordBackup(store, destination), /절대 경로/);
    await assert.rejects(
      saveRecordBackup(
        store,
        join(directory, "no-directory", "records.sqlite"),
      ),
      /완료하지 못했습니다/,
    );
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(
      await readFile(join(directory, "auth-fixture.json"), "utf8"),
      "별도로 보존할 인증 파일",
    );
    assert.deepEqual(store.get("tasks", task.id), task);
    store.insert("companies", { name: "백업 후 원본 계속 사용" });
    assert.equal(store.all("companies").length, 2);
    store.close();
    await assert.rejects(
      saveRecordBackup(store, join(directory, "closed.sqlite")),
      /완료하지 못했습니다/,
    );
    await assert.rejects(access(join(directory, "closed.sqlite")), {
      code: "ENOENT",
    });
    console.log(
      JSON.stringify({
        directory,
        bytes: result.bytes,
        sha256: result.sha256,
        sourcePreserved: true,
      }),
    );
  } finally {
    store.close();
  }
});

test("보존용 사본을 실행용 DB로 열면 업무 시작 전에 거절하고 자체 잠금만 정리한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-backup-startup-"));
  const source = new Store(join(directory, "source.db"));
  const archive = join(directory, "records.sqlite");
  try {
    const company = source.insert("companies", { name: "자동 재개 금지" });
    const project = source.insert("projects", {
      companyId: company.id,
      root: join(directory, "project"),
    });
    source.insert("tasks", { projectId: project.id, status: "queued" });
    await saveRecordBackup(source, archive);
    const bytes = await readFile(archive);
    assert.throws(() => new Store(archive), { code: "OTTER_RECORD_BACKUP" });
    assert.deepEqual(await readFile(archive), bytes);
    const profile = await mkdtemp(join(directory, "profile-"));
    const dbPath = join(profile, "otter.db");
    await copyFile(archive, dbPath);
    let modelCalls = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        startServer({
          directory: profile,
          port: 0,
          makeCodex: () => {
            modelCalls++;
            throw new Error("모델 실행 금지");
          },
        }),
        { code: "OTTER_RECORD_BACKUP" },
      );
      await assert.rejects(access(join(profile, "worker.lock")), {
        code: "ENOENT",
      });
      assert.deepEqual(await readFile(dbPath), bytes);
    }
    assert.equal(modelCalls, 0);
    assert.equal(source.all("tasks")[0].status, "queued");
  } finally {
    source.close();
  }
});
