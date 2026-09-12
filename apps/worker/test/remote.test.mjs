import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  Remote,
  workerBundle,
  environmentInput,
  connectionCommand,
} from "../src/remote.mjs";
import { startServer } from "../src/server.mjs";
import { git } from "../src/git.mjs";

const bootstrap = new URL("../src/remote-bootstrap.mjs", import.meta.url);
// Only the SSH transport is replaced here. The installed worker, private connection file,
// HTTP authorization, SQLite, Git and independent daemon process are real.
const launch = (_command, _args, options) =>
  spawn(process.execPath, [bootstrap.pathname], options);
const config = (directory) =>
  environmentInput({
    name: "격리 실행부",
    kind: "ssh",
    host: "test.invalid",
    directory,
    slots: 1,
  });
test("원격 관리: 사전 접속 실패는 미예약, 이전 버전 중단/예약 반환/설정 수정/같은 DB 재시작", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-lifecycle-"));
  let failProbe = true;
  const gateway = await startServer({
    directory: join(root, "local"),
    port: 0,
    makeRemote: (environment) =>
      new Remote(environment, {
        launch: (command, args, options) =>
          failProbe
            ? spawn("/nonexistent/otter-ssh-test", [], options)
            : launch(command, args, options),
        timeout: 15000,
      }),
  });
  const manager = gateway.environments;
  const environment = manager.add(config(join(root, "remote")));
  let old;
  try {
    assert.equal(manager.reserved(), 0);
    await assert.rejects(manager.connect(environment.id), /연결 명령/);
    assert.equal(manager.reserved(), 0);
    let current = gateway.store.get("environments", environment.id);
    manager.edit(environment.id, { ...current, host: "corrected.invalid" });
    failProbe = false;
    const startId = randomUUID();
    old = spawn(
      process.execPath,
      [
        new URL("../src/headless.mjs", import.meta.url).pathname,
        environment.directory,
        "previous-version",
        manager.controllerId,
        "1",
        startId,
      ],
      { stdio: "ignore" },
    );
    await until(async () => {
      try {
        return (
          JSON.parse(
            await readFile(
              join(environment.directory, "connection.json"),
              "utf8",
            ),
          ).pid === old.pid
        );
      } catch {
        return false;
      }
    });
    await assert.rejects(manager.connect(environment.id), /다른 버전/);
    assert.equal(
      manager.reserved(),
      1,
      "기존 실행부가 살아 있으면 예약을 유지한다",
    );
    assert.equal(old.exitCode, null);
    current = gateway.store.get("environments", environment.id);
    assert.throws(
      () => manager.edit(environment.id, { ...current, slots: 2 }),
      /안전하게 중단/,
    );
    const exited = once(old, "exit");
    await manager.stop(environment.id);
    await exited;
    assert.equal(manager.reserved(), 0);
    const identity = gateway.store.get("environments", environment.id).workerId;
    current = gateway.store.get("environments", environment.id);
    manager.edit(environment.id, { ...current, slots: 2, name: "변경한 환경" });
    assert.throws(
      () =>
        manager.edit(environment.id, {
          ...current,
          directory: join(root, "other"),
        }),
      /새 환경/,
    );
    await manager.connect(environment.id);
    assert.equal(manager.reserved(), 2);
    assert.equal(gateway.runner.capacity(), 0);
    assert.equal(
      manager.client(environment.id).health.workerId,
      identity,
      "업데이트 후 같은 DB/실행부 정체성을 유지한다",
    );
    failProbe = true;
    await assert.rejects(manager.stop(environment.id), /연결 명령/);
    assert.equal(
      manager.reserved(),
      2,
      "종료 응답을 확인하지 못하면 예약을 반환하지 않는다",
    );
    failProbe = false;
    await manager.stop(environment.id);
    assert.equal(manager.reserved(), 0);
    gateway.store.update("environments", environment.id, { allocated: true });
    await until(async () => {
      const marker = JSON.parse(
        await readFile(join(environment.directory, "stopped.json"), "utf8"),
      );
      try {
        process.kill(marker.pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    });
    await manager.stop(environment.id);
    assert.equal(
      manager.reserved(),
      0,
      "응답 유실 이후에도 종료 기록과 프로세스 종료를 대조해서 예약을 반환한다",
    );
  } finally {
    failProbe = false;
    if (manager.reserved()) await manager.stop(environment.id).catch(() => {});
    await gateway.close();
    if (old && old.exitCode === null && old.signalCode === null) {
      old.kill();
      await once(old, "exit");
    }
  }
});
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("조건 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("연결 인자 검증: 호스트 명령 삽입 차단, 호스트 키 필수, WSL 인자 분리", () => {
  assert.throws(() =>
    environmentInput({ name: "x", kind: "ssh", host: "-oProxyCommand=bad" }),
  );
  assert.throws(() =>
    environmentInput({
      name: "x",
      kind: "ssh",
      host: "x; touch /tmp/unwanted",
    }),
  );
  const [command, args] = connectionCommand(
    config("/tmp/path with quotes' safely"),
    'console.log("hello")',
  );
  assert.equal(command, "ssh");
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("ForwardAgent=no"));
  const wsl = environmentInput({
    name: "WSL",
    kind: "wsl",
    distribution: "Ubuntu-24.04",
  });
  assert.throws(() => connectionCommand(wsl, "", "linux"), /Windows/);
  assert.deepEqual(connectionCommand(wsl, "", "win32")[1].slice(0, 5), [
    "--distribution",
    "Ubuntu-24.04",
    "--exec",
    "/bin/sh",
    "-lc",
  ]);
});

