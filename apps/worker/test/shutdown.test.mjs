import test from "node:test";
import assert from "node:assert/strict";
import { Codex } from "../src/codex.mjs";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import { git, checkpoint } from "../src/git.mjs";
import { ProjectPush } from "../src/push.mjs";

async function waitFor(check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("검사 대상 상태가 제한 시간 내에 나타나지 않았습니다.");
}

test("Codex의 명시적 RPC 거절과 응답 시간 초과를 구분한다", async () => {
  const client = new Codex({
    command: process.execPath,
    args: [
      "-e",
      `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if(m.id === undefined || m.method === 'hold') return;
      console.log(JSON.stringify(m.method === 'reject' ? {id:m.id,error:{code:-32602,message:'합성 거절'}} : {id:m.id,result:{}}));
    });
  `,
    ],
  });
  try {
    await client.initialize();
    await assert.rejects(
      client.request("reject"),
      (error) => error.rpcRejected === true,
    );
    await assert.rejects(
      client.request("hold", {}, 30),
      (error) => error.rpcRejected !== true,
    );
  } finally {
    await client.close();
  }
});

test("실행 종료는 SIGTERM 전송이 아니라 자식 프로세스 close를 기다린다", async () => {
  const client = new Codex({
    command: process.execPath,
    args: [
      "-e",
      `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));console.log(JSON.stringify({method:'ready'}));setInterval(()=>{},1000);`,
    ],
  });
  await once(client, "notification");
  const began = Date.now();
  await client.close();
  assert.ok(Date.now() - began >= 100);
  assert.equal(client.process.exitCode, 0);
  await client.close();
});

test("실행 파일이 없는 경우에도 종료 확인을 끝낼 수 있다", async () => {
  const client = new Codex({ command: "/nonexistent/otter-codex-test" });
  await once(client, "disconnected");
  await client.close();
});

test("푸시 응답 연결이 끊겨도 결과 기록까지 기다린 뒤 종료하고 재시작 시 중복 전송하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-shutdown-push-"));
  const directory = join(root, "worker");
  const release = join(root, "release");
  const marker = join(root, "receiver-started");
  let app = await startServer({ directory, port: 0 });
  let closing;
  let client;
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "종료 검사", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: root,
      folder: "original",
    });
    const destination = join(root, "destination.git");
    await git(root, ["init", "--bare", destination]);
    await git(project.root, ["remote", "add", "origin", destination]);
    await writeFile(join(project.root, "result.txt"), "실제 전송 결과");
    const commit = await checkpoint({ path: project.root }, "종료 검사");
    // 외부 계정 대신 임시 bare 저장소의 실제 수신 처리를 명시적인 해제까지 지연한다.
    await writeFile(
      join(destination, "hooks", "pre-receive"),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'received\\n');
