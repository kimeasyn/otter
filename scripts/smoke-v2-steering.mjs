import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

// HTTP/SQLite/Git/실행 큐는 실제 구현, Codex 연결만 검사 대역이다. 모델은 호출하지 않는다.
const directory = await mkdtemp(join(tmpdir(), "otter-steering-ui-"));
let mode = "accept",
  starts = 0,
  steers = 0;
class Provider extends EventEmitter {
  async initialize() {}
  async request(method, input) {
    if (method === "thread/start") return { thread: { id: "fixture-thread" } };
    if (method === "turn/start") {
      starts++;
      return { turn: { id: "fixture-turn" } };
    }
    if (method === "turn/steer") {
      steers++;
      if (mode === "unknown") throw new Error("합성 응답 단절");
      return { turnId: input.expectedTurnId };
    }
  }
  close() {}
}
const app = await startServer({
  directory,
  port: 0,
  makeCodex: () => new Provider(),
});
let browser, controller;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "추가 지시 검사", mode: "single" });
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
    prompt: "로그인 구현",
    channel: "project",
  });
  app.runner.pump();
  await expect
    .poll(() => app.store.get("tasks", task.id).providerTurnId)
    .toBe("fixture-turn");
  const initial = app.store.get("tasks", task.id);
  const file = join(initial.worktree.path, "keep.txt");
  await writeFile(file, "원래 작업 파일");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page.getByRole("button", { name: "대화 열기 →", exact: true }).click();
  const input = page.getByRole("textbox", { name: "직원에게 업무 요청" });
  const send = page.getByRole("button", {
    name: "현재 실행에 추가 지시 보내기",
  });
  const endpoint = `${app.origin}/api/tasks/${task.id}/steer`;
  await input.fill("테스트부터 확인해줘");
  let response = page.waitForResponse((r) => r.url() === endpoint);
  await send.click();
  const first = await response;
  assert.equal(first.status(), 200);
  const firstMessage = await first.json();
  assert.equal(firstMessage.delivery, "delivered");
  const replay = await page.request.post(endpoint, {
    headers: {
      "idempotency-key": first.request().headers()["idempotency-key"],
    },
    data: first.request().postDataJSON(),
  });
  assert.equal((await replay.json()).id, firstMessage.id);
  assert.equal(steers, 1);
  // SSH 전송만 HTTP 검사 다리로 대체한다. 컨트롤러의 전달/접수 기록과 대상 DB는 분리한다.
  controller = await startServer({
    directory: join(directory, "controller"),
    port: 0,
    makeCodex: () => {
      throw new Error("컨트롤러에서 모델 실행 금지");
    },
  });
  const environment = controller.store.insert("environments", {
    name: "원격 전달 검사",
    kind: "ssh",
    slots: 1,
    allocated: true,
    workerId: app.store.metadata("workerId"),
  });
  controller.environments.clients.set(environment.id, {
    health: { workerId: environment.workerId },
    disconnect() {},
    async request(method, path, data, key) {
      const response = await fetch(app.origin + path, {
        method,
        headers: {
          authorization: "Bearer " + app.token,
          "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: response.status, data: await response.json() };
    },
  });
  const remoteInput = {
    ...first.request().postDataJSON(),
    prompt: "원격으로 추가 지시",
  };
  const remoteHeaders = {
    authorization: "Bearer " + controller.token,
    "content-type": "application/json",
    "x-otter-environment": environment.id,
    "idempotency-key": "remote-steering-once",
  };
  for (let repeat = 0; repeat < 2; repeat++) {
    const remoteResponse = await fetch(
      `${controller.origin}/api/tasks/${task.id}/steer`,
      {
        method: "POST",
        headers: remoteHeaders,
        body: JSON.stringify(remoteInput),
      },
    );
    assert.equal(remoteResponse.status, 200);
    const result = await remoteResponse.json();
    assert.equal(result.delivery, "delivered");
    assert.equal(result.taskId, task.id);
  }
  assert.equal(steers, 2);
  assert.equal(controller.store.all("tasks").length, 0);
  assert.equal(controller.store.all("messages").length, 0);
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "업무 대화 선택" }),
  ).toHaveValue(task.id);
  // 실행 회차가 접수 직전에 바뀌면 새 회차에 전달하지 않는다.
  await page.route(endpoint, async (route) => {
    app.store.update("tasks", task.id, { generation: initial.generation + 1 });
    await route.continue();
  });
  await input.fill("오래된 실행에 보내려던 내용");
  response = page.waitForResponse((r) => r.url() === endpoint);
  await send.click();
  assert.equal((await response).status(), 409);
  assert.equal(steers, 2);
  await expect(input).toHaveValue("오래된 실행에 보내려던 내용");
  await page.unroute(endpoint);
  app.store.update("tasks", task.id, { generation: initial.generation });
  // 제공자에 전달했는지 모르는 경우에는 메시지에 남기고 전송을 막는다.
  mode = "unknown";
  await input.fill("응답을 잃은 추가 지시");
  // 화면이 실제 현재 회차를 다시 읽을 때까지 기다린다.
  await expect
    .poll(async () => {
      const r = await page.request.get(
        `${app.origin}/api/state?projectId=${project.id}`,
      );
      return (await r.json()).tasks[0].generation;
    })
    .toBe(initial.generation);
  await page.reload();
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page.getByRole("button", { name: "대화 열기 →", exact: true }).click();
  response = page.waitForResponse((r) => r.url() === endpoint);
  await send.click();
  assert.equal((await response).status(), 200);
  await expect(
    page.getByText(/전달 여부 미확인 · 자동 재전송 안 함/),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("자동으로 보내면 안 되는 초안");
  await expect(
    page.getByRole("button", { name: "업무 요청 보내기", exact: true }),
  ).toBeDisabled();
  const unconfirmed = app.store
    .all("messages")
    .find((m) => m.delivery === "unconfirmed");
  assert.ok(unconfirmed);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page
    .locator(".chat-panel")
    .screenshot({ path: join(directory, "steering-mobile.png") });
  assert.equal(starts, 1);
  assert.equal(steers, 3);
  assert.equal(app.store.all("tasks").length, 1);
  assert.deepEqual(app.store.get("tasks", task.id).worktree, initial.worktree);
  assert.equal(await readFile(file, "utf8"), "원래 작업 파일");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      sameRun: true,
      sameReceiptOnce: true,
      staleRejected: true,
      uncertainBlocked: true,
      filesPreserved: true,
      provider: "stub",
      remoteForwardOnce: true,
    }),
  );
} finally {
  await browser?.close();
  await controller?.close();
  await app.close();
}
