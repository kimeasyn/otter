import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { startServer } from "../src/server.mjs";
import { Company } from "../src/company.mjs";
import {
  editorRequest,
  editorTarget,
  editorArguments,
} from "../src/editor.mjs";
import { isolatedWorktree, git } from "../src/git.mjs";
import {
  codeCandidates,
  findCode,
  launchCode,
} from "../../desktop/src/ide.mjs";

test("IDE는 원본/직원 작업 폴더를 구분하고 다른 프로젝트·저장소·링크 대체를 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "otter-editor-"));
  const app = await startServer({ directory: join(root, "worker"), port: 0 });
  app.runner.pump = () => {};
  try {
    const company = new Company(app.store);
    const org = company.createCompany({ name: "IDE 회사", mode: "group" });
    const project = await company.addProject({
      companyId: org.id,
      create: true,
      parent: root,
      folder: "한글 project",
    });
    const other = await company.addProject({
      companyId: org.id,
      create: true,
      parent: root,
      folder: "other",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "범위 안에서 작업",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt: "구현",
    });
    await assert.rejects(
      editorTarget(app.store, app.runner, project.id, task.id),
      /아직 개발용/,
    );
    const worktree = await isolatedWorktree(
      project.root,
      join(root, "작업 # & ' $(touch nope)"),
      task.id,
    );
    app.store.update("tasks", task.id, { worktree });
    await writeFile(join(worktree.path, "작업.txt"), "아직 커밋하지 않은 파일");
    const before = await git(worktree.path, ["status", "--porcelain"]);
    const target = await editorRequest(app, {
      projectId: project.id,
      taskId: task.id,
    });
    assert.equal(target.path, worktree.path);
    assert.deepEqual(target.args, ["--new-window", worktree.path]);
    assert.equal(
      (await editorRequest(app, { projectId: project.id })).path,
      project.root,
    );
    app.runner.active.set(task.id, {});
    assert.equal(
      (await editorTarget(app.store, app.runner, project.id, task.id)).active,
      true,
    );
    app.runner.active.delete(task.id);
    assert.equal(await git(worktree.path, ["status", "--porcelain"]), before);
    await assert.rejects(
      editorTarget(app.store, app.runner, other.id, task.id),
      /다른 프로젝트/,
    );
    app.store.update("tasks", task.id, {
      worktree: { ...worktree, path: other.root },
    });
    await assert.rejects(
      editorTarget(app.store, app.runner, project.id, task.id),
      /다른 저장소/,
    );
    const link = join(root, "replaced-link");
    await symlink(worktree.path, link);
    app.store.update("tasks", task.id, {
      worktree: { ...worktree, path: link },
    });
    await assert.rejects(
      editorTarget(app.store, app.runner, project.id, task.id),
      /다른 경로/,
    );
    app.store.update("tasks", task.id, { worktree });
    await git(worktree.path, ["checkout", "-b", "user-branch"]);
    const changed = await editorTarget(
      app.store,
      app.runner,
      project.id,
      task.id,
    );
    assert.equal(changed.branch, "user-branch");
    assert.equal(changed.expectedBranch, worktree.branch);
    const url = `${app.origin}/api/editor?projectId=${project.id}&taskId=${task.id}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${app.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, worktree.path);
    assert.equal(
      (
        await fetch(url, {
          headers: {
            Authorization: `Bearer ${app.token}`,
            Origin: "https://other.invalid",
          },
        })
      ).status,
      403,
    );
    assert.equal(app.store.all("tasks").length, 1);
    app.store.update("projects", project.id, { archived: true });
    await assert.rejects(
      editorTarget(app.store, app.runner, project.id),
      /개발 공간/,
    );
    app.store.update("projects", project.id, {
      archived: false,
      stage: "idea",
    });
    await assert.rejects(
      editorTarget(app.store, app.runner, project.id),
      /개발 공간/,
    );
  } finally {
    app.runner.active.clear();
    await app.close();
  }
});

test("VS Code 인자는 셸이 아니라 별도 argv이며 SSH/WSL의 명시적 대상을 유지한다", async () => {
  const path = "/repo/공백 ' ; $(touch injected)";
  assert.deepEqual(editorArguments(path, { kind: "ssh" }, "company-dev"), [
    "--new-window",
    "--remote",
    "ssh-remote+company-dev",
    path,
  ]);
  for (const host of [
    undefined,
    "user@host",
    "host:2222",
    "host;touch",
    "-host",
    "host\nnext",
  ])
    assert.throws(() => editorArguments(path, { kind: "ssh" }, host));
  assert.deepEqual(
    editorArguments(
      "/home/user/repo",
      { kind: "wsl", distribution: "Ubuntu 24" },
      "",
      "win32",
    ),
    ["--new-window", "--remote", "wsl+Ubuntu 24", "/home/user/repo"],
  );
  assert.throws(
    () =>
      editorArguments(
        path,
        { kind: "wsl", distribution: "Ubuntu" },
        "",
        "darwin",
      ),
    /Windows/,
  );
  assert.deepEqual(
    editorArguments(
      "C:\\Users\\dev\\my project",
      undefined,
      undefined,
      "win32",
    ),
    ["--new-window", "C:\\Users\\dev\\my project"],
  );
  for (const invalid of ["relative", "-option", "/path\nnext", "/path\0next"])
    assert.throws(() => editorArguments(invalid));
  assert.match(
    codeCandidates("win32", {
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    })[0],
    /\\Code.exe$/,
  );
  assert.equal(await findCode("/definitely-missing-otter-code"), null);
  const directory = await mkdtemp(join(tmpdir(), "otter-editor-argv-"));
  const output = join(directory, "argv.json");
  assert.equal(await findCode(directory), null);
  // 실제 자식 프로세스에 특수문자 인자를 전달한다. VS Code GUI/계정은 실행하지 않는다.
  await launchCode(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));",
      "--",
      output,
      ...editorArguments(path),
    ],
    directory,
  );
  let received;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      received = JSON.parse(await readFile(output, "utf8"));
      break;
    } catch {
      await setTimeout(10);
    }
  }
  assert.deepEqual(received, ["--new-window", path]);
  await assert.rejects(
    launchCode(join(directory, "missing"), [], directory),
    /전달하지 못했습니다/,
  );
  await assert.rejects(launchCode("relative-code", [], directory), /절대 경로/);
});