test("별도 설치 실행부: 연결 해제 후 같은 PID 재연결, 재전송 중복 방지, 인증 토큰 미노출", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-remote-daemon-"));
  const controller = randomUUID();
  const remote = new Remote(config(directory), { launch, timeout: 15000 });
  let pid;
  try {
    const health = await remote.connect(controller);
    assert.equal(health.settings.concurrency, 1);
    assert.equal(health.token, undefined);
    const metadata = JSON.parse(
      await readFile(join(directory, "connection.json"), "utf8"),
    );
    pid = metadata.pid;
    assert.notEqual(pid, process.pid);
    assert.equal((await fetch(metadata.origin + "/")).status, 401);
    assert.equal(
      (
        await fetch(metadata.origin + "/api/health", {
          headers: { Cookie: "otter_session=" + metadata.token },
        })
      ).status,
      401,
    );
    const key = randomUUID();
    const request = { name: "원격 회사", mode: "group" };
    const first = await remote.request("POST", "/api/companies", request, key);
    assert.equal(first.status, 201);
    remote.disconnect();
    process.kill(pid, 0);
    await remote.connect(controller);
    assert.equal(
      JSON.parse(await readFile(join(directory, "connection.json"), "utf8"))
        .pid,
      pid,
    );
    const replay = await remote.request("POST", "/api/companies", request, key);
    assert.deepEqual(replay, first);
    assert.equal(
      (
        await remote.request(
          "POST",
          "/api/companies",
          { ...request, name: "changed" },
          key,
        )
      ).status,
      409,
    );
    assert.equal(
      (await remote.request("GET", "/api/state")).data.companies.length,
      1,
    );
    const other = new Remote(config(directory), { launch, timeout: 15000 });
    await assert.rejects(other.connect(randomUUID()), /다른 소유권/);
    other.disconnect();
    assert.equal(
      (await remote.request("POST", "/api/shutdown", {})).status,
      200,
    );
    await until(async () => {
      try {
        await readFile(join(directory, "worker.lock"));
        return false;
      } catch (error) {
        return error.code === "ENOENT";
      }
    });
  } finally {
    remote.disconnect();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});

