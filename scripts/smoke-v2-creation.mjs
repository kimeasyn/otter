// 실제 HTTP/SQLite/Git을 사용하되 요청을 잠시 보류하고 프로젝트 잠금 실패를 재현한다.
import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { createRepository } from "../apps/worker/src/git.mjs";

const directory = await mkdtemp(join(tmpdir(), "otter-creation-ui-"));
const repo = await createRepository(directory, "existing-project");
const original = join(repo.root, "keep.txt");
await writeFile(original, "기존 사용자 파일 보존\n");
let modelCalls = 0;
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: () => {
    modelCalls++;
    throw new Error("모델 실행 금지");
  },
});
let browser;
let release = () => {};
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const counts = { companies: 0, projects: 0, employees: 0, assignments: 0 };
  page.on("request", (request) => {
    const name = new URL(request.url()).pathname.split("/").pop();
    if (request.method() === "POST" && Object.hasOwn(counts, name))
      counts[name]++;
  });
  const hold = async (path) => {
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/${path}`, async (route) => {
      await gate;
      await route.continue();
    });
  };
  const assertLocked = async (dialog, control) => {
    await expect(control).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "닫기", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeVisible();
    // disabled 버튼을 거치지 않는 추가 submit도 새 요청을 만들지 않아야 한다.
    await dialog
      .locator("form")
      .evaluate((form) =>
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
  };
  await page.goto(app.origin);
  await page.getByRole("button", { name: "첫 프로젝트 시작하기 ↗" }).click();
  let dialog = page.getByRole("dialog", {
    name: "프로젝트 시작하기",
    exact: true,
  });
  await dialog
    .getByLabel("회사 이름", { exact: true })
    .fill("실패 후 이어가기");
  await dialog.getByLabel("폴더 경로", { exact: true }).fill(directory);
  await hold("projects");
  await dialog
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await expect.poll(() => counts.projects).toBe(1);
  await assertLocked(
    dialog,
    dialog.getByRole("combobox", { name: "실행 환경", exact: true }),
  );
  assert.equal(counts.companies, 1);
  assert.equal(counts.projects, 1);
  const failedProject = page.waitForResponse(
    (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
  );
  release();
  assert.ok(!(await failedProject).ok());
  await page.unroute("**/api/projects");
  await expect(dialog.getByLabel("폴더 경로")).toBeEnabled();
  await expect(dialog.getByRole("alert")).toBeVisible();
  assert.equal(app.store.all("companies").length, 1);
  assert.equal(app.store.all("projects").length, 0);
  const companyId = app.store.all("companies")[0].id;
  await expect(
    dialog.getByRole("combobox", { name: "회사", exact: true }),
  ).toHaveValue(companyId);
  await dialog.getByLabel("폴더 경로").fill(repo.root);
  await dialog
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  assert.equal(counts.companies, 1);
  assert.equal(app.store.all("projects").length, 1);
  const project = app.store.all("projects")[0];
  assert.equal(project.companyId, companyId);

  await page.getByRole("button", { name: "＋ 직원 배정", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "함께 일할 직원", exact: true });
  await dialog.getByLabel("이름", { exact: true }).fill("한 번만 생성할 직원");
  await dialog.getByLabel("역할", { exact: true }).fill("개발");
  await hold("assignments");
  app.store.projectLocks.add(project.id);
  await dialog
    .getByRole("button", { name: "이 프로젝트에 배정", exact: true })
    .click();
  await expect.poll(() => counts.assignments).toBe(1);
  await assertLocked(
    dialog,
    dialog.getByRole("combobox", { name: "직원 선택", exact: true }),
  );
  assert.equal(counts.employees, 1);
  assert.equal(counts.assignments, 1);
  const employee = app.store.all("employees")[0];
  await expect(
    dialog.getByRole("combobox", { name: "직원 선택", exact: true }),
  ).toHaveValue(employee.id);
  const failedAssignment = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/assignments") && r.request().method() === "POST",
  );
  release();
  assert.equal((await failedAssignment).status(), 409);
  await page.unroute("**/api/assignments");
  await expect(
    dialog.getByRole("button", { name: "이 프로젝트에 배정", exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByRole("alert")).toContainText(
    "프로젝트를 변경하는 중",
  );
  await expect(dialog.getByRole("status")).toContainText("직원 생성은 완료");
  assert.equal(app.store.all("employees").length, 1);
  assert.equal(app.store.all("assignments").length, 0);
  app.store.projectLocks.delete(project.id);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await dialog
      .locator(".modal")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({
    path: join(directory, "creation-retry-mobile.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "이 프로젝트에 배정", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  assert.equal(counts.employees, 1);
  assert.equal(counts.assignments, 2);
  assert.equal(app.store.all("employees").length, 1);
  const assignments = app.store.all("assignments");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].employeeId, employee.id);
  assert.equal(assignments[0].projectId, project.id);
  assert.equal(await readFile(original, "utf8"), "기존 사용자 파일 보존\n");
  assert.equal(app.store.all("tasks").length, 0);
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      counts,
      pendingCloseBlocked: true,
      companyReused: true,
      employeeReused: true,
      filesPreserved: true,
      modelCalls,
    }),
  );
} finally {
  release();
  app.store.projectLocks.clear();
  await browser?.close();
  await app.close();
}
