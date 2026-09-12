import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import { git, checkpoint, isolatedWorktree } from "../src/git.mjs";
import { ResultMerge } from "../src/merge.mjs";
import { ProjectPush } from "../src/push.mjs";
import { GitRecovery } from "../src/git-recovery.mjs";

test("실제 병합 결과를 재시작 후 기록만 복원하며 실행 존재·증거 부족·오래된 승인은 유지한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-git-recovery-"));
  const directory = join(root, "worker");
  const makeCodex = () => {
    throw new Error("이 검사는 모델을 실행하지 않습니다.");
  };
  let app = await startServer({ directory, port: 0, makeCodex });
  const pump = Object.getPrototypeOf(app.runner).pump;
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "결과 복구", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: root,
      folder: "원본",
    });
    const employee = company.createEmployee({
      name: "직원",
      role: "개발",
      instructions: "개발",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "결과",
    });
    const worktree = await isolatedWorktree(
      project.root,
      join(root, "작업"),
      task.id,
    );
    await writeFile(join(worktree.path, "result.txt"), "actual result");
    app.store.update("tasks", task.id, {
      worktree,
      resultCommit: await checkpoint(worktree, "결과"),
      status: "review",
    });
    const merger = new ResultMerge(app.store, app.runner, directory);
    const preview = await merger.preview(task.id);
    await merger.apply(task.id, { confirm: true, approval: preview.approval });
    const record = app.store.get("tasks", task.id).merge;
    assert.equal(record.process.closed, true);
    assert.equal(record.process.code, 0);
    assert.ok(record.process.pid > 0);
    const queued = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "이전에 승인한 대기 업무",
    });
    // 실제 Git 성공 후 최종 기록/응답만 유실된 상태를 재현한다.
    app.store.update("tasks", task.id, {
      merge: { ...record, status: "unconfirmed" },
    });
    pump.call(app.runner);
    assert.equal(app.runner.active.size, 0);
    assert.equal(app.store.get("tasks", queued.id).status, "queued");
    assert.throws(
      () => company.continueTask(task.id, { prompt: "추가 작업" }),
      /미확인 Git/,
    );
    await assert.rejects(
      new ProjectPush(app.store, app.runner).preview(project.id, {
        remote: "origin",
        branch: "main",
      }),
      /미확인 Git/,
    );
    await app.close();
    app = await startServer({ directory, port: 0, makeCodex });
    app.runner.pump = () => {};
    const recovery = new GitRecovery(app.store, app.runner);
    let observed = await recovery.observe("merge", task.id);
    assert.equal(observed.outcome, "applied");
    assert.equal(
      app.store.get("tasks", task.id).merge.status,
      "unconfirmed",
      "조회는 기록을 변경하지 않음",
    );
    await assert.rejects(
      recovery.resolve("merge", task.id, { approval: observed.approval }),
      /승인/,
    );
    await writeFile(join(project.root, "later.txt"), "외부 IDE 후속 변경");
    const after = await checkpoint({ path: project.root }, "이후 커밋");
    await assert.rejects(
      recovery.resolve("merge", task.id, {
        confirm: true,
        approval: observed.approval,
      }),
      /바뀌었습니다/,
    );
    app.store.update("tasks", task.id, {
      merge: {
        ...record,
        status: "unconfirmed",
        process: { pid: process.pid, closed: false },
      },
    });
    observed = await recovery.observe("merge", task.id);
    assert.equal(observed.execution, "running");
    assert.equal(observed.outcome, "unknown");
    await assert.rejects(
      recovery.resolve("merge", task.id, {
        confirm: true,
        approval: observed.approval,
      }),
      /증거가 부족/,
    );
    app.store.update("tasks", task.id, {
      merge: { ...record, status: "unconfirmed", process: undefined },
    });
    assert.equal(
      (await recovery.observe("merge", task.id)).execution,
      "unknown",
    );
    app.store.update("tasks", task.id, {
      merge: {
        ...record,
        status: "unconfirmed",
        process: { pid: record.process.pid, closed: false },
      },
    });
    observed = await recovery.observe("merge", task.id);
    assert.equal(
      observed.execution,
      "closed",
      "종료된 실제 Git PID 부재를 대조",
    );
    assert.equal(
      observed.outcome,
      "applied",
      "후속 커밋이 있어도 병합 이력을 대조",
    );
    app.store.projectLocks.add(project.id);
    await assert.rejects(recovery.observe("merge", task.id), /진행 중/);
    app.store.projectLocks.delete(project.id);
    const path = `${app.origin}/api/tasks/${task.id}/merge-recovery`;
    assert.equal((await fetch(path)).status, 401);
    const headers = {
      Authorization: `Bearer ${app.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    };
    const response = await fetch(path, { headers });
    const confirmation = await response.json();
    assert.equal(response.status, 200);
    const post = () =>
      fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          confirm: true,
          approval: confirmation.approval,
        }),
      });
    const resumed = [];
    app.runner.start = async (next) => {
      resumed.push(next.id);
      app.store.update("tasks", next.id, { status: "review" });
      app.runner.active.delete(next.id);
    };
    app.runner.pump = pump.bind(app.runner);
    const result = await (await post()).json();
    assert.equal(result.status, "merged");
    assert.deepEqual(await (await post()).json(), result);
    assert.deepEqual(
      resumed,
      [queued.id],
      "기존 승인 업무만 복구 후 한 번 재개",
    );
    assert.equal(app.store.all("reports", project.id).length, 2);
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), after);
    assert.equal(
      await readFile(join(project.root, "later.txt"), "utf8"),
      "외부 IDE 후속 변경",
    );
    assert.equal(
      await git(worktree.path, ["rev-parse", "HEAD"]),
      record.resultCommit,
    );
  } finally {
    app.store.projectLocks.clear();
    await app.close();
  }
});

test("원래 푸시 주소의 후속 이력을 가져와 대조하고 미확인 네트워크 실패는 재전송하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-push-recovery-"));
  const app = await startServer({ directory: join(root, "worker"), port: 0 });
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({
      name: "원격 결과 복구",
      mode: "single",
    });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: root,
      folder: "repo",
    });
    const destination = join(root, "original.git"),
      other = join(root, "other.git");
    await git(root, ["init", "--bare", destination]);
    await git(root, ["init", "--bare", other]);
    await git(project.root, ["remote", "add", "origin", destination]);
    await writeFile(join(project.root, "result.txt"), "original result");
    const first = await checkpoint({ path: project.root }, "result");
    const push = new ProjectPush(app.store, app.runner);
    const input = { remote: "origin", branch: "main" };
    const preview = await push.preview(project.id, input);
    await push.apply(project.id, {
      ...input,
      confirm: true,
      confirmAutomation: true,
      approval: preview.approval,
    });
    const record = app.store.get("projects", project.id).push;
    assert.equal(record.process.closed, true);
    app.store.update("projects", project.id, {
      push: { ...record, status: "unconfirmed" },
    });
    const outside = join(root, "outside");
    await git(root, ["clone", "--branch", "main", destination, outside]);
    await writeFile(join(outside, "colleague.txt"), "다른 사람이 추가");
    const second = await checkpoint({ path: outside }, "후속 커밋");
    await git(outside, ["push", "origin", "main"]);
    await git(project.root, ["remote", "set-url", "origin", other]);
    const refs = await git(project.root, ["show-ref"]);
    const fetchHead = join(project.root, ".git", "FETCH_HEAD");
    const beforeFetchHead = await readFile(fetchHead, "utf8").catch(() => null);
    const recovery = new GitRecovery(app.store, app.runner);
    const observed = await recovery.observe("push", project.id);
    assert.equal(observed.outcome, "applied");
    assert.equal(observed.actual, second);
    assert.equal(observed.record.url, destination);
    assert.equal(await git(project.root, ["show-ref"]), refs);
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), first);
    assert.equal(
      await readFile(fetchHead, "utf8").catch(() => null),
      beforeFetchHead,
    );
    await recovery.resolve("push", project.id, {
      confirm: true,
      approval: observed.approval,
    });
    assert.equal(app.store.get("projects", project.id).push.status, "pushed");
    assert.equal(
      await git(destination, ["rev-parse", "refs/heads/main"]),
      second,
    );
    assert.equal(await git(other, ["show-ref"]).catch(() => ""), "");
    app.store.update("projects", project.id, {
      push: { ...record, url: other, status: "unconfirmed", rejected: false },
    });
    const unknown = await recovery.observe("push", project.id);
    assert.equal(
      unknown.outcome,
      "unknown",
      "브랜치 부재만으로 미전송 확정하지 않음",
    );
    await assert.rejects(
      recovery.resolve("push", project.id, {
        confirm: true,
        approval: unknown.approval,
      }),
      /증거가 부족/,
    );
    assert.equal(await git(other, ["show-ref"]).catch(() => ""), "");
  } finally {
    await app.close();
  }
});