class ControlledCodex extends EventEmitter {
  async initialize() {}
  async request(method) {
    if (method === "command/exec")
      return { exitCode: 0, stdout: "합성 원격 검증", stderr: "" };
    if (method === "thread/start")
      return { thread: { id: "synthetic-thread" } };
    if (method === "turn/start") {
      this.started = true;
      return { turn: { id: "synthetic-turn" } };
    }
  }
  close() {}
  complete() {
    this.emit("notification", {
      method: "item/completed",
      params: {
        item: { type: "agentMessage", text: "합성 실행: 연결 해제 후 보고" },
      },
    });
    this.emit("notification", {
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
  }
}

test("게이트웨이 원격 배정·격리·오프라인 캐시와 실행 유지, 재전송 업무 한 개", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-remote-gateway-"));
  const directory = join(root, "remote");
  const clients = [];
  const gateway = await startServer({
    directory: join(root, "local"),
    port: 0,
    makeRemote: (environment) =>
      new Remote(environment, { launch, timeout: 15000 }),
  });
  const bundle = await workerBundle();
  const daemon = await startServer({
    directory,
    port: 0,
    headless: true,
    workerVersion: bundle.version,
    controllerId: gateway.environments.controllerId,
    slots: 1,
    makeCodex: () => {
      const client = new ControlledCodex();
      clients.push(client);
      return client;
    },
  });
  await writeFile(
    join(directory, "connection.json"),
    JSON.stringify({
      pid: process.pid,
      origin: daemon.origin,
      token: daemon.token,
      workerVersion: bundle.version,
    }),
    { mode: 0o600 },
  );
  const request = async (
    path,
    data,
    environment = "local",
    key = randomUUID(),
  ) => {
    const response = await fetch(gateway.origin + "/api/" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + gateway.token,
        "X-Otter-Environment": environment,
        "Idempotency-Key": key,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const environment = (await request("environments", config(directory))).data;
    assert.equal(
      gateway.runner.capacity(),
      2,
      "등록만으로 실행 자리를 예약하지 않는다",
    );
    assert.equal(
      (await request("environments/" + environment.id + "/connect", {})).status,
      200,
    );
    assert.equal(gateway.runner.capacity(), 1);
    const company = (
      await request("companies", { name: "공통 회사", mode: "group" })
    ).data;
    const employee = (
      await request("employees", {
        name: "김코딩",
        role: "개발",
        instructions: "재사용할 지침",
      })
    ).data;
    const project = (
      await request(
        "projects",
        {
          companyId: company.id,
          create: true,
          parent: root,
          folder: "remote-project",
        },
        environment.id,
      )
    ).data;
    assert.equal(gateway.store.all("projects").length, 0);
    assert.equal(daemon.store.all("projects").length, 1);
    const assignment = (
      await request(
        "assignments",
        { projectId: project.id, employeeId: employee.id },
        environment.id,
      )
    ).data;
    assert.equal(assignment.settings.instructions, "재사용할 지침");
    const policyInput = {
      revision: project.revision,
      completion: "manual",
      checks: [
        {
          name: "원격 결과 검사",
          command: ["git", "rev-parse", "HEAD"],
          timeoutSeconds: 5,
        },
      ],
      confirm: true,
    };
    const policyKey = randomUUID();
    const policy = await request(
      `projects/${project.id}/completion`,
      policyInput,
      environment.id,
      policyKey,
    );
    assert.equal(policy.status, 200);
    assert.deepEqual(
      await request(
        `projects/${project.id}/completion`,
        policyInput,
        environment.id,
        policyKey,
      ),
      policy,
    );
    const prompt = {
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "합성 원격 업무",
    };
    const key = randomUUID();
    gateway.store.settings({ retries: 1 });
    const task = await request("tasks", prompt, environment.id, key);
    assert.equal(task.data.maxRetries, 1);
    assert.deepEqual(task.data.checks, policyInput.checks);
    assert.equal(daemon.store.settings().retries, 1);
    assert.equal(daemon.store.settings().concurrency, environment.slots);
    assert.equal(task.status, 201);
    await until(() => clients[0]?.started);
    const online = (await request("state?projectId=" + project.id)).data;
    assert.equal(online.projects[0].environmentId, environment.id);
    assert.equal(online.tasks[0].status, "running");
    const editorPath = `editor?projectId=${project.id}&taskId=${task.data.id}&sshHost=fixture-dev`;
    const editor = await request(editorPath, undefined, environment.id);
    assert.equal(editor.status, 200);
    assert.equal(
      editor.data.path,
      daemon.store.get("tasks", task.data.id).worktree.path,
    );
    assert.equal(editor.data.active, true);
    assert.deepEqual(editor.data.args, [
      "--new-window",
      "--remote",
      "ssh-remote+fixture-dev",
      editor.data.path,
    ]);
    assert.equal(
      (await request(editorPath)).status,
      404,
      "원격 경로를 로컬 프로젝트로 대체하지 않는다",
    );
    await request("environments/" + environment.id + "/disconnect", {});
    assert.equal(
      (await request(editorPath, undefined, environment.id)).status,
      503,
      "연결이 없으면 원격 경로 확인을 성공으로 표시하지 않는다",
    );
    const offline = (await request("state?projectId=" + project.id)).data;
    assert.ok(offline.connectionError);
    assert.equal(offline.tasks[0].status, "running");
    assert.equal(gateway.runner.capacity(), 1);
    assert.equal((await request("settings", { concurrency: 1 })).status, 200);
    assert.equal(gateway.runner.capacity(), 0);
    const extra = await request("environments", {
      ...config(join(root, "extra")),
      name: "초과",
    });
    assert.equal(extra.status, 201);
    assert.equal(
      (await request("environments/" + extra.data.id + "/connect", {})).status,
      400,
    );
    await writeFile(
      join(
        daemon.store.get("tasks", task.data.id).worktree.path,
        "remote-result.txt",
      ),
      "원격 직원 결과",
    );
    clients[0].complete();
    await until(
      () => daemon.store.get("tasks", task.data.id).status === "review",
    );
    await request("environments/" + environment.id + "/connect", {});
    assert.deepEqual(await request("tasks", prompt, environment.id, key), task);
    const restored = (await request("state?projectId=" + project.id)).data;
    assert.equal(restored.tasks.length, 1);
    assert.equal(restored.tasks[0].status, "review");
    assert.equal(restored.tasks[0].verification.status, "passed");
    assert.equal(gateway.store.all("tasks").length, 0);
    assert.equal(restored.reports.length, 1);
    assert.equal(gateway.store.all("messages").length, 0);
    const mergePath = `tasks/${task.data.id}/merge`;
    const mergePreview = await request(mergePath, undefined, environment.id);
    assert.equal(mergePreview.status, 200, JSON.stringify(mergePreview.data));
    assert.equal(mergePreview.data.path, project.root);
    assert.equal(
      (await request(mergePath)).status,
      404,
      "원격 결과를 로컬로 대체하지 않는다",
    );
    const mergeInput = { confirm: true, approval: mergePreview.data.approval };
    const mergeKey = randomUUID();
    const merged = await request(
      mergePath,
      mergeInput,
      environment.id,
      mergeKey,
    );
    assert.equal(merged.status, 200, JSON.stringify(merged.data));
    assert.equal(merged.data.alreadyMerged, false);
    assert.equal(
      await readFile(join(project.root, "remote-result.txt"), "utf8"),
      "원격 직원 결과",
    );
    assert.deepEqual(
      await request(mergePath, mergeInput, environment.id, mergeKey),
      merged,
    );
    assert.equal(gateway.store.all("tasks").length, 0);
    const pushRepository = join(root, "published.git");
    await git(root, ["init", "--bare", pushRepository]);
    await git(project.root, ["remote", "add", "origin", pushRepository]);
    const pushPath = `projects/${project.id}/push`;
    const pushPreview = await request(
      pushPath + "?remote=origin&branch=main",
      undefined,
      environment.id,
    );
    assert.equal(pushPreview.status, 200, JSON.stringify(pushPreview.data));
    assert.equal((await request(pushPath)).status, 404);
    const pushed = await request(
      pushPath,
      {
        remote: "origin",
        branch: "main",
        approval: pushPreview.data.approval,
        confirm: true,
        confirmAutomation: true,
      },
      environment.id,
    );
    assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
    assert.equal(
      await git(pushRepository, ["rev-parse", "refs/heads/main"]),
      pushed.data.commit,
    );
    assert.equal(gateway.store.all("reports").length, 0);
    const pushedRecord = daemon.store.get("projects", project.id).push;
    daemon.store.update("projects", project.id, {
      push: { ...pushedRecord, status: "unconfirmed" },
    });
    const recoveryPath = `projects/${project.id}/push-recovery`;
    const recovery = await request(recoveryPath, undefined, environment.id);
    assert.equal(recovery.status, 200, JSON.stringify(recovery.data));
    assert.equal(recovery.data.outcome, "applied");
    assert.equal((await request(recoveryPath)).status, 404);
    const recovered = await request(
      recoveryPath,
      { confirm: true, approval: recovery.data.approval },
      environment.id,
    );
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    assert.equal(recovered.data.status, "pushed");
    assert.equal(
      await git(pushRepository, ["rev-parse", "refs/heads/main"]),
      pushed.data.commit,
    );
    const automationPath = `projects/${project.id}/automation`;
    const autoInput = {
      merge: "auto",
      push: "auto",
      remote: "origin",
      branch: "main",
      deploy: "auto",
      deployment: {
        name: "원격 자동 배포",
        command: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync(process.argv[1],process.cwd()+'\\n')",
          join(root, "remote-auto-deployment"),
        ],
        timeoutSeconds: 5,
      },
    };
    const autoPreview = await request(
      automationPath + "-preview",
      autoInput,
      environment.id,
    );
    assert.equal(autoPreview.status, 200);
    assert.equal(
      (await request(automationPath + "-preview", autoInput)).status,
      404,
    );
    const autoKey = randomUUID();
    const autoBody = {
      ...autoInput,
      approval: autoPreview.data.approval,
      confirm: true,
      confirmRemote: true,
      confirmDeployment: true,
    };
    const configured = await request(
      automationPath,
      autoBody,
      environment.id,
      autoKey,
    );
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    assert.deepEqual(
      await request(automationPath, autoBody, environment.id, autoKey),
      configured,
    );
    const nextClient = clients.length;
    const autoTask = await request(
      "tasks",
      { ...prompt, prompt: "원격 자동 반영 검사" },
      environment.id,
    );
    assert.equal(autoTask.status, 201);
    assert.equal(
      autoTask.data.automationPolicyId,
      configured.data.automation.id,
    );
    await until(() => clients[nextClient]?.started);
    await writeFile(
      join(
        daemon.store.get("tasks", autoTask.data.id).worktree.path,
        "auto-remote.txt",
      ),
      "자동 반영",
    );
    clients[nextClient].complete();
    await until(
      () => daemon.store.get("tasks", autoTask.data.id).status === "review",
    );
    assert.equal(
      (
        await request(
          `tasks/${autoTask.data.id}/accept`,
          {
            revision: daemon.store.get("tasks", autoTask.data.id).revision,
            confirm: true,
          },
          environment.id,
        )
      ).status,
      200,
    );
    await until(
      () =>
        daemon.store.get("tasks", autoTask.data.id).automation?.status ===
        "done",
    );
    assert.equal(
      await readFile(join(project.root, "auto-remote.txt"), "utf8"),
      "자동 반영",
    );
    assert.equal(
      await git(pushRepository, ["rev-parse", "refs/heads/main"]),
      daemon.store.get("tasks", autoTask.data.id).merge.commit,
    );
    assert.equal(gateway.store.all("tasks").length, 0);
    assert.equal(gateway.store.all("reports").length, 0);
    await until(() => daemon.automation.running.size === 0);
    assert.equal(
      await readFile(join(root, "remote-auto-deployment"), "utf8"),
      project.root + "\n",
    );
    assert.equal(
      daemon.store.get("projects", project.id).deployment.policyId,
      configured.data.automation.id,
    );
    const deployInput = {
      name: "원격 배포 명령 검사",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], process.cwd() + '\\n')",
        join(root, "remote-deployment"),
      ],
      timeoutSeconds: 5,
    };
    const deployPreviewPath = `projects/${project.id}/deployment-preview`;
    assert.equal((await request(deployPreviewPath, deployInput)).status, 404);
    const deployPreview = await request(
      deployPreviewPath,
      deployInput,
      environment.id,
    );
    assert.equal(deployPreview.status, 200, JSON.stringify(deployPreview));
    const deployPath = `projects/${project.id}/deploy`;
    const deployKey = randomUUID();
    const deployApproval = {
      ...deployPreview.data,
      confirm: true,
      confirmAccess: true,
      confirmRepeat: true,
    };
    const deployed = await request(
      deployPath,
      deployApproval,
      environment.id,
      deployKey,
    );
    assert.equal(deployed.status, 200, JSON.stringify(deployed));
    await until(
      () =>
        daemon.store.get("projects", project.id).deployment?.status ===
        "succeeded",
    );
    assert.deepEqual(
      await request(deployPath, deployApproval, environment.id, deployKey),
      deployed,
    );
    assert.equal(
      await readFile(join(root, "remote-deployment"), "utf8"),
      project.root + "\n",
    );
    assert.equal(gateway.store.all("projects").length, 0);
    assert.equal(gateway.store.all("reports").length, 0);
    const single = (
      await request("companies", { name: "단일 프로젝트 회사", mode: "single" })
    ).data;
    const singleKey = randomUUID();
    const singleInput = {
      companyId: single.id,
      create: true,
      parent: root,
      folder: "single-remote",
    };
    const singleProject = await request(
      "projects",
      singleInput,
      environment.id,
      singleKey,
    );
    assert.equal(singleProject.status, 201);
    assert.deepEqual(
      await request("projects", singleInput, environment.id, singleKey),
      singleProject,
    );
    assert.equal(
      (await request("projects", { ...singleInput, folder: "illegal-local" }))
        .status,
      409,
    );
    assert.equal(
      (
        await request(
          "projects",
          { ...singleInput, folder: "changed" },
          environment.id,
          singleKey,
        )
      ).status,
      409,
    );
    const keyConnect = randomUUID();
    await request(
      "environments/" + environment.id + "/connect",
      {},
      "local",
      keyConnect,
    );
    await request("environments/" + environment.id + "/disconnect", {});
    await request(
      "environments/" + environment.id + "/connect",
      {},
      "local",
      keyConnect,
    );
    assert.equal(
      gateway.environments.list()[0].connected,
      true,
      "연결 명령 재시도는 오래된 응답을 재생하지 않는다",
    );
  } finally {
    await gateway.close();
    await daemon.close();
  }
});
