import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

const directory = await mkdtemp(join(tmpdir(), "otter-staff-conflicts-"));
let modelCalls = 0;
const app = await startServer({
  directory,
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
  const org = company.createCompany({
    name: "직원 재사용 검사",
    mode: "group",
  });
  const a = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "a",
  });
  const b = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "b",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "기본 지침",
  });
  const aa = company.assign(a.id, employee.id),
    ab = company.assign(b.id, employee.id);
  const task = company.requestTask({
    projectId: a.id,
    assignmentId: aa.id,
    prompt: "현재 업무",
  });
  const beforeTask = app.store.get("tasks", task.id);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page
    .getByRole("button", { name: "프로젝트 설정", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const instructions = dialog.getByRole("textbox", {
    name: "지침",
    exact: true,
  });
  await instructions.fill("저장하지 않은 내 지침");
  company.editAssignment(aa.id, {
    ...aa.settings,
    revision: aa.revision,
    instructions: "외부에서 바뀐 지침",
  });
  const otherEdit = app.store.get("assignments", aa.id);
  await expect(dialog.getByText(/창을 연 뒤 설정이 변경/)).toBeVisible();
  await expect(instructions).toHaveValue("저장하지 않은 내 지침");
  let response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/assignments/${aa.id}/edit`) &&
      r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "설정 저장" }).click();
  assert.equal((await response).status(), 409);
  await expect(instructions).toHaveValue("저장하지 않은 내 지침");
  assert.deepEqual(app.store.get("assignments", aa.id), otherEdit);
  await expect(
    dialog.getByRole("button", { name: "닫기", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "원본과 비교 · 1" }).click();
  await dialog.getByRole("checkbox", { name: /지침 반영/ }).check();
  // 화면 확인 직후 원본이 변경되는 요청 경쟁도 실제 HTTP 경계에서 거절한다.
  const refreshPath = `**/api/assignments/${aa.id}/refresh`;
  await page.route(refreshPath, async (route) => {
    company.editEmployee(employee.id, {
      ...app.store.get("employees", employee.id),
      instructions: "새 공통 지침",
    });
    await route.continue();
  });
  response = page.waitForResponse((r) =>
    r.url().endsWith(`/assignments/${aa.id}/refresh`),
  );
  await dialog.getByRole("button", { name: "선택한 변경 반영" }).click();
  assert.equal((await response).status(), 409);
  await page.unroute(refreshPath);
  await expect(dialog.getByText("기본 지침", { exact: true })).toBeVisible();
  assert.deepEqual(app.store.get("assignments", aa.id), otherEdit);
  await expect(
    dialog.getByRole("button", { name: "최신 설정 다시 비교" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "최신 설정 다시 비교" }).click();
  await expect(dialog.getByText("새 공통 지침", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: /지침 반영/ }),
  ).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /지침 반영/ }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({
    path: join(directory, "staff-comparison-mobile.png"),
  });
  response = page.waitForResponse((r) =>
    r.url().endsWith(`/assignments/${aa.id}/refresh`),
  );
  await dialog.getByRole("button", { name: "선택한 변경 반영" }).click();
  assert.equal((await response).status(), 200);
  await expect(dialog).not.toBeVisible();
  assert.equal(
    app.store.get("assignments", aa.id).settings.instructions,
    "새 공통 지침",
  );
  assert.deepEqual(app.store.get("assignments", ab.id), ab);
  assert.deepEqual(app.store.get("tasks", task.id), beforeTask);
  await page.getByRole("button", { name: "직원 라이브러리" }).click();
  await page.getByRole("button", { name: "파생 직원 만들기" }).click();
  await instructions.fill("새 파생 지침");
  const source = app.store.get("employees", employee.id);
  company.editEmployee(employee.id, { ...source, skills: "추가 스킬" });
  response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/employees") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "파생 직원 만들기" }).click();
  assert.equal((await response).status(), 409);
  await expect(instructions).toHaveValue("새 파생 지침");
  assert.equal(app.store.all("employees").length, 1);
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      editConflict: true,
      sourceRace: true,
      comparisonReset: true,
      selectedUpdate: true,
      deriveConflict: true,
      otherProjectAndTaskPreserved: true,
      modelCalls,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