const timeout = setTimeout(() => process.exit(1), 15000);
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
}, 10);
`,
      { mode: 0o700 },
    );
    const push = new ProjectPush(app.store, app.runner);
    const input = { remote: "origin", branch: "main" };
    const preview = await push.preview(project.id, input);
    const key = randomUUID();
    const body = JSON.stringify({
      ...input,
      approval: preview.approval,
      confirm: true,
      confirmAutomation: true,
    });
    const path = `/api/projects/${project.id}/push`;
    client = request(app.origin + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${app.token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Idempotency-Key": key,
      },
    });
    client.on("error", () => {});
    client.end(body);
    await waitFor(() =>
      readFile(marker).then(
        () => true,
        () => false,
      ),
    );
    const executing = app.store.get("projects", project.id).push;
    assert.equal(executing.status, "sending");
    assert.equal(executing.process.closed, false);
    process.kill(executing.process.pid, 0);
    const disconnected = new Promise((resolve) =>
      client.once("close", resolve),
    );
    client.destroy();
    await disconnected;

    closing = app.close();
    assert.equal(
      app.close(),
      closing,
      "동시에 요청한 종료는 같은 완료를 기다린다",
    );
    const rejected = await fetch(app.origin + "/api/companies", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${app.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "종료 중 생성 금지", mode: "single" }),
    });
    assert.equal(rejected.status, 503);
    assert.match((await rejected.json()).error, /접수하지 않았습니다/);
    assert.equal(app.store.all("companies").length, 1);
    assert.equal(
      JSON.parse(await readFile(join(directory, "worker.lock"), "utf8")).pid,
      process.pid,
    );
    assert.equal(app.store.get("projects", project.id).push.status, "sending");
    await assert.rejects(startServer({ directory, port: 0 }), /잠금/);

    await writeFile(release, "수신 완료 허용");
    await closing;
    await app.close();
    await assert.rejects(readFile(join(directory, "worker.lock")), {
      code: "ENOENT",
    });
    app = await startServer({ directory, port: 0 });
    closing = undefined;
    const stored = app.store.get("projects", project.id).push;
    assert.equal(stored.status, "pushed");
    assert.equal(stored.process.closed, true);
    assert.equal(stored.process.code, 0);
    assert.equal(app.store.requestResult(key).state, "completed");
    assert.equal(app.store.requestResult(key).result.status, 200);
    const replay = await fetch(app.origin + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${app.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body,
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).commit, commit);
    assert.equal(await readFile(marker, "utf8"), "received\n");
    assert.equal(app.store.all("reports", project.id).length, 1);
    assert.equal(
      await git(destination, ["rev-parse", "refs/heads/main"]),
      commit,
    );
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), commit);
  } finally {
    client?.destroy();
    await writeFile(release, "검사 정리");
    await closing?.catch(() => {});
    await app.close();
  }
});

test("원격 종료 실패는 DB/잠금과 인증된 상태 조회를 유지하고 새 업무 대신 종료 재시도만 허용한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-shutdown-retry-"));
  let shutdown;
  const app = await startServer({
    directory,
    port: 0,
    headless: true,
    controllerId: randomUUID(),
    slots: 1,
    onShutdown: () => {
      shutdown = app.close();
    },
  });
  const close = app.runner.close.bind(app.runner);
  try {
    app.runner.close = async () => {
      throw new Error("프로세스 종료 미확인");
    };
    await assert.rejects(app.close(), /종료 미확인/);
    assert.equal(app.runner.stopping, true);
    assert.ok(app.store.settings());
    assert.ok(await readFile(join(directory, "worker.lock")));
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { Authorization: `Bearer ${app.token}` },
        })
      ).status,
      503,
    );
    await assert.rejects(startServer({ directory, port: 0 }), /잠금/);
    assert.equal((await fetch(app.origin + "/api/health")).status, 401);
    const health = await fetch(app.origin + "/api/health", {
      headers: { Authorization: `Bearer ${app.token}` },
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).stopping, true);
    assert.equal(
      (
        await fetch(app.origin + "/api/shutdown", {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(shutdown, undefined);
    app.runner.close = close;
    const retry = await fetch(app.origin + "/api/shutdown", {
      method: "POST",
      body: "{}",
      headers: {
        Authorization: `Bearer ${app.token}`,
        "Idempotency-Key": randomUUID(),
      },
    });
    assert.equal(retry.status, 200);
    await waitFor(() => Boolean(shutdown));
    await shutdown;
  } finally {
    app.runner.close = close;
    await app.close();
  }
  await assert.rejects(readFile(join(directory, "worker.lock")), {
    code: "ENOENT",
  });
});

test("본문 전송이 끝나지 않은 요청은 종료를 막거나 업무를 생성하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-shutdown-body-"));
  let app = await startServer({ directory, port: 0 });
  const key = randomUUID();
  const client = request(app.origin + "/api/companies", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${app.token}`,
      Expect: "100-continue",
      "Content-Length": "100",
      "Idempotency-Key": key,
    },
  });
  client.on("error", () => {});
  try {
    const started = once(client, "continue");
    client.flushHeaders();
    await started;
    client.write("{");
    await app.close();
    app = await startServer({ directory, port: 0 });
    assert.equal(app.store.all("companies").length, 0);
    assert.equal(app.store.requestResult(key).state, "missing");
  } finally {
    client.destroy();
    await app.close();
  }
});
