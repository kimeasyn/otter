import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { isolatedWorktree } from "../apps/worker/src/git.mjs";

// 실제 중단/재개 HTTP·DB·Git. 제공자 실행은 금지하고 재개 요청의 접수까지 검사한다.
const directory = await mkdtemp(join(tmpdir(), "otter-resume-ui-"));
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
  const org = company.createCompany({ name: "재개 검사 회사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "검사 자료",
  });
  const assignment = company.assign(project.id, employee.id);
  const task = company.requestTask({
    projectId: project.id,
    assignmentId: assignment.id,
    channel: "project",
    prompt: "중단한 로그인 업무",
  });
  const worktree = await isolatedWorktree(
    project.root,
    join(directory, "work"),
    task.id,
  );
  app.store.update("tasks", task.id, { worktree });
  const file = join(worktree.path, "partial.txt");
  await writeFile(file, "보존할 임시 작업");
  await app.runner.cancel(task.id);
  const unknown = company.requestTask({
    projectId: project.id,
    assignmentId: assignment.id,
    prompt: "종료 미확인 업무",
  });
  app.store.update("tasks", unknown.id, {
    status: "interrupted",
    interruptionConfirmed: false,
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: task.title }) })
    .getByRole("button", { name: "대화 열기 →", exact: true })
    .click();
  const chat = page.locator(".chat-panel"),
    input = chat.getByRole("textbox", { name: "직원에게 업무 요청" });
  const send = chat.getByRole("button", { name: "이어서 진행" });
  await input.fill("기존 작업을 확인하고 남은 구현을 이어가");
  await expect(chat.getByRole("checkbox")).toHaveCount(0);
  await expect(send).toBeEnabled();
  await page.screenshot({
    path: join(directory, "resume-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await send.click({ trial: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await chat.screenshot({ path: join(directory, "resume-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  let raced = false;
  await page.route(`**/api/tasks/${task.id}/continue`, async (route) => {
    if (!raced) {
      raced = true;
      app.store.update("tasks", task.id, {
        error: "다른 화면에서 상태를 확인했습니다(검사 자료)",
      });
    }
    await route.continue();
  });
  const denied = page.waitForResponse((r) =>
    r.url().endsWith(`/tasks/${task.id}/continue`),
  );
  await send.click();
  assert.equal((await denied).status(), 409);
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue("기존 작업을 확인하고 남은 구현을 이어가");
  await expect(page.getByRole("alert").first()).toBeVisible();
  const accepted = page.waitForResponse((r) =>
    r.url().endsWith(`/tasks/${task.id}/continue`),
  );
  await send.click();
  const response = await accepted;
  assert.equal(response.status(), 200);
  await expect(input).toHaveValue("");
  const replay = await fetch(app.origin + `/api/tasks/${task.id}/continue`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${app.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": response.request().headers()["idempotency-key"],
    },
    body: response.request().postData(),
  });
  assert.equal(replay.status, 200);
  assert.equal(app.store.all("tasks", project.id).length, 2);
  assert.equal(
    app.store.all("messages", project.id).filter((m) => m.taskId === task.id)
      .length,
    2,
  );
  const resumed = app.store.get("tasks", task.id);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.generation, 2);
  assert.deepEqual(resumed.worktree, worktree);
  assert.equal(await readFile(file, "utf8"), "보존할 임시 작업");
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: unknown.title }) })
    .getByRole("button", { name: "대화 열기 →", exact: true })
    .click();
  await expect(input).toBeDisabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(chat.getByText(/종료 확인 기록이 없어/)).toBeVisible();
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      confirmedResume: true,
      staleConsentRejected: true,
      replayOnce: true,
      filesPreserved: true,
      unknownBlocked: true,
      modelCalls,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
