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

// UI용 업무 상태/질문 자료를 사용한다. 실행·모델 협업 성공을 증명하는 검사가 아니다.
const directory = await mkdtemp(join(tmpdir(), "otter-office-ui-"));
let calls = 0;
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: () => {
    calls++;
    throw new Error("모델 실행 금지");
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({
    name: "로그인 스튜디오",
    mode: "single",
  });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
    name: "메신저 서비스",
  });
  const tasks = [];
  for (const [name, role, status, prompt] of [
    [
      "김코딩",
      "백엔드 개발",
      "waiting",
      "카카오 로그인 API와 세션 저장 방식을 결정합니다",
    ],
    ["박리뷰", "코드 리뷰", "review", "회원가입 화면과 접근성 검토 결과"],
    ["이테스트", "테스트", "failed", "인증 서버 연결 테스트"],
    ["최기획", "기획", "completed", "로그인 요구사항 정리"],
    ["정PM", "프로젝트 관리", "running", "화면·API·테스트 담당자 업무 조율"],
  ]) {
    const employee = company.createEmployee({
      name,
      role,
      instructions: "UI 검사 자료",
    });
    const assignment = company.assign(project.id, employee.id);
    const task = company.requestTask({
      projectId: project.id,
      assignmentId: assignment.id,
      prompt,
    });
    app.store.update("tasks", task.id, { status });
    tasks.push(task);
  }
  const extra = company.requestTask({
    projectId: project.id,
    assignmentId: tasks[0].assignmentId,
    prompt: "다음 API 개발",
  });
  app.store.update("tasks", extra.id, { status: "running" });
  app.store.update("tasks", tasks[2].id, {
    error: "인증 서버에 연결하지 못했습니다. 테스트를 통과하지 않았습니다.",
  });
  for (const [taskId, kind, title, text] of [
    [tasks[2].id, "progress", "테스트 준비 기록", "검사 환경을 준비했습니다"],
    [
      tasks[2].id,
      "blocker",
      "인증 연결 실패 보고",
      "실제 서버의 연결을 확인해야 합니다",
    ],
    [tasks[3].id, "result", "기획 정리 결과", "요구사항 문서 작성 보고"],
    [
      null,
      "deployment",
      "프로젝트 배포 기록",
      "명령 종료와 서비스 성공은 별개입니다",
    ],
  ])
    app.store.insert("reports", {
      projectId: project.id,
      taskId,
      kind,
      title,
      text,
    });
  const otherCompany = company.createCompany({
    name: "다른 회사",
    mode: "single",
  });
  const otherProject = await company.addProject({
    companyId: otherCompany.id,
    create: true,
    parent: directory,
    folder: "other",
    name: "다른 프로젝트",
  });
  app.store.insert("reports", {
    projectId: otherProject.id,
    kind: "progress",
    title: "다른 프로젝트 보고",
    text: "범위 분리 확인",
  });
  for (const [task, question] of [
    [tasks[0], "세션을 어디에 저장할까요?"],
    [extra, "API 이름을 확인해 주세요"],
  ]) {
    app.store.insert("approvals", {
      projectId: project.id,
      taskId: task.id,
      method: "item/tool/requestUserInput",
      status: "pending",
      params: { questions: [{ id: "choice", header: "설계 결정", question }] },
    });
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  const floor = page.locator(".office-floor");
  await expect(
    floor.getByRole("button", { name: "이테스트, 실패, 대화 열기" }),
  ).toBeVisible();
  await expect(
    floor.getByRole("button", { name: "최기획, 완료, 대화 열기" }),
  ).toBeVisible();
  await floor
    .locator(".speech")
    .filter({ hasText: "인증 서버 연결 테스트" })
    .click();
  const context = page.getByRole("region", { name: "선택한 업무 상태" });
  await expect(context).toContainText("업무 상태 · 실패");
  await context.getByText("확인할 내용", { exact: true }).click();
  await expect(context).toContainText("테스트를 통과하지 않았습니다");
  await page
    .getByRole("textbox", { name: "직원에게 업무 요청" })
    .fill("보고를 읽고 이어갈 초안");
  await context.getByRole("button", { name: "관련 보고 2개 보기 →" }).click();
  await expect(page.getByLabel("업무 범위")).toHaveValue(tasks[2].id);
  await expect(page.locator(".report-card")).toHaveCount(2);
  await expect(
    page.getByText("보고 2개 / 전체 4개", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("보고 종류").selectOption("blocker");
  await expect(page.locator(".report-card")).toHaveCount(1);
  await page.getByLabel("보고 검색").fill("없는 내용");
  await expect(page.locator(".report-card")).toHaveCount(0);
  await page.getByLabel("보고 검색").fill("");
  await page.screenshot({
    path: join(directory, "reports-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(directory, "reports-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "업무 대화로 돌아가기 →" }).click();
  await expect(
    page.getByRole("textbox", { name: "직원에게 업무 요청" }),
  ).toHaveValue("보고를 읽고 이어갈 초안");
  await context.getByRole("button", { name: "관련 보고 2개 보기 →" }).click();
  await page.getByRole("button", { name: "전체 보고 보기" }).click();
  await expect(page.locator(".report-card")).toHaveCount(4);
  await page.getByLabel("보고 검색").fill("최기획");
  await expect(
    page.getByRole("heading", { name: "기획 정리 결과" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(otherProject.id);
  await expect(page.locator(".report-card")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "다른 프로젝트 보고" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(project.id);
  await page.getByRole("button", { name: "▦ 사무실" }).click();
  await floor.getByText(/질문·승인·검토 대기 3개/).click();
  await floor
    .locator(".office-attention")
    .getByRole("button", { name: /김코딩.*카카오 로그인/ })
    .click();
  const thread = page.getByRole("combobox", { name: "업무 대화 선택" });
  await expect(thread).toHaveValue(tasks[0].id);
  await expect(page.getByLabel("세션을 어디에 저장할까요?")).toBeVisible();
  await expect(page.getByLabel("API 이름을 확인해 주세요")).toHaveCount(0);
  await thread.selectOption(extra.id);
  await expect(page.getByLabel("API 이름을 확인해 주세요")).toBeVisible();
  await floor
    .locator(".office-attention")
    .getByRole("button", { name: /김코딩.*카카오 로그인/ })
    .click();
  await expect(thread).toHaveValue(tasks[0].id);
  await expect(page.getByLabel("세션을 어디에 저장할까요?")).toBeVisible();
  await floor.locator(".speech").filter({ hasText: "다음 API 개발" }).click();
  await expect(thread).toHaveValue(extra.id);
  await page.screenshot({
    path: join(directory, "office-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await floor.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(directory, "office-mobile.png"),
    fullPage: true,
  });
  await floor.locator(".speech").filter({ hasText: "다음 API 개발" }).click();
  await expect(thread).toBeFocused();
  await expect(thread).toBeInViewport();
  await expect(thread).toHaveValue(extra.id);
  // 로컬 실행부 연결 실패 시 캐시를 실행 중 화면처럼 애니메이션하지 않는다.
  await page.route("**/api/state**", (route) => route.abort());
  await expect(floor).toHaveAttribute("data-stale", "true", { timeout: 20000 });
  await expect(floor.getByText("마지막 확인 상태 · 연결 필요")).toBeVisible();
  assert.equal(
    await floor
      .locator(".station.running .avatar")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.equal(calls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      source: "UI fixtures",
      taskNavigation: true,
      reportNavigation: true,
      staleAnimationStopped: true,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
