import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexReadiness, readinessCommand } from "../src/readiness.mjs";
import { startServer } from "../src/server.mjs";
import {
  configuredCodex,
  codexSettings,
  saveCodexSettings,
} from "../src/codex.mjs";

test("데스크톱 진단은 Electron을 Node로 실행하지 않고 OS 기본 명령만 고정 호출한다", () => {
  assert.deepEqual(readinessCommand("darwin", {}), [
    "/bin/echo",
    "OTTER_SANDBOX_OK",
  ]);
  assert.deepEqual(readinessCommand("linux", {}), [
    "/bin/echo",
    "OTTER_SANDBOX_OK",
  ]);
  assert.deepEqual(
    readinessCommand("win32", {
      SystemRoot: "C:\\Windows",
      ComSpec: "untrusted.exe",
    }),
    ["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "echo OTTER_SANDBOX_OK"],
  );
  assert.throws(() => readinessCommand("win32", {}), /시스템 경로/);
  assert.throws(
    () => readinessCommand("win32", { SystemRoot: "relative" }),
    /시스템 경로/,
  );
});

function provider(options = {}) {
  const calls = [];
  const client = new EventEmitter();
  client.initialize = async () => {
    calls.push("initialize");
    if (options.missing) throw new Error("secret-install-path");
  };
  client.refuse = (id) => calls.push(["refuse", id]);
  client.request = async (method, params) => {
    calls.push(method);
    if (method === "account/read") {
      assert.equal(params.refreshToken, false);
      if (options.accountError) throw new Error("secret-account-error");
      return (
        options.account || {
          account: { type: "chatgpt", email: "secret-email" },
          requiresOpenaiAuth: true,
        }
      );
    }
    assert.equal(
      method,
      "command/exec",
      "모델 턴·로그인·설정 변경은 호출하지 않는다",
    );
    assert.deepEqual(params.command, readinessCommand());
    assert.deepEqual(params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [params.cwd],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    });
    client.emit("request", { id: "approval" });
    options.started?.();
    if (options.wait) await options.wait;
    if (options.commandError) throw new Error("secret-command-error");
    return (
      options.result || {
        exitCode: 0,
        stdout: "OTTER_SANDBOX_OK",
        stderr: "secret-stderr",
      }
    );
  };
  client.close = async () => {
    calls.push("close");
    if (options.closeError) throw new Error("secret-close-error");
  };
  return { client, calls };
}

test("실행 준비 검사는 설정과 실행을 구분하며 모델·자격 증명·원시 오류를 노출하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-readiness-test-"));
  for (const [options, expected] of [
    [{}, ["passed", "passed", "passed"]],
    [
      { result: { exitCode: 0, stdout: "OTTER_SANDBOX_OK\r\n" } },
      ["passed", "passed", "passed"],
    ],
    [{ missing: true }, ["failed", "unknown", "unknown"]],
    [
      { account: { account: null, requiresOpenaiAuth: true } },
      ["passed", "failed", "passed"],
    ],
    [
      { account: { account: null, requiresOpenaiAuth: false } },
      ["passed", "unknown", "passed"],
    ],
    [
      { account: { account: { type: "apiKey" }, requiresOpenaiAuth: true } },
      ["passed", "passed", "passed"],
    ],
    [
      { accountError: true, commandError: true },
      ["passed", "unknown", "failed"],
    ],
    [
      {
        result: {
          exitCode: 1,
          stdout: "secret-output",
          stderr:
            "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted secret",
        },
      },
      ["passed", "passed", "failed"],
    ],
    [
      { result: { exitCode: 0, stdout: "wrong output" } },
      ["passed", "passed", "failed"],
    ],
  ]) {
    const { client, calls } = provider(options);
    const service = new CodexReadiness(directory, () => client);
    const result = await service.check();
    assert.deepEqual(
      result.checks.map((item) => item.status),
      expected,
    );
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.equal(calls.at(-1), "close");
    if (!options.missing)
      assert.ok(
        calls.some((item) => Array.isArray(item) && item[0] === "refuse"),
      );
    await service.close();
  }
  assert.deepEqual(await readdir(directory), []);
});

