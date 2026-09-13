import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

// 실제 HTTP·Git 작업 격리·실행 큐·브라우저를 사용한다. 제공자 요청/응답만 합성하며 모델/외부 계정은 호출하지 않는다.
class Provider extends EventEmitter {
  replies = [];
  async initialize() {}
  async request(method) {
    if (method === "environment/info")
      return { cwd: pathToFileURL(this.cwd).href };
    if (method === "thread/start") return { thread: { id: "approval-thread" } };
    if (method === "turn/start") return { turn: { id: "approval-turn" } };
    return {};
  }
  reply(id, result) {
    this.replies.push({ id, result });
  }
  refuse(id) {
    this.replies.push({ id, refused: true });
  }
  close() {}
}
const directory = await mkdtemp(join(tmpdir(), "otter-approval-ui-"));
const provider = new Provider();
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: ({ cwd }) => {
    provider.cwd = cwd;
    return provider;
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "승인 검사 회사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "범위 확인",
  });
  const assignment = company.assign(project.id, employee.id);
  const task = company.requestTask({
    projectId: project.id,
    assignmentId: assignment.id,
    prompt: "추가 접근 범위 확인",
  });
  app.runner.pump();
  await expect
    .poll(() => app.runner.active.get(task.id)?.turnId)
    .toBe("approval-turn");
  const profile = {
    fileSystem: {
      read: [join(directory, "검증 자료")],
      write: [join(directory, "검증 결과")],
    },
    network: { enabled: true },
  };
  const params = {
    environmentId: "local",
    threadId: "approval-thread",
    turnId: "approval-turn",
    itemId: "permission",
    cwd: app.store.get("tasks", task.id).worktree.path,
    reason: "추가 검증 자료와 외부 연결이 필요합니다.",
    permissions: profile,
  };
  provider.emit("request", {
    id: 1,
    method: "item/permissions/requestApproval",
    params,
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "◷ 보고" }).click();
  const card = page.locator(".approval-card");
  await expect(
    card.getByText("이번 턴의 추가 접근 권한", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("region", { name: "승인할 접근 범위" }),
  ).toContainText("쓰기·삭제");
  await expect(card).toContainText("특정 호스트로 제한되지 않음");
  assert.equal(provider.replies.length, 0);
  await page.screenshot({
    path: join(directory, "permission-desktop.png"),
    fullPage: true,
  });
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await card.getByRole("button", { name: "이번 턴에만 권한 허용" }).click();
  await expect.poll(() => provider.replies.length).toBe(1);
  assert.deepEqual(provider.replies[0], {
    id: 1,
    result: { permissions: profile, scope: "turn" },
  });
  await expect(card).toHaveCount(0);

  provider.emit("request", {
    id: 2,
    method: "item/commandExecution/requestApproval",
    params: {
      ...params,
      permissions: undefined,
      networkApprovalContext: {
        host: "example.invalid:443",
        protocol: "https",
      },
    },
  });
  await expect(
    card.getByText("네트워크 접근 승인", { exact: true }),
  ).toBeVisible();
  await expect(card).toContainText("example.invalid:443");
  await expect(card).toContainText("여러 네트워크 요청");
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByRole("button", { name: "거절" }).scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(directory, "network-mobile.png"),
    fullPage: true,
  });
  await card.getByRole("button", { name: "거절" }).click();
  await expect.poll(() => provider.replies.length).toBe(2);
  assert.deepEqual(provider.replies[1].result, { decision: "decline" });
  await expect(card).toHaveCount(0);

  provider.emit("request", {
    id: 3,
    method: "item/commandExecution/requestApproval",
    params: {
      ...params,
      permissions: undefined,
      command: "run unknown command",
      availableDecisions: ["acceptForSession", "cancel"],
    },
  });
  await expect(
    card.getByRole("button", { name: "이번 요청 승인" }),
  ).toBeDisabled();
  await expect(card.getByRole("alert")).toBeVisible();
  await card.getByRole("button", { name: "거절" }).click();
  await expect.poll(() => provider.replies.length).toBe(3);
  assert.deepEqual(provider.replies[2].result, { decision: "cancel" });
  await expect(card).toHaveCount(0);
  const commandParams = {
    ...params,
    permissions: undefined,
    command: "/bin/bash -lc 'pwd && git status --short'",
    kind: "command",
    availableDecisions: [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["pwd"] } },
      "cancel",
    ],
  };
  provider.emit("request", {
    id: 4,
    method: "item/commandExecution/requestApproval",
    params: commandParams,
  });
  await expect(card).toContainText("직원 작업 폴더 연결을 확인했습니다");
  await expect(
    card.getByRole("button", { name: "이번 요청 승인" }),
  ).toBeEnabled();
  assert.equal(provider.replies.length, 3);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await card.screenshot({ path: join(directory, "local-command-mobile.png") });
  await card.getByRole("button", { name: "이번 요청 승인" }).click();
  await expect.poll(() => provider.replies.length).toBe(4);
  assert.deepEqual(provider.replies[3], {
    id: 4,
    result: { decision: "accept" },
  });
  await expect(card).toHaveCount(0);
  provider.emit("request", {
    id: 5,
    method: "item/commandExecution/requestApproval",
    params: { ...commandParams, environmentId: "unknown-remote" },
  });
  await expect(
    card.getByRole("button", { name: "이번 요청 승인" }),
  ).toBeDisabled();
  await expect(card.getByRole("alert")).toBeVisible();
  const unknown = app.store.all("approvals").find((a) => a.requestId === 5);
  assert.throws(
    () =>
      app.runner.approve(unknown.id, {
        decision: "accept",
        scopeConfirmed: true,
      }),
    /안전하게/,
  );
  assert.equal(provider.replies.length, 4);
  await card.getByRole("button", { name: "거절" }).click();
  await expect.poll(() => provider.replies.length).toBe(5);
  assert.deepEqual(provider.replies[4].result, { decision: "cancel" });
  provider.emit("notification", {
    method: "item/started",
    params: {
      threadId: params.threadId,
      turnId: params.turnId,
      item: {
        id: "files",
        type: "fileChange",
        changes: [
          {
            path: join(params.cwd, "index.html"),
            kind: "add",
            diff: "<p>전체 변경 내용</p>\n".repeat(500),
          },
        ],
      },
    },
  });
  provider.emit("request", {
    id: 6,
    method: "item/fileChange/requestApproval",
    params: {
      ...params,
      itemId: "files",
      permissions: undefined,
    },
  });
  await page.getByRole("button", { name: /▦ 사무실/ }).click();
  await page.getByRole("button", { name: "대화 크게 보기" }).click();
  await expect(page.locator("main")).toBeHidden();
  await expect(card).toContainText("파일 변경 1개");
  await page.getByRole("button", { name: "대기 요청 1개 읽기 ↑" }).click();
  const topVisible = await card.evaluate((element) => {
    const parent = element.closest(".chat-messages");
    return (
      element.getBoundingClientRect().top >=
        parent.getBoundingClientRect().top &&
      element.getBoundingClientRect().top <
        parent.getBoundingClientRect().bottom
    );
  });
  assert.ok(topVisible, "요청 읽기는 승인 카드 시작점을 보여준다");
  const details = card.locator(".approval-files details");
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click();
  const diff = details.locator("pre");
  await expect(diff).toBeVisible();
  const dimensions = await diff.evaluate((element) => ({
    height: element.clientHeight,
    content: element.scrollHeight,
  }));
  assert.ok(dimensions.height <= 240 && dimensions.content > dimensions.height);
  assert.equal(provider.replies.length, 5, "변경 내용 확인은 승인이 아니다");
  await details.locator("summary").click();
  await card.screenshot({ path: join(directory, "files-mobile.png") });
  await card.getByRole("button", { name: "이번 요청 승인" }).click();
  await expect.poll(() => provider.replies.length).toBe(6);
  assert.deepEqual(provider.replies[5], {
    id: 6,
    result: { decision: "accept" },
  });
  await page.getByRole("button", { name: "사무실 함께 보기" }).click();
  await expect(page.locator("main")).toBeVisible();
  assert.equal(
    app.store.all("approvals").filter((a) => a.status === "pending").length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      status: "passed",
      checks: [
        "권한 범위·현재 턴 안내",
        "체크박스 없이 명시적 승인 클릭 전 미승인",
        "요청한 권한만 전달",
        "호스트 안내·거절",
        "영구 승인 미지원",
        "확인된 local 명령의 일회성 승인·미확인 환경 차단",
        "모바일",
        "파일 목록 접기·전체 변경 내용 보존·대화 확대/복귀",
      ],
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
