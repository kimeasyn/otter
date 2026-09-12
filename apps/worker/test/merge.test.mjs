import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import { git, isolatedWorktree, checkpoint } from "../src/git.mjs";
import { ResultMerge } from "../src/merge.mjs";
import { GitRecovery } from "../src/git-recovery.mjs";

test("원본 반영은 승인한 결과만 병합하며 오래된 승인·미커밋 변경·충돌·중복 요청을 보호한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-merge-"));
  const app = await startServer({
    directory: join(directory, "worker"),
    port: 0,
  });
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "병합 회사", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "원본",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "작업",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "직원 결과",
    });
    const worktree = await isolatedWorktree(
      project.root,
      join(directory, "work"),
      task.id,
    );
    await writeFile(join(worktree.path, "결과.txt"), "직원 결과");
    const resultCommit = await checkpoint(worktree, "직원 결과");
    app.store.update("tasks", task.id, {
      worktree,
      resultCommit,
      status: "review",
    });
    const merge = new ResultMerge(
      app.store,
      app.runner,
      join(directory, "worker"),
    );
    const original = await git(project.root, ["rev-parse", "HEAD"]);
    let preview = await merge.preview(task.id);
    assert.equal(preview.alreadyMerged, false);
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), original);
    await assert.rejects(readFile(join(project.root, "결과.txt")), {
      code: "ENOENT",
    });
    await assert.rejects(
      merge.apply(task.id, { approval: preview.approval }),
      /승인/,
    );
    await writeFile(join(project.root, "내 작업.txt"), "사용자 작업");
    await assert.rejects(merge.preview(task.id), /커밋하지 않은/);
    assert.equal(
      await readFile(join(project.root, "내 작업.txt"), "utf8"),
      "사용자 작업",
    );
    const newBase = await checkpoint({ path: project.root }, "사용자 변경");
    await assert.rejects(
      merge.apply(task.id, { confirm: true, approval: preview.approval }),
      /바뀌었습니다/,
    );
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), newBase);
    app.runner.active.set(task.id, {});
    await assert.rejects(merge.preview(task.id), /진행 중/);
    app.runner.active.delete(task.id);
    app.store.update("tasks", task.id, { executionUnconfirmed: true });
    await assert.rejects(merge.preview(task.id), /진행 중/);
    app.store.update("tasks", task.id, { executionUnconfirmed: false });
    await git(project.root, ["checkout", "-b", "다른-브랜치"]);
    await assert.rejects(merge.preview(task.id), /등록 당시/);
    await git(project.root, ["checkout", "main"]);
    await git(project.root, ["config", "merge.custom.driver", "false"]);
    await assert.rejects(merge.preview(task.id), /드라이버/);
    await git(project.root, ["config", "--unset", "merge.custom.driver"]);
    app.store.projectLocks.add(project.id);
    assert.throws(
      () => company.continueTask(task.id, { prompt: "추가 요청" }),
      /프로젝트를 변경하는 중/,
    );
    await assert.rejects(
      merge.apply(task.id, { confirm: true, approval: preview.approval }),
      /프로젝트를 변경하는 중/,
    );
    app.store.projectLocks.delete(project.id);
    await writeFile(join(worktree.path, "결과.txt"), "외부 IDE 편집");
    await assert.rejects(merge.preview(task.id), /커밋하지 않은/);
    await writeFile(join(worktree.path, "결과.txt"), "직원 결과");
    const hookPath = join(directory, "user-hooks");
    await mkdir(hookPath);
    await writeFile(
      join(hookPath, "post-merge"),
      "#!/bin/sh\nprintf executed > hook-ran.txt\n",
      { mode: 0o700 },
    );
    await git(project.root, ["config", "core.hooksPath", hookPath]);
    preview = await merge.preview(task.id);
    const route = `${app.origin}/api/tasks/${task.id}/merge`;
    assert.equal((await fetch(route)).status, 401);
    const headers = {
      Authorization: `Bearer ${app.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    };
    const post = () =>
      fetch(route, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: true, approval: preview.approval }),
      });
    const response = await post();
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), result.commit);
    await assert.rejects(readFile(join(project.root, "hook-ran.txt")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(project.root, "내 작업.txt"), "utf8"),
      "사용자 작업",
    );
    assert.equal(
      await readFile(join(project.root, "결과.txt"), "utf8"),
      "직원 결과",
    );
    assert.equal(
      await git(project.root, ["show", "-s", "--format=%P", "HEAD"]),
      `${newBase} ${resultCommit}`,
    );
    assert.equal(await git(worktree.path, ["rev-parse", "HEAD"]), resultCommit);
    assert.equal(
      app.store.get("tasks", task.id).status,
      "review",
      "병합과 업무 완료는 별개",
    );
    assert.equal(app.store.get("tasks", task.id).merge.status, "merged");
    assert.match(app.store.all("reports", project.id).at(-1).text, /푸시·배포/);
    assert.deepEqual(await (await post()).json(), result);
    assert.equal((await merge.preview(task.id)).alreadyMerged, true);
    assert.equal(await git(project.root, ["rev-list", "--count", "HEAD"]), "4");
    assert.equal(app.store.projectLocks.size, 0);

    const next = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "충돌 검사",
    });
    const second = await isolatedWorktree(
      project.root,
      join(directory, "second"),
      next.id,
    );
    await writeFile(join(second.path, "결과.txt"), "직원의 후속 수정");
    app.store.update("tasks", next.id, {
      worktree: second,
      resultCommit: await checkpoint(second, "직원 수정"),
      status: "review",
    });
    await writeFile(join(project.root, "결과.txt"), "사용자의 후속 수정");
    const beforeConflict = await checkpoint(
      { path: project.root },
      "원본 수정",
    );
    await assert.rejects(merge.preview(next.id), /Git 충돌/);
    assert.equal(
      await git(project.root, ["rev-parse", "HEAD"]),
      beforeConflict,
    );
    assert.equal(await git(project.root, ["status", "--porcelain"]), "");
    assert.equal(
      await readFile(join(project.root, "결과.txt"), "utf8"),
      "사용자의 후속 수정",
    );
    assert.equal(app.store.get("tasks", next.id).merge, undefined);
  } finally {
    app.runner.active.clear();
    await app.close();
  }
});

test("Git ignore 파일은 덮어쓰지 않고 불확정 반영은 재실행하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-merge-ignore-"));
  const app = await startServer({
    directory: join(directory, "worker"),
    port: 0,
  });
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "보존", mode: "single" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "repo",
    });
    const employee = company.createEmployee({
      name: "직원",
      role: "개발",
      instructions: "작업",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "새 파일",
    });
    const worktree = await isolatedWorktree(
      project.root,
      join(directory, "task"),
      task.id,
    );
    await writeFile(join(worktree.path, "local.txt"), "직원 파일");
    app.store.update("tasks", task.id, {
      worktree,
      resultCommit: await checkpoint(worktree, "추가"),
      status: "completed",
    });
    await writeFile(join(project.root, ".gitignore"), "local.txt\n");
    await checkpoint({ path: project.root }, "ignore");
    await writeFile(join(project.root, "local.txt"), "사용자 전용 파일");
    const merge = new ResultMerge(
      app.store,
      app.runner,
      join(directory, "worker"),
    );
    const preview = await merge.preview(task.id);
    const head = await git(project.root, ["rev-parse", "HEAD"]);
    await assert.rejects(
      merge.apply(task.id, { confirm: true, approval: preview.approval }),
      /확정하지 못했습니다/,
    );
    assert.equal(
      await readFile(join(project.root, "local.txt"), "utf8"),
      "사용자 전용 파일",
    );
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), head);
    assert.equal(app.store.get("tasks", task.id).merge.status, "unconfirmed");
    await assert.rejects(merge.preview(task.id), /이전 반영/);
    assert.equal(app.store.projectLocks.size, 0);
    const recovery = new GitRecovery(app.store, app.runner);
    const observation = await recovery.observe("merge", task.id);
    assert.equal(observation.execution, "closed");
    assert.equal(observation.outcome, "not-applied");
    await recovery.resolve("merge", task.id, {
      confirm: true,
      approval: observation.approval,
    });
    assert.equal(app.store.get("tasks", task.id).merge.status, "not-applied");
    assert.equal(
      await readFile(join(project.root, "local.txt"), "utf8"),
      "사용자 전용 파일",
    );
    assert.equal(await git(project.root, ["rev-parse", "HEAD"]), head);
    assert.equal((await merge.preview(task.id)).alreadyMerged, false);
  } finally {
    await app.close();
  }
});
