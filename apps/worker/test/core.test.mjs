import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";
import { git, isolatedWorktree } from "../src/git.mjs";
import { startServer } from "../src/server.mjs";

test("직원 비교는 확인한 원본·대상 버전만 반영하며 다른 프로젝트와 실행 설정을 보존한다", () => {
  const store = new Store();
  const company = new Company(store);
  try {
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "원본 1",
    });
    const org = company.createCompany({ name: "직원 비교", mode: "group" });
    const a = store.insert("projects", {
      name: "A",
      root: "/fixture-a",
      companyId: org.id,
      completion: "manual",
    });
    const b = store.insert("projects", {
      name: "B",
      root: "/fixture-b",
      companyId: org.id,
      completion: "manual",
    });
    const aa = company.assign(a.id, employee.id);
    const ab = company.assign(b.id, employee.id);
    const task = company.requestTask({
      projectId: a.id,
      assignmentId: aa.id,
      prompt: "현재 업무",
    });
    const derived = company.createEmployee({
      ...employee,
      name: "파생",
      sourceId: employee.id,
      sourceRevision: employee.revision,
    });
    const next = company.editEmployee(employee.id, {
      ...employee,
      instructions: "원본 2",
    });
    for (const sourceRevision of [
      undefined,
      employee.revision,
      String(next.revision),
    ]) {
      assert.throws(
        () =>
          company.refreshAssignment(
            aa.id,
            ["instructions"],
            aa.revision,
            sourceRevision,
          ),
        /원본 직원이 변경/,
      );
      assert.throws(
        () =>
          company.refreshEmployee(
            derived.id,
            ["instructions"],
            derived.revision,
            sourceRevision,
          ),
        /기반 직원이 변경/,
      );
      assert.throws(
        () =>
          company.createEmployee({
            ...employee,
            sourceId: employee.id,
            sourceRevision,
          }),
        /기반 직원이 변경/,
      );
    }
    assert.deepEqual(store.get("assignments", aa.id), aa);
    assert.deepEqual(store.get("employees", derived.id), derived);
    assert.equal(store.all("employees").length, 2);
    const changed = company.editAssignment(aa.id, {
      ...aa.settings,
      role: "전용 역할",
      revision: aa.revision,
    });
    assert.throws(
      () =>
        company.refreshAssignment(
          aa.id,
          ["instructions"],
          aa.revision,
          next.revision,
        ),
      /다른 변경/,
    );
    const applied = company.refreshAssignment(
      aa.id,
      ["instructions"],
      changed.revision,
      next.revision,
    );
    assert.equal(applied.settings.instructions, next.instructions);
    assert.equal(applied.settings.role, "전용 역할");
    const edited = company.editEmployee(derived.id, {
      ...derived,
      skills: "전용 스킬",
    });
    assert.throws(
      () =>
        company.refreshEmployee(
          derived.id,
          ["instructions"],
          derived.revision,
          next.revision,
        ),
      /다른 변경/,
    );
    const refreshed = company.refreshEmployee(
      derived.id,
      ["instructions"],
      edited.revision,
      next.revision,
    );
    assert.equal(refreshed.instructions, next.instructions);
    assert.equal(refreshed.skills, "전용 스킬");
    assert.deepEqual(refreshed.appearance, derived.appearance);
    assert.deepEqual(store.get("assignments", ab.id), ab);
    assert.deepEqual(store.get("tasks", task.id), task);
  } finally {
    store.close();
  }
});

test("업무 이어가기는 요청 본문의 대화방이 아니라 기존 업무의 대화방·담당·프로젝트를 유지한다", () => {
  const store = new Store();
  const company = new Company(store);
  try {
    const org = company.createCompany({ name: "대화 연결", mode: "group" });
    const a = store.insert("projects", {
      companyId: org.id,
      root: "/test-a",
      name: "A",
    });
    const b = store.insert("projects", {
      companyId: org.id,
      root: "/test-b",
      name: "B",
    });
    const employee = company.createEmployee({
      name: "김코딩",
      role: "개발",
      instructions: "검사 자료",
    });
    const assignment = company.assign(a.id, employee.id);
    for (const channel of ["project", "direct", undefined]) {
      const task = company.requestTask({
        projectId: a.id,
        assignmentId: assignment.id,
        prompt: "원래 요청",
        channel,
      });
      store.update("tasks", task.id, { status: "review", channel });
      const next = company.continueTask(task.id, {
        prompt: "후속 요청",
        channel: "team",
        projectId: b.id,
        assignmentId: "다른 직원",
      });
      const message = store.all("messages", a.id).at(-1);
      assert.equal(message.channel, channel || "direct");
      assert.equal(message.taskId, task.id);
      assert.equal(message.assignmentId, assignment.id);
      assert.equal(next.projectId, a.id);
      assert.equal(next.generation, 2);
    }
    assert.equal(store.all("messages", b.id).length, 0);
  } finally {
    store.close();
  }
});

