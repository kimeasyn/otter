import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import { isolatedWorktree, checkpoint, git } from "../src/git.mjs";
import { ResultMerge } from "../src/merge.mjs";

test("실제 실행 큐와 별도 검증 명령의 통과만 자동 완료·병합·푸시로 이어진다", async () => {
  const f = await fixture();
  const { app, company, project, assignment } = f;
  const exec = promisify(execFile);
  class Provider extends EventEmitter {
    constructor(cwd) {
      super();
      this.cwd = cwd;
    }
    async initialize() {}
    async request(method, params) {
      if (method.startsWith("thread/"))
        return { thread: { id: "fixture-thread" } };
      if (method === "turn/start") {
        await writeFile(join(this.cwd, "verified.txt"), "verified");
        setImmediate(() =>
          this.emit("notification", {
            method: "turn/completed",
            params: { turn: { id: "fixture-turn", status: "completed" } },
          }),
        );
        return { turn: { id: "fixture-turn" } };
      }
      if (method === "command/exec") {
        assert.equal(params.sandboxPolicy.networkAccess, false);
        // 제공자 대신 제한된 테스트 명령을 실제 실행한다. OS 샌드박스 검증을 대신하지 않는다.
        try {
          return {
            exitCode: 0,
            ...(await exec(params.command[0], params.command.slice(1), {
              cwd: params.cwd,
            })),
          };
        } catch (error) {
          return { exitCode: error.code, stdout: "", stderr: "" };
        }
      }
      return {};
    }
    close() {
      this.closed = true;
    }
    refuse() {}
  }
  app.runner.makeCodex = ({ cwd }) => new Provider(cwd);
  try {
    await f.configure();
    const configureCheck = (script) =>
      company.configureCompletion(project.id, {
        revision: app.store.get("projects", project.id).revision,
        completion: "verified",
        checks: [
          {
            name: "실제 파일 검사",
            command: [process.execPath, "-e", script],
            timeoutSeconds: 10,
          },
        ],
        confirm: true,
      });
    const request = () =>
      company.requestTask({
        projectId: project.id,
        assignmentId: assignment.id,
        prompt: "검증 후 자동 반영",
      });
    configureCheck(
      "require('node:assert/strict').equal(require('node:fs').readFileSync('verified.txt','utf8'),'verified')",
    );
    const passed = request();
    app.runner.pump();
    await until(
      () => app.store.get("tasks", passed.id).automation?.status === "done",
    );
    const result = app.store.get("tasks", passed.id);
    assert.equal(result.status, "completed");
    assert.equal(result.acceptedBy, "verification");
    assert.equal(result.verification.status, "passed");
    const head = await git(f.remote, ["rev-parse", "refs/heads/main"]);
    assert.equal(head, result.merge.commit);
    await until(() => app.automation.running.size === 0);
    configureCheck("process.exit(1)");
    const failed = request();
    app.runner.pump();
    await until(() => app.store.get("tasks", failed.id).status === "blocked");
    assert.equal(
      app.store.get("tasks", failed.id).verification.status,
      "failed",
    );
    assert.equal(app.store.get("tasks", failed.id).automation, undefined);
    assert.equal(await git(f.remote, ["rev-parse", "refs/heads/main"]), head);
  } finally {
    await app.close();
  }
});

