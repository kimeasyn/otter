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

// 상태/직원 응답은 UI 검사 자료. 후속 요청은 실제 HTTP/SQLite로 처리하며 모델은 실행하지 않는다.
const directory = await mkdtemp(join(tmpdir(), "otter-chat-routing-"));
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
  const org = company.createCompany({ name: "대화 연결 회사", mode: "group" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
    name: "단체방 프로젝트",
  });
  const other = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "other",
    name: "다른 프로젝트",
  });
  const team = ["김설계", "김코딩"].map((name) => {
    const employee = company.createEmployee({
      name,
      role: "개발",
      instructions: "대화 UI 검사 자료",
    });
    return company.assign(project.id, employee.id);
  });
  const shared = company.requestTask({
    projectId: project.id,
    assignmentId: team[1].id,
    channel: "project",
    prompt: "단체방 로그인 개발",
  });
  const direct = company.requestTask({
    projectId: project.id,
    assignmentId: team[1].id,
    channel: "direct",
    prompt: "개인 함수 개발",
  });
  for (const task of [shared, direct]) {
    app.store.update("tasks", task.id, { status: "review" });
    app.store.insert("messages", {
      projectId: project.id,
      taskId: task.id,
      assignmentId: task.assignmentId,
      sender: "assistant",
      text: task.title + " 검사 응답",
      channel: task.channel,
    });
    app.store.insert("reports", {
      projectId: project.id,
      taskId: task.id,
      title: task.title + " 보고",
      text: "브라우저 연결 검사 자료입니다.",
      kind: "result",
    });
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page
    .locator(".task-card")
    .filter({
      has: page.getByRole("heading", { name: shared.title, exact: true }),
    })
    .getByRole("button", { name: "대화 열기 →", exact: true })
    .click();
  const chat = page.locator(".chat-panel");
  const picker = chat.getByRole("combobox", { name: "업무 대화 선택" });
  await expect(chat.locator(".chat-badge")).toHaveText("프로젝트");
  await expect(picker).toHaveValue(shared.id);
  await expect(
    chat.getByRole("heading", { name: "김코딩", exact: true }),
  ).toBeVisible();
  await expect(
    chat.getByText(shared.title + " 검사 응답", { exact: true }),
  ).toBeVisible();
  await expect(
    chat.getByText(direct.title + " 검사 응답", { exact: true }),
  ).toHaveCount(0);
  await chat.getByRole("button", { name: "관련 보고 1개 보기 →" }).click();
  await page.getByRole("button", { name: "업무 대화로 돌아가기 →" }).click();
  await expect(chat.locator(".chat-badge")).toHaveText("프로젝트");
  const input = chat.getByRole("textbox", { name: "직원에게 업무 요청" });
  await input.fill("줄바꿈 검사");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("줄바꿈 검사\n");
  await input.fill("단체방에서 후속 요청");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/tasks/${shared.id}/continue`) &&
      r.request().method() === "POST",
  );
  await input.press("Enter");
  assert.equal((await response).status(), 200);
  await expect(
    chat.getByText("단체방에서 후속 요청", { exact: true }),
  ).toBeVisible();
  assert.equal(
    app.store.all("tasks", project.id).length,
    2,
    "새 업무로 잘못 만들지 않는다",
  );
  const message = app.store.all("messages", project.id).at(-1);
  assert.equal(message.channel, "project");
  assert.equal(message.assignmentId, team[1].id);
  assert.equal(message.taskId, shared.id);
  assert.equal(app.store.all("messages", other.id).length, 0);
  await picker.selectOption(direct.id);
  await expect(input).toBeDisabled();
  await chat.getByRole("button", { name: "원래 업무 대화 열기 →" }).click();
  await expect(chat.locator(".chat-badge")).toHaveText("1:1");
  await expect(
    chat.getByText(direct.title + " 검사 응답", { exact: true }),
  ).toBeVisible();
  await expect(
    chat.getByText("단체방에서 후속 요청", { exact: true }),
  ).toHaveCount(0);
  // 같은 직원의 일반 대화를 열 때 이전 업무 필터를 끌고 오지 않는다.
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page
    .locator(".staff-card")
    .filter({ has: page.getByRole("heading", { name: "김코딩", exact: true }) })
    .getByRole("button", { name: "대화 →", exact: true })
    .click();
  await expect(picker).toHaveValue("");
  // 프로젝트 탭에서 다른 직원의 업무를 골라도 그 업무의 실제 담당자를 유지한다.
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page
    .locator(".staff-card")
    .filter({ has: page.getByRole("heading", { name: "김설계", exact: true }) })
    .getByRole("button", { name: "대화 →", exact: true })
    .click();
  await chat.getByRole("button", { name: "프로젝트", exact: true }).click();
  await picker.selectOption(shared.id);
  await expect(
    chat.getByRole("heading", { name: "김코딩", exact: true }),
  ).toBeVisible();
  await input.fill("담당자별 단체방 초안");
  await picker.selectOption("");
  await expect(input).toHaveValue("");
  await picker.selectOption(shared.id);
  await expect(input).toHaveValue("담당자별 단체방 초안");
  await page.screenshot({
    path: join(directory, "chat-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await input.scrollIntoViewIfNeeded();
  const send = chat.getByRole("button", { name: "업무 요청 보내기" });
  // 앞선 이어가기 접수 뒤 이 업무는 대기 중이다. 추가 전송을 새 업무로 우회하지 않는다.
  await expect(send).toBeDisabled();
  await picker.selectOption("");
  await input.fill("별도로 요청할 새 업무 초안");
  await send.click({ trial: true });
  const panelBox = await chat.boundingBox(),
    sendBox = await send.boundingBox();
  assert.ok(
    sendBox.y + sendBox.height <= panelBox.y + panelBox.height + 1,
    "초안 안내 때문에 전송 버튼이 패널 밖으로 밀리지 않는다",
  );
  assert.ok((await chat.locator(".chat-messages").boundingBox()).height > 0);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await chat.screenshot({ path: join(directory, "chat-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(other.id);
  await expect(
    page.getByRole("textbox", { name: "직원에게 업무 요청" }),
  ).toBeDisabled();
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      projectChannel: true,
      continuation: true,
      correctRecipient: true,
      draftPreserved: true,
      projectIsolation: true,
      mobile: true,
      modelCalls,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