test("프로젝트 격리, 직원 설정 스냅샷, 문서 충돌, 안전한 보관", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-domain-"));
  const store = new Store();
  const company = new Company(store);
  try {
    const org = company.createCompany({ name: "내 회사", mode: "group" });
    const a = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "A",
    });
    const b = await company.addProject({
      companyId: org.id,
      create: true,
      parent: directory,
      folder: "B",
    });
    await assert.rejects(
      company.addProject({ companyId: org.id, root: a.root }),
      /이미 등록/,
    );
    const staff = company.createEmployee({
      name: "김코딩",
      role: "백엔드",
      instructions: "한국어로 보고",
      skills: "",
    });
    const aa = company.assign(a.id, staff.id);
    const ab = company.assign(b.id, staff.id);
    assert.equal(company.assign(a.id, staff.id).id, aa.id);
    const task = company.requestTask({
      projectId: a.id,
      assignmentId: aa.id,
      prompt: "A의 비공개 요구사항",
    });
    assert.equal(company.snapshot(b.id).messages.length, 0);
    assert.throws(() =>
      company.requestTask({
        projectId: a.id,
        assignmentId: ab.id,
        prompt: "잘못된 직원",
      }),
    );
    company.editEmployee(staff.id, { ...staff, instructions: "개선한 지침" });
    assert.equal(
      store.get("assignments", aa.id).settings.instructions,
      "한국어로 보고",
    );
    company.refreshAssignment(
      aa.id,
      ["instructions"],
      aa.revision,
      store.get("employees", staff.id).revision,
    );
    assert.equal(
      store.get("assignments", aa.id).settings.instructions,
      "개선한 지침",
    );
    assert.equal(
      store.get("tasks", task.id).settings.instructions,
      "한국어로 보고",
    );
    assert.equal(
      store.get("assignments", ab.id).settings.instructions,
      "한국어로 보고",
    );
    const original = store.get("employees", staff.id);
    const derived = company.createEmployee({
      ...original,
      name: "다른 김코딩",
      role: "프로젝트 전용 역할",
      sourceId: original.id,
      sourceRevision: original.revision,
    });
    company.editEmployee(original.id, {
      ...original,
      role: "개선한 원본 역할",
      instructions: "최신 공통 지침",
    });
    company.refreshEmployee(
      derived.id,
      ["instructions"],
      derived.revision,
      store.get("employees", original.id).revision,
    );
    assert.equal(store.get("employees", derived.id).role, "프로젝트 전용 역할");
    assert.equal(
      store.get("employees", derived.id).instructions,
      "최신 공통 지침",
    );
    assert.equal(
      store.get("assignments", ab.id).settings.instructions,
      "한국어로 보고",
    );
    const assignment = store.get("assignments", aa.id);
    company.editAssignment(assignment.id, {
      ...assignment.settings,
      revision: assignment.revision,
      role: "이 프로젝트만의 역할",
    });
    assert.equal(
      store.get("assignments", aa.id).settings.role,
      "이 프로젝트만의 역할",
    );
    assert.equal(store.get("employees", staff.id).role, "개선한 원본 역할");
    const doc = company.snapshot(a.id).documents[0];
    company.editDocument(doc.id, { ...doc, content: "첫 변경" });
    assert.throws(
      () => company.editDocument(doc.id, { ...doc, content: "오래된 변경" }),
      /다른 변경/,
    );
    assert.throws(() => company.archiveProject(a.id), /업무를 먼저 중단/);
    store.update("tasks", task.id, { status: "interrupted" });
    await writeFile(join(a.root, "keep.txt"), "사용자 파일");
    company.archiveProject(a.id);
    assert.equal(
      await readFile(join(a.root, "keep.txt"), "utf8"),
      "사용자 파일",
    );
    assert.equal(company.snapshot(a.id).messages.length, 1);
  } finally {
    store.close();
  }
});

test("병렬 작업용 Git worktree는 기존 파일과 스테이징 내용을 침범하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-worktree-"));
  const root = join(directory, "project");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "private.txt"), "existing staged file");
  await git(root, ["add", "private.txt"]);
  const [a, b] = await Promise.all([
    isolatedWorktree(root, join(directory, "a"), "task-a"),
    isolatedWorktree(root, join(directory, "b"), "task-b"),
  ]);
  assert.match(await git(root, ["status", "--porcelain"]), /A  private.txt/);
  assert.equal(await git(a.path, ["ls-files"]), "");
  await writeFile(join(a.path, "new.txt"), "A only");
  await assert.rejects(readFile(join(b.path, "new.txt")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(root, "private.txt"), "utf8"),
    "existing staged file",
  );
});

test("실행부 HTTP 인증, 다른 출처 차단, DB 소유권 및 재시작 보존", async () => {
  const directory = await mkdtemp(join(tmpdir(), "otter-server-"));
  const app = await startServer({ directory, port: 0 });
  try {
    assert.equal((await fetch(app.origin + "/api/state")).status, 401);
    const headers = { Authorization: "Bearer " + app.token };
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(app.origin + "/api/state", { headers })).status,
      200,
    );
    const created = await fetch(app.origin + "/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "지속되는 회사", mode: "group" }),
    });
    assert.equal(created.status, 201);
    await assert.rejects(startServer({ directory, port: 0 }), /잠금/);
  } finally {
    await app.close();
  }
  const again = await startServer({ directory, port: 0 });
  assert.equal(again.store.all("companies")[0].name, "지속되는 회사");
  await again.close();
});
