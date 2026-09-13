import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Company } from "../src/company.mjs";

test("업무 제목 수정은 버전을 확인하고 원문·실행 상태를 변경하지 않는다", () => {
  const store = new Store();
  try {
    const company = new Company(store);
    const org = company.createCompany({ name: "회사", mode: "group" });
    const project = store.insert("projects", {
      name: "프로젝트",
      root: "/fixture",
      companyId: org.id,
    });
    const task = store.insert("tasks", {
      projectId: project.id,
      title: "계속해줘",
      prompt: "계속해줘",
      status: "running",
      generation: 2,
    });
    for (const title of ["", " ", "a".repeat(81), 1])
      assert.throws(() =>
        company.editTask(task.id, { title, revision: task.revision }),
      );
    assert.throws(
      () => company.editTask(task.id, { title: "랜딩페이지 제작" }),
      /버전/,
    );
    const edited = company.editTask(task.id, {
      title: "랜딩페이지 제작",
      revision: task.revision,
      prompt: "덮어쓰기",
      status: "completed",
    });
    assert.equal(edited.prompt, task.prompt);
    assert.equal(edited.status, task.status);
    assert.equal(edited.generation, task.generation);
    assert.equal(edited.title, "랜딩페이지 제작");
    assert.throws(
      () =>
        company.editTask(task.id, { title: "충돌", revision: task.revision }),
      /변경/,
    );
    assert.equal(store.get("tasks", task.id).title, "랜딩페이지 제작");
  } finally {
    store.close();
  }
});