test("동시 검사를 합치고 종료 미확인 시 새 프로세스를 만들지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-readiness-close-"));
  let release;
  const options = {
    wait: new Promise((resolve) => {
      release = resolve;
    }),
    closeError: true,
  };
  const { client, calls } = provider(options);
  let spawned = 0;
  const service = new CodexReadiness(directory, () => {
    spawned++;
    return client;
  });
  const pending = service.check();
  assert.equal(service.check(), pending);
  release();
  await assert.rejects(pending, /종료를 확인하지 못했습니다/);
  await assert.rejects(service.check(), /종료를 확인하지 못했습니다/);
  assert.equal(spawned, 1);
  assert.equal(calls.filter((item) => item === "command/exec").length, 1);
  options.closeError = false;
  await service.close();
});

test("인증된 환경별 진단은 원격에 전달하고 변경 접수나 로컬 대체 실행을 만들지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-readiness-http-"));
  let localCalls = 0;
  let remoteCalls = 0;
  let remoteExecutable;
  const local = await startServer({
    directory: join(directory, "local"),
    port: 0,
    makeCodex: () => {
      localCalls++;
      return provider().client;
    },
  });
  const remote = await startServer({
    directory: join(directory, "remote"),
    port: 0,
    headless: true,
    controllerId: randomUUID(),
    slots: 1,
    makeCodex: (options) => {
      remoteCalls++;
      remoteExecutable = options.command;
      return provider({ missing: true }).client;
    },
  });
  try {
    const environment = local.environments.add({
      name: "SSH 진단",
      kind: "ssh",
      host: "test.invalid",
      slots: 1,
    });
    const workerId = remote.store.metadata("workerId");
    local.store.update("environments", environment.id, { workerId });
    local.environments.clients.set(environment.id, {
      health: { workerId },
      disconnect() {},
      async request(method, path, input, key) {
        const response = await fetch(remote.origin + path, {
          method,
          headers: {
            Authorization: `Bearer ${remote.token}`,
            "Content-Type": "application/json",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: JSON.stringify(input),
        });
        return { status: response.status, data: await response.json() };
      },
    });
    const request = (target, authenticated = true) =>
      fetch(local.origin + "/api/codex-check", {
        method: "POST",
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${local.token}` } : {}),
          "X-Otter-Environment": target,
          "Idempotency-Key": "diagnostic-only",
        },
        body: JSON.stringify({ command: ["NEVER_EXECUTE"] }),
      });
    assert.equal((await request("local", false)).status, 401);
    assert.equal(localCalls, 0);
    const settingsPath = local.origin + "/api/codex-settings";
    const settingsHeaders = {
      Authorization: `Bearer ${local.token}`,
      "X-Otter-Environment": environment.id,
    };
    assert.deepEqual(
      await (await fetch(settingsPath, { headers: settingsHeaders })).json(),
      { path: "", revision: null },
    );
    const changed = await fetch(settingsPath, {
      method: "POST",
      headers: { ...settingsHeaders, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        path: process.execPath,
        revision: null,
        confirm: true,
      }),
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).path, await realpath(process.execPath));
    assert.equal(codexSettings(local.store).path, "");
    assert.equal(remoteCalls, 0, "저장만으로 실행하지 않는다");
    const remoteResult = await request(environment.id);
    assert.equal(remoteResult.status, 200);
    assert.equal((await remoteResult.json()).checks[0].status, "failed");
    assert.equal(localCalls, 0);
    assert.equal(remoteCalls, 1);
    assert.equal(remoteExecutable, await realpath(process.execPath));
    const localResult = await request("local");
    assert.equal(localResult.status, 200);
    assert.equal((await localResult.json()).checks[0].status, "passed");
    assert.equal(localCalls, 1);
    local.environments.clients.delete(environment.id);
    assert.equal((await request(environment.id)).status, 503);
    assert.equal(localCalls, 1);
    for (const app of [local, remote]) {
      assert.equal(app.store.requestResult("diagnostic-only").state, "missing");
      assert.equal(app.store.all("tasks").length, 0);
      assert.equal(app.store.all("reports").length, 0);
    }
  } finally {
    await local.close();
    await remote.close();
  }
});

test("Codex 실행 파일은 동의·절대 경로·현재 설정을 검사하고 진단/업무와 재시작에 같은 경로를 쓴다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-codex-settings-"));
  const commands = [];
  let release;
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    directory,
    port: 0,
    makeCodex: (input) => {
      commands.push(input.command);
      return provider({ wait, started: began }).client;
    },
  };
  let app = await startServer(options);
  const request = (input, path = "codex-settings") =>
    fetch(app.origin + "/api/" + path, {
      ...(input === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(input) }),
      headers: { Authorization: `Bearer ${app.token}` },
    });
  try {
    assert.equal((await fetch(app.origin + "/api/codex-settings")).status, 401);
    assert.deepEqual(await (await request()).json(), {
      path: "",
      revision: null,
    });
    for (const input of [
      { path: process.execPath, confirm: false },
      { path: "relative" },
      { path: directory },
      { path: process.execPath + "\n--bad" },
    ])
      assert.equal(
        (await request({ revision: null, confirm: true, ...input })).status,
        400,
      );
    const saved = await (
      await request({ path: process.execPath, revision: null, confirm: true })
    ).json();
    assert.equal(saved.path, await realpath(process.execPath));
    assert.equal(commands.length, 0);
    assert.equal(
      (await request({ path: "", revision: null, confirm: true })).status,
      409,
    );
    app.runner.active.set("test", {});
    assert.equal(
      (await request({ path: "", revision: saved.revision, confirm: true }))
        .status,
      409,
    );
    app.runner.active.delete("test");
    let checked = 0;
    await assert.rejects(
      saveCodexSettings(
        app.store,
        { path: process.execPath, revision: saved.revision, confirm: true },
        () => ++checked > 1,
      ),
      /진행 중/,
    );
    assert.deepEqual(codexSettings(app.store), saved);
    const diagnostic = request({}, "codex-check");
    await started;
    assert.equal(
      (await request({ path: "", revision: saved.revision, confirm: true }))
        .status,
      409,
    );
    release();
    assert.equal((await diagnostic).status, 200);
    assert.equal(commands.at(-1), saved.path);
    // 주입 제공자 검사와 별개로 지정한 실제 실행 파일을 고정 Node 명령으로 시작/종료한다.
    const client = configuredCodex(app.store, {
      cwd: directory,
      args: ["-e", "process.stdin.resume()"],
    });
    try {
      await once(client.process, "spawn");
      assert.equal(client.process.spawnfile, saved.path);
    } finally {
      await client.close();
    }
    app.runner.makeCodex({ cwd: directory });
    assert.equal(commands.at(-1), saved.path);
    await app.close();
    app = await startServer(options);
    assert.deepEqual(await (await request()).json(), saved);
    const reset = await request({
      path: "",
      revision: saved.revision,
      confirm: true,
    });
    assert.equal(reset.status, 200);
    app.runner.makeCodex({ cwd: directory });
    assert.equal(commands.at(-1), "codex");
  } finally {
    release();
    app.runner.active.delete("test");
    await app.close();
  }
});

test("앱 종료는 진행 중 진단의 응답과 프로세스 종료 확인을 기다린다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-readiness-drain-"));
  let release;
  let started;
  const executing = new Promise((resolve) => {
    started = resolve;
  });
  const { client, calls } = provider({
    started,
    wait: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const app = await startServer({
    directory,
    port: 0,
    makeCodex: () => client,
  });
  let closing;
  try {
    const headers = { Authorization: `Bearer ${app.token}` };
    const response = fetch(app.origin + "/api/codex-check", {
      method: "POST",
      headers,
      body: "{}",
    });
    await executing;
    closing = app.close();
    assert.equal(
      (
        await fetch(app.origin + "/api/codex-check", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      503,
    );
    assert.equal(calls.includes("close"), false);
    release();
    assert.equal((await response).status, 200);
    await closing;
    assert.equal(calls.at(-1), "close");
    assert.ok(!(await readdir(directory)).includes("worker.lock"));
  } finally {
    release();
    await closing;
    await app.close();
  }
});