async function until(check) {
  for (let n = 0; n < 400; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("자동화 완료 대기 시간 초과");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "otter-automation-"));
  const directory = join(root, "worker");
  const app = await startServer({
    directory,
    port: 0,
    makeCodex: () => {
      throw new Error("모델 실행 금지");
    },
  });
  const company = new Company(app.store);
  const org = company.createCompany({ name: "자동 반영", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: root,
    folder: "original",
  });
  const employee = company.createEmployee({
    name: "개발",
    role: "개발",
    instructions: "검사",
  });
  const assignment = company.assign(project.id, employee.id);
  const remote = join(root, "remote.git");
  await git(root, ["init", "--bare", remote]);
  await git(project.root, ["remote", "add", "origin", remote]);
  const call = async (path, data, key = randomUUID()) => {
    const result = await fetch(app.origin + "/api/" + path, {
      ...(data ? { method: "POST", body: JSON.stringify(data) } : {}),
      headers: {
        Authorization: `Bearer ${app.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
    });
    const value = await result.json();
    const receipt = result.headers.get("X-Otter-Receipt");
    if (receipt && result.status < 500 && !value.pending) {
      const ack = await fetch(
        `${app.origin}/api/request-journal/${receipt}/ack`,
        {
          method: "POST",
          body: "{}",
          headers: { Authorization: `Bearer ${app.token}` },
        },
      );
      assert.equal(ack.status, 200);
    }
    return { status: result.status, data: value };
  };
  const configure = async (merge = "auto", push = "auto", deployment) => {
    const input = {
      merge,
      push,
      remote: "origin",
      branch: "main",
      ...(deployment ? { deploy: "auto", deployment } : {}),
    };
    const preview = deployment
      ? await call(`projects/${project.id}/automation-preview`, input)
      : await call(
          `projects/${project.id}/automation?${new URLSearchParams(input)}`,
        );
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const result = await call(`projects/${project.id}/automation`, {
      ...input,
      approval: preview.data.approval,
      confirm: true,
      confirmRemote: true,
      confirmDeployment: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const task = async (name) => {
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: name,
    });
    const worktree = await isolatedWorktree(
      project.root,
      join(root, task.id),
      task.id,
    );
    await writeFile(join(worktree.path, name), name);
    // 모델 대신 실제 Git 결과를 준비한다. 완료 승인과 자동 반영은 제품 경로로 처리한다.
    const resultCommit = await checkpoint(worktree, name);
    return app.store.update("tasks", task.id, {
      worktree,
      resultCommit,
      status: "review",
    });
  };
  return {
    root,
    directory,
    app,
    project,
    remote,
    task,
    call,
    configure,
    company,
    assignment,
  };
}

test("수동 완료는 확인한 실행 결과만 승인하며 오래된 화면·미확정 실행·동의 누락을 거부한다", async () => {
  const f = await fixture();
  const { app } = f;
  try {
    const original = await f.task("review.txt");
    const path = `tasks/${original.id}/accept`;
    for (const input of [
      {},
      { revision: original.revision },
      { confirm: true },
      { revision: 0, confirm: true },
      { revision: String(original.revision), confirm: true },
    ])
      assert.equal((await f.call(path, input)).status, 400);
    const consent = { revision: original.revision, confirm: true };
    app.runner.active.set(original.id, {});
    assert.throws(() => app.runner.accept(original.id, consent), {
      status: 409,
    });
    app.runner.active.delete(original.id);
    app.runner.stopping = true;
    assert.throws(() => app.runner.accept(original.id, consent), {
      status: 409,
    });
    app.runner.stopping = false;
    let current = app.store.update("tasks", original.id, {
      executionUnconfirmed: true,
    });
    assert.equal(
      (await f.call(path, { ...consent, revision: current.revision })).status,
      409,
    );
    current = app.store.update("tasks", original.id, {
      executionUnconfirmed: false,
      verification: { status: "failed", checks: [] },
    });
    assert.equal((await f.call(path, consent)).status, 409);
    assert.equal(app.store.get("tasks", original.id).status, "review");
    const acceptedKey = randomUUID();
    const acceptedBody = {
      ...consent,
      revision: current.revision,
    };
    const accepted = await f.call(path, acceptedBody, acceptedKey);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.data.acceptedReview, {
      revision: current.revision,
      generation: current.generation || 1,
      resultCommit: current.resultCommit,
    });
    assert.equal(
      accepted.data.verification.status,
      "failed",
      "수동 완료가 검증 실패를 통과로 바꾸지 않는다",
    );
    const next = f.company.continueTask(original.id, {
      prompt: "결과를 보완해 줘",
    });
    assert.equal(next.acceptedReview, null);
    assert.equal(next.acceptedBy, null);
    current = app.store.update("tasks", original.id, {
      status: "review",
      resultCommit: null,
    });
    const replay = await f.call(path, acceptedBody, acceptedKey);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data.acceptedReview, accepted.data.acceptedReview);
    assert.equal(
      app.store.get("tasks", original.id).revision,
      current.revision,
      "응답 유실 재전송은 과거 응답만 복원하며 다음 실행을 완료하지 않는다",
    );
    const stale = await f.call(path, {
      ...consent,
      revision: accepted.data.acceptedReview.revision,
    });
    assert.equal(stale.status, 409);
    assert.match(JSON.stringify(stale.data), /검토 대상이 변경/);
    assert.equal(app.store.get("tasks", original.id).status, "review");
    const latest = await f.call(path, {
      ...consent,
      revision: current.revision,
    });
    assert.equal(latest.status, 200);
    assert.deepEqual(latest.data.acceptedReview, {
      revision: current.revision,
      generation: next.generation,
      resultCommit: null,
    });
    assert.equal(
      (await f.call(path, { ...consent, revision: current.revision })).status,
      409,
    );
    assert.equal(
      await git(f.remote, ["show-ref"]).catch(() => ""),
      "",
      "완료만으로 기본 정책의 원격 푸시를 실행하지 않는다",
    );
  } finally {
    app.runner.active.clear();
    app.runner.stopping = false;
    await app.close();
  }
});

test("명시적으로 설정한 이후 업무만 완료 승인 후 자동 병합·고정 대상 푸시한다", async () => {
  const f = await fixture();
  const { app, project, remote } = f;
  try {
    const old = await f.task("old.txt");
    const base = await git(project.root, ["rev-parse", "HEAD"]);
    const input = {
      merge: "auto",
      push: "auto",
      remote: "origin",
      branch: "main",
    };
    const preview = await app.automation.preview(project.id, input);
    await assert.rejects(
      app.automation.configure(project.id, {
        ...input,
        approval: preview.approval,
      }),
      /확인/,
    );
    app.store.update("projects", project.id, { name: "수정된 이름" });
    await assert.rejects(
      app.automation.configure(project.id, {
        ...input,
        approval: preview.approval,
        confirm: true,
        confirmRemote: true,
      }),
      /확인/,
    );
    const configured = await f.configure();
    assert.equal(configured.automation.destination.url, remote);
    app.runner.accept(old.id, {
      revision: app.store.get("tasks", old.id).revision,
      confirm: true,
    });
    await until(() => app.automation.running.size === 0);
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), base);
    assert.equal(app.store.get("tasks", old.id).automation, undefined);
    const current = await f.task("new.txt");
    app.automation.pump();
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), base);
    assert.equal(
      (
        await f.call(`tasks/${current.id}/accept`, {
          revision: app.store.get("tasks", current.id).revision,
          confirm: true,
        })
      ).status,
      200,
    );
    await until(
      () => app.store.get("tasks", current.id).automation?.status === "done",
    );
    assert.equal(
      await readFile(join(project.root, "new.txt"), "utf8"),
      "new.txt",
    );
    await assert.rejects(readFile(join(project.root, "old.txt")), {
      code: "ENOENT",
    });
    const merged = app.store.get("tasks", current.id).merge;
    assert.equal(merged.policyId, configured.automation.id);
    assert.equal(
      await git(remote, ["rev-parse", "refs/heads/main"]),
      merged.commit,
    );
    assert.equal(
      app.store.get("projects", project.id).push.policyId,
      configured.automation.id,
    );
    const reports = app.store.all("reports").length;
    app.automation.pump();
    await until(() => app.automation.running.size === 0);
    assert.equal(app.store.all("reports").length, reports);
    assert.equal(await git(project.root, ["status", "--porcelain"]), "");
  } finally {
    await app.close();
  }
});

test("새 업무 완료·실제 원본 반영·푸시 뒤 승인한 배포 명령을 실행하고 같은 정책/커밋은 중복 배포하지 않는다", async () => {
  const f = await fixture();
  const { app, project } = f;
  const marker = join(f.root, "deployments");
  try {
    const old = await f.task("old-auto-deploy.txt");
    const command = {
      name: "푸시 이후 배포",
      command: [
        process.execPath,
        "-e",
        `const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'); const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(cp.execFileSync('git',['--git-dir',process.argv[2],'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim(),head);fs.appendFileSync(process.argv[1],head+'\\n');`,
        marker,
        f.remote,
      ],
      timeoutSeconds: 5,
    };
    const input = {
      merge: "auto",
      push: "auto",
      remote: "origin",
      branch: "main",
      deploy: "auto",
      deployment: command,
    };
    const preview = await app.automation.preview(project.id, input);
    await assert.rejects(
      app.automation.configure(project.id, {
        ...input,
        approval: preview.approval,
        confirm: true,
        confirmRemote: true,
      }),
      /확인/,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const configured = await f.configure("auto", "auto", command);
    assert.equal(
      app.store.db
        .prepare(
          "SELECT count(*) AS n FROM request_journal WHERE json_extract(data,'$.path') LIKE '%/automation-preview'",
        )
        .get().n,
      0,
    );
    app.runner.accept(old.id, {
      revision: app.store.get("tasks", old.id).revision,
      confirm: true,
    });
    assert.equal(app.store.get("tasks", old.id).automation, undefined);
    const task = await f.task("deploy-result.txt");
    app.automation.pump();
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    app.runner.accept(task.id, {
      revision: app.store.get("tasks", task.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", task.id).automation?.status === "done" &&
        app.automation.running.size === 0,
    );
    const result = app.store.get("projects", project.id).deployment;
    assert.equal(result.policyId, configured.automation.id);
    assert.equal(result.taskId, task.id);
    assert.equal(result.status, "succeeded");
    assert.equal(await readFile(marker, "utf8"), result.commit + "\n");
    const same = await f.task("deploy-result.txt");
    app.runner.accept(same.id, {
      revision: app.store.get("tasks", same.id).revision,
      confirm: true,
    });
    await until(
      () => app.store.get("tasks", same.id).automation?.status === "done",
    );
    assert.match(
      app.store.get("tasks", same.id).automation.message,
      /다시 실행하지/,
    );
    assert.equal(await readFile(marker, "utf8"), result.commit + "\n");
    assert.equal(
      app.store
        .all("reports", project.id)
        .filter((r) => r.deployment?.policyId === configured.automation.id)
        .length,
      1,
    );
    await until(() => app.automation.running.size === 0);
    await f.configure("approval", "approval", {
      ...command,
      command: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1],'manual\\n')",
        marker,
      ],
    });
    const manual = await f.task("manual-merge-deploy.txt");
    app.runner.accept(manual.id, {
      revision: app.store.get("tasks", manual.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", manual.id).automation?.status ===
          "waiting-merge" && app.automation.running.size === 0,
    );
    assert.equal(await readFile(marker, "utf8"), result.commit + "\n");
    const merger = new ResultMerge(app.store, app.runner, f.directory);
    const mergePreview = await merger.preview(manual.id);
    assert.equal(
      (
        await f.call(`tasks/${manual.id}/merge`, {
          confirm: true,
          approval: mergePreview.approval,
        })
      ).status,
      200,
    );
    await until(
      () =>
        app.store.get("tasks", manual.id).automation?.status === "done" &&
        app.automation.running.size === 0,
    );
    assert.equal(await readFile(marker, "utf8"), result.commit + "\nmanual\n");
    assert.equal(
      await git(f.remote, ["rev-parse", "refs/heads/main"]),
      result.commit,
    );
    await f.configure("auto", "auto", command);
    const failedPush = await f.task("failed-push-deploy.txt");
    await git(project.root, [
      "remote",
      "set-url",
      "origin",
      join(f.root, "different-destination"),
    ]);
    app.runner.accept(failedPush.id, {
      revision: app.store.get("tasks", failedPush.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", failedPush.id).automation?.status === "blocked",
    );
    assert.match(
      app.store.get("tasks", failedPush.id).automation.message,
      /푸시 주소/,
    );
    assert.equal(await readFile(marker, "utf8"), result.commit + "\nmanual\n");
  } finally {
    await app.close();
  }
});

test("자동 배포 실패는 업무 자동화를 막고 실행 직전 해제와 실행 파일 변경은 추가 실행을 차단한다", async () => {
  const f = await fixture();
  const { app, project } = f;
  const marker = join(f.root, "deploy-failed");
  const command = {
    name: "실패 검사",
    command: [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync(process.argv[1],'once\\n');process.exit(1)",
      marker,
    ],
    timeoutSeconds: 5,
  };
  try {
    await f.configure("auto", "approval", command);
    const task = await f.task("deploy-failed.txt");
    app.runner.accept(task.id, {
      revision: app.store.get("tasks", task.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", task.id).automation?.status === "blocked" &&
        app.automation.running.size === 0,
    );
    const failed = app.store.get("projects", project.id);
    assert.equal(failed.deployment.status, "unconfirmed");
    assert.equal(await readFile(marker, "utf8"), "once\n");
    app.deployment.acknowledge(project.id, {
      id: failed.deployment.id,
      revision: failed.revision,
      confirm: true,
      note: "임시 파일 효과와 종료 확인",
    });
    app.automation.pump();
    assert.equal(await readFile(marker, "utf8"), "once\n");
    const revoked = await f.task("deploy-revoked.txt");
    const originalPreview = app.deployment.preview.bind(app.deployment);
    let previewCount = 0;
    app.deployment.preview = async (...args) => {
      const value = await originalPreview(...args);
      if (++previewCount === 2)
        await app.automation.configure(project.id, {
          disable: true,
          revision: app.store.get("projects", project.id).revision,
        });
      return value;
    };
    app.runner.accept(revoked.id, {
      revision: app.store.get("tasks", revoked.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", revoked.id).automation?.status === "blocked" &&
        app.automation.running.size === 0,
    );
    assert.equal(await readFile(marker, "utf8"), "once\n");
    app.deployment.preview = originalPreview;
    const executable = join(f.root, "deployment-tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await f.configure("auto", "approval", {
      ...command,
      command: [executable],
    });
    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    const changed = await f.task("deploy-changed.txt");
    app.runner.accept(changed.id, {
      revision: app.store.get("tasks", changed.id).revision,
      confirm: true,
    });
    await until(
      () => app.store.get("tasks", changed.id).automation?.status === "blocked",
    );
    assert.match(
      app.store.get("tasks", changed.id).automation.message,
      /실행 파일/,
    );
    assert.equal(
      app.store.get("projects", project.id).deployment.id,
      failed.deployment.id,
    );
  } finally {
    await app.close();
  }
});

test("진행 중 자동 배포의 설정을 해제해도 이미 시작한 명령의 기록을 마친 뒤 종료한다", async () => {
  const f = await fixture();
  let app = f.app;
  const marker = join(f.root, "deploy-started");
  const release = join(f.root, "deploy-release");
  let closing;
  try {
    await f.configure("auto", "approval", {
      name: "자동 배포 종료 검사",
      timeoutSeconds: 5,
      command: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'started');setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},10)",
        marker,
        release,
      ],
    });
    const task = await f.task("deploy-shutdown.txt");
    app.runner.accept(task.id, {
      revision: app.store.get("tasks", task.id).revision,
      confirm: true,
    });
    await until(() =>
      readFile(marker).then(
        () => true,
        () => false,
      ),
    );
    assert.equal(app.deployment.running.size, 1);
    await app.automation.configure(f.project.id, {
      disable: true,
      revision: app.store.get("projects", f.project.id).revision,
    });
    closing = app.close();
    assert.ok(app.store.projectLocks.has(f.project.id));
    await writeFile(release, "끝내기");
    await closing;
    closing = undefined;
    app = await startServer({ directory: f.directory, port: 0 });
    assert.equal(app.store.get("projects", f.project.id).automation, null);
    assert.equal(
      app.store.get("projects", f.project.id).deployment.status,
      "succeeded",
    );
    assert.equal(app.store.get("tasks", task.id).automation.status, "done");
  } finally {
    await writeFile(release, "검사 정리");
    await closing?.catch(() => {});
    await app.close();
  }
});

test("수동 병합 대기는 다른 완료 업무의 자동 푸시를 막지 않고 주소 변경과 해제는 추가 전송을 차단한다", async () => {
  const f = await fixture();
  const { app, project, remote } = f;
  try {
    await f.configure("approval", "auto");
    const first = await f.task("first.txt");
    app.runner.accept(first.id, {
      revision: app.store.get("tasks", first.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", first.id).automation?.status ===
          "waiting-merge" && app.automation.running.size === 0,
    );
    const second = await f.task("second.txt");
    app.runner.accept(second.id, {
      revision: app.store.get("tasks", second.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", second.id).automation?.status ===
          "waiting-merge" && app.automation.running.size === 0,
    );
    const merger = new ResultMerge(app.store, app.runner, f.directory);
    const preview = await merger.preview(second.id);
    const result = await f.call(`tasks/${second.id}/merge`, {
      confirm: true,
      approval: preview.approval,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    await until(
      () =>
        app.store.get("tasks", second.id).automation?.status === "done" &&
        app.automation.running.size === 0,
    );
    assert.equal(
      app.store.get("tasks", first.id).automation.status,
      "waiting-merge",
    );
    assert.equal(
      await git(remote, ["rev-parse", "refs/heads/main"]),
      result.data.commit,
    );
    await f.configure();
    const changed = await f.task("changed.txt");
    const other = join(f.root, "other.git");
    await git(f.root, ["init", "--bare", other]);
    await git(project.root, ["remote", "set-url", "origin", other]);
    app.runner.accept(changed.id, {
      revision: app.store.get("tasks", changed.id).revision,
      confirm: true,
    });
    await until(
      () =>
        app.store.get("tasks", changed.id).automation?.status === "blocked" &&
        app.automation.running.size === 0,
    );
    assert.match(
      app.store.get("tasks", changed.id).automation.message,
      /주소가 변경/,
    );
    assert.equal(await git(other, ["show-ref"]).catch(() => ""), "");
    const before = await git(remote, ["rev-parse", "refs/heads/main"]);
    await git(project.root, ["remote", "set-url", "origin", remote]);
    app.automation.pump();
    assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), before);
    const disabled = await f.task("disabled.txt");
    const value = app.store.get("projects", project.id);
    await app.automation.configure(project.id, {
      disable: true,
      revision: value.revision,
    });
    app.runner.accept(disabled.id, {
      revision: app.store.get("tasks", disabled.id).revision,
      confirm: true,
    });
    assert.equal(app.store.get("tasks", disabled.id).automation, undefined);
    assert.equal(await git(remote, ["rev-parse", "refs/heads/main"]), before);
  } finally {
    await app.close();
  }
});

test("실행 직전 정책 철회와 재시작의 미완료 기록은 자동 재실행하지 않는다", async () => {
  const f = await fixture();
  let app = f.app;
  try {
    await f.configure();
    const current = await f.task("revoke.txt");
    const previewMethod = ResultMerge.prototype.preview;
    let revoke = true;
    ResultMerge.prototype.preview = async function (id) {
      const value = await previewMethod.call(this, id);
      if (revoke) {
        revoke = false;
        await app.automation.configure(f.project.id, {
          disable: true,
          revision: app.store.get("projects", f.project.id).revision,
        });
      }
      return value;
    };
    try {
      app.runner.accept(current.id, {
        revision: app.store.get("tasks", current.id).revision,
        confirm: true,
      });
      await until(
        () =>
          app.store.get("tasks", current.id).automation?.status === "blocked",
      );
      await until(() => app.automation.running.size === 0);
    } finally {
      ResultMerge.prototype.preview = previewMethod;
    }
    await assert.rejects(readFile(join(f.project.root, "revoke.txt")), {
      code: "ENOENT",
    });
    assert.equal(await git(f.remote, ["show-ref"]).catch(() => ""), "");
    const configured = await f.configure();
    app.store.update("tasks", current.id, {
      automationPolicyId: configured.automation.id,
      automation: { status: "running" },
    });
    await app.close();
    app = await startServer({ directory: f.directory, port: 0 });
    assert.equal(
      app.store.get("tasks", current.id).automation.status,
      "blocked",
    );
    assert.match(
      app.store.get("tasks", current.id).automation.message,
      /재시작/,
    );
    assert.equal(await git(f.remote, ["show-ref"]).catch(() => ""), "");
  } finally {
    await app.close();
  }
});

test("HTTP 응답 이후 시작한 자동 푸시도 결과 기록까지 기다린 뒤 종료한다", async () => {
  const f = await fixture();
  let app = f.app;
  const marker = join(f.root, "receiver-started");
  const release = join(f.root, "receiver-release");
  let closing;
  try {
    await f.configure();
    const task = await f.task("shutdown.txt");
    // 실제 임시 원격의 수신을 지연한다. 모델이나 외부 계정은 사용하지 않는다.
    await writeFile(
      join(f.remote, "hooks", "pre-receive"),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'received\\n');
setTimeout(() => process.exit(1), 15000);
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
}, 10);
`,
      { mode: 0o700 },
    );
    assert.equal(
      (
        await f.call(`tasks/${task.id}/accept`, {
          revision: app.store.get("tasks", task.id).revision,
          confirm: true,
        })
      ).status,
      200,
    );
    await until(() =>
      readFile(marker).then(
        () => true,
        () => false,
      ),
    );
    assert.equal(app.automation.running.size, 1);
    const executing = app.store.get("projects", f.project.id).push;
    assert.equal(executing.status, "sending");
    process.kill(executing.process.pid, 0);
    closing = app.close();
    assert.equal(app.close(), closing);
    assert.equal(app.store.get("tasks", task.id).automation.status, "running");
    assert.ok(await readFile(join(f.directory, "worker.lock")));
    assert.equal(
      (await f.call("companies", { name: "종료 중", mode: "single" })).status,
      503,
    );
    await writeFile(release, "수신 완료 허용");
    await closing;
    closing = undefined;
    app = await startServer({ directory: f.directory, port: 0 });
    const result = app.store.get("tasks", task.id);
    assert.equal(result.automation.status, "done");
    assert.equal(
      app.store.get("projects", f.project.id).push.process.closed,
      true,
    );
    assert.equal(
      await git(f.remote, ["rev-parse", "refs/heads/main"]),
      result.merge.commit,
    );
    assert.equal(await readFile(marker, "utf8"), "received\n");
    assert.equal(
      app.store
        .all("reports", f.project.id)
        .filter((r) => r.taskId === task.id && r.kind === "automation").length,
      1,
    );
  } finally {
    await writeFile(release, "검사 정리");
    await closing?.catch(() => {});
    await app.close();
  }
});
