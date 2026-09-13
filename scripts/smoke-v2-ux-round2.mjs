import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

const directory = await mkdtemp(join(tmpdir(), "otter-ux-round2-"));
const app = await startServer({
  directory,
  port: 0,
  makeCodex: () => {
    const client = new EventEmitter();
    client.initialize = client.close = async () => {};
    client.refuse = () => {};
    client.request = async (method) => {
      assert.equal(method, "model/list");
      return {
        data: [{ model: "fixture", displayName: "검사 모델" }],
        nextCursor: null,
      };
    };
    return client;
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "UX 검사", mode: "group" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const employee = company.createEmployee({
    name: "김검사",
    role: "개발",
    model: "fixture",
    instructions: "테스트 전용",
  });
  const assignment = company.assign(project.id, employee.id);
  const task = app.store.insert("tasks", {
    projectId: project.id,
    assignmentId: assignment.id,
    title: "모델 설정 바꿨으니 계속해줘",
    prompt: "원문 요청 보존",
    status: "review",
    channel: "direct",
    mode: "direct",
    settings: assignment.settings,
    generation: 1,
  });
  const failed = app.store.insert("tasks", {
    projectId: project.id,
    assignmentId: assignment.id,
    title: "모델 오류",
    prompt: "오류 요청",
    status: "failed",
    channel: "direct",
    mode: "direct",
    settings: assignment.settings,
    error: JSON.stringify({
      error: {
        message:
          "The 'bad-model' model is not supported when using Codex with a ChatGPT account.",
      },
    }),
  });
  const result =
    "## 결과 요약\n\n- 랜딩페이지 구현\n- 테스트 통과\n\n`node --check`\n\n[소스 파일](/fixture/index.html)\n\n![외부 이미지](https://example.invalid/tracker.png)";
  app.store.insert("reports", {
    projectId: project.id,
    taskId: task.id,
    title: task.title,
    kind: "result",
    text: result,
  });
  app.store.insert("messages", {
    projectId: project.id,
    taskId: task.id,
    assignmentId: assignment.id,
    sender: "assistant",
    channel: "direct",
    text: result,
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page
    .getByRole("button", { name: "프로젝트 설정", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "이름", exact: true })
    .fill("보존할 초안");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "프로젝트 설정", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "이름", exact: true }),
  ).toHaveValue("보존할 초안");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "직원", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Git 푸시…", exact: true }),
  ).not.toBeVisible();
  await page.locator(".project-actions > summary").click();
  await expect(
    page.getByRole("button", { name: "Git 푸시…", exact: true }),
  ).toBeVisible();
  await page.locator(".project-actions > summary").click();
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page
    .getByRole("button", { name: "직원 모델 설정 확인 →", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "이름", exact: true }),
  ).toHaveValue(employee.name);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^◷ 보고/ }).click();
  await expect(
    page.getByRole("heading", { name: "결과 요약", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".markdown-body ul li")).toHaveCount(2);
  await expect(page.locator(".markdown-body img")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "파일 경로 복사: /fixture/index.html",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "검토 완료", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "업무 결과 검토", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "돌아가기", exact: true }).click();
  await page
    .getByRole("button", { name: "업무 대화 열기 →", exact: true })
    .click();
  await expect(page.locator(".chat-panel")).toHaveClass(/expanded/);
  await page.getByRole("button", { name: "제목 변경", exact: true }).click();
  await page
    .getByRole("textbox", { name: "업무 제목", exact: true })
    .fill("랜딩페이지 제작");
  await page.getByRole("button", { name: "제목 저장", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "업무 대화 선택", exact: true }),
  ).toHaveValue(task.id);
  await expect(
    page.getByRole("button", { name: "제목 변경", exact: true }),
  ).toBeVisible();
  assert.equal(app.store.get("tasks", task.id).title, "랜딩페이지 제작");
  assert.equal(app.store.get("tasks", task.id).prompt, task.prompt);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "업무 대화 선택", exact: true }),
  ).toHaveValue(task.id);
  await page.getByRole("button", { name: "검토 완료", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "업무 결과 검토", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "돌아가기", exact: true }).click();
  await expect(page.locator(".message > .markdown-body").first()).toHaveCSS(
    "background-color",
    "rgb(242, 244, 249)",
  );
  await expect(page.locator(".message > .markdown-body p").first()).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await page.screenshot({ path: join(directory, "desktop-chat.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "작업공간 메뉴", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "프로젝트 선택", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "＋ 프로젝트 시작", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "⌁ 실행 환경", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "⌁ 실행 환경", exact: true }),
  ).toHaveCSS("color", "rgb(52, 67, 95)");
  await page.screenshot({ path: join(directory, "mobile-navigation.png") });
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page
    .getByRole("button", { name: "프로젝트 설정", exact: true })
    .click();
  const save = await page
    .getByRole("button", { name: "설정 저장", exact: true })
    .boundingBox();
  assert.ok(
    save && save.y >= 0 && save.y + save.height <= 844,
    "모바일 저장 버튼은 스크롤 전에도 화면 안에 있어야 한다",
  );
  await page.screenshot({ path: join(directory, "mobile-editor.png") });
  assert.equal(
    app.store.get("assignments", assignment.id).settings.name,
    employee.name,
  );
  assert.equal(app.store.get("tasks", task.id).status, "review");
  assert.equal(app.store.get("tasks", failed.id).status, "failed");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      passed: true,
      modelTurns: 0,
      reviewSubmitted: false,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
