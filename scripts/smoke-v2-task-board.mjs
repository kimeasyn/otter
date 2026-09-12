import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

// 상태는 UI 검사 자료다. 검색/조회가 실행·승인이나 업무 상태 변경을 만들지 않는지 검사한다.
const directory = await mkdtemp(join(tmpdir(), "otter-task-board-ui-"));
let modelCalls = 0;
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: () => {
    modelCalls++;
    throw new Error("모델 실행 금지");
  },
});
app.runner.pump = () => {};
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "업무 찾기 회사", mode: "group" });
  const a = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "a",
    name: "로그인 프로젝트",
  });
  const b = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "b",
    name: "별도 프로젝트",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "UI 검사 자료",
  });
  const aa = company.assign(a.id, employee.id),
    ab = company.assign(b.id, employee.id);
  const tasks = [];
  for (const [status, prompt] of [
    ["running", "현재 로그인 구현"],
    ["waiting", "로그인 정책 질문"],
    ["failed", "연결 검사 실패"],
    ["interrupted", "로그인 API 중단"],
    ["completed", "로그인 문서 작성"],
    ["future-state", "상태를 모르는 업무"],
  ]) {
    const task = company.requestTask({
      projectId: a.id,
      assignmentId: aa.id,
      prompt,
      channel: "project",
    });
    app.store.update("tasks", task.id, {
      status,
      ...(status === "future-state" ? { assignmentId: "missing-owner" } : {}),
    });
    tasks.push(task);
  }
  const other = company.requestTask({
    projectId: b.id,
    assignmentId: ab.id,
    prompt: "별도 프로젝트 결과",
  });
  app.store.update("tasks", other.id, { status: "completed" });
  const before = app.store.all("tasks");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    writes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(request.url());
  });
  await page.goto(app.origin);
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  const board = page.locator(".task-workspace");
  const search = page.getByRole("searchbox", { name: "업무 검색" });
  const owner = page.getByRole("combobox", { name: "담당 직원" });
  const status = page.getByRole("combobox", { name: "업무 상태" });
  await expect(board.locator(".task-card")).toHaveCount(6);
  await expect(
    board.getByRole("region", { name: "확인할 업무" }).locator(".task-card"),
  ).toHaveCount(4);
  await search.fill("로그인");
  await owner.selectOption(aa.id);
  await status.selectOption("interrupted");
  await expect(board.locator(".task-card")).toHaveCount(1);
  await board.getByRole("button", { name: "대화 열기 →", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "업무 대화 선택" }),
  ).toHaveValue(tasks[3].id);
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await expect(search).toHaveValue("로그인");
  await expect(owner).toHaveValue(aa.id);
  await expect(status).toHaveValue("interrupted");
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(b.id);
  await expect(search).toHaveValue("");
  await expect(owner).toHaveValue("");
  await expect(status).toHaveValue("");
  await expect(
    board.getByRole("heading", { name: "별도 프로젝트 결과", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(a.id);
  await expect(search).toHaveValue("로그인");
  await search.fill("존재하지 않는 검색어");
  await expect(board.getByText(/조건에 맞는 업무가 없습니다/)).toBeVisible();
  await board
    .getByRole("button", { name: "확인할 업무 4개", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await expect(board.locator(".task-card")).toHaveCount(4);
  const unknown = board.locator(".task-card").filter({
    has: page.getByRole("heading", {
      name: "상태를 모르는 업무",
      exact: true,
    }),
  });
  await expect(unknown.getByText("상태 미확인", { exact: true })).toBeVisible();
  await expect(
    unknown.getByRole("button", { name: "대화 열기 →", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: join(directory, "task-board-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await board.getByRole("button", { name: "필터 초기화" }).click();
  await status.selectOption("failed");
  await expect(board.locator(".task-card")).toHaveCount(1);
  const emptyColumn = await board
    .getByRole("region", { name: "진행 중" })
    .boundingBox();
  assert.ok(emptyColumn && emptyColumn.height < 130);
  await board.screenshot({ path: join(directory, "task-board-mobile.png") });
  await page.route("**/api/state**", (route) => route.abort());
  await expect(board.getByText(/마지막으로 확인한 업무/)).toBeVisible({
    timeout: 20000,
  });
  await expect(board.locator(".task-card")).toHaveCount(1);
  assert.deepEqual(app.store.all("tasks"), before);
  assert.deepEqual(writes, []);
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      filters: true,
      returnPreserved: true,
      projectIsolation: true,
      unknownVisible: true,
      readOnly: true,
      offline: true,
      mobile: true,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
