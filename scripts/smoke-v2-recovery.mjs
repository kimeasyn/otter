import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { DomainError } from "../apps/worker/src/store.mjs";
import { Remote } from "../apps/worker/src/remote.mjs";

// SSH 전송만 대체한다. 별도 원격 실행부/SQLite/Git은 실제로 사용하며 모델은 호출하지 않는다.
const directory = await mkdtemp(join(tmpdir(), "otter-recovery-ui-"));
const options = {
  directory: join(directory, "controller"),
  port: 0,
  makeRemote: (environment) =>
    new Remote(environment, {
      launch: (_command, _args, settings) =>
        spawn(
          process.execPath,
          [
            new URL("../apps/worker/src/remote-bootstrap.mjs", import.meta.url)
              .pathname,
          ],
          settings,
        ),
    }),
};
let app = await startServer(options),
  browser,
  environment;
try {
  const company = new Company(app.store).createCompany({
    name: "복구 회사",
    mode: "group",
  });
  environment = app.environments.add({
    name: "원격 작업실",
    kind: "ssh",
    host: "test.invalid",
    directory: join(directory, "remote"),
    slots: 1,
  });
  await app.environments.connect(environment.id);
  const original = app.environments.forward.bind(app.environments);
  app.environments.forward = async (...args) => {
    await original(...args);
    throw new DomainError("합성 원격 응답 유실", 504);
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  const id = randomUUID();
  const post = (key, folder) =>
    page.evaluate(
      async ({ key, folder, environmentId, companyId, parent }) => {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "X-Otter-Environment": environmentId,
          },
          body: JSON.stringify({ companyId, create: true, parent, folder }),
        });
        return response.status;
      },
      {
        key,
        folder,
        environmentId: environment.id,
        companyId: company.id,
        parent: directory,
      },
    );
  assert.equal(await post(id, "first"), 504);
  const recovery = page.locator(".request-recovery");
  await recovery.getByText("처리 여부 미확인", { exact: true }).waitFor();
  await page.reload();
  await recovery.getByText("처리 여부 미확인", { exact: true }).waitFor();
  await app.close();
  app = await startServer(options);
  await app.environments.connect(environment.id);
  await page.goto(app.origin);
  await recovery.getByText("처리 여부 미확인", { exact: true }).waitFor();
  await recovery.getByRole("button", { name: "처리 결과 조회" }).click();
  await recovery.getByText(/^처리 응답을 확인했습니다/).waitFor();
  assert.equal(
    (await app.environments.client(environment.id).request("GET", "/api/state"))
      .data.projects.length,
    1,
  );
  await recovery.getByText("원래 요청 확인", { exact: true }).click();
  await page.screenshot({
    path: join(directory, "recovered.png"),
    fullPage: true,
  });
  await recovery
    .getByRole("button", { name: "확인했어요 · 복구 목록에서 닫기" })
    .click();
  await recovery.waitFor({ state: "hidden" });
  const forwarding = app.environments.forward.bind(app.environments);
  app.environments.forward = async () => {
    throw new DomainError("합성 전달 전 연결 실패", 504);
  };
  const nextId = randomUUID();
  assert.equal(await post(nextId, "second"), 504);
  app.environments.forward = forwarding;
  await recovery.getByRole("button", { name: "처리 결과 조회" }).click();
  await recovery.getByRole("button", { name: "동일 요청 다시 전달" }).waitFor();
  page.once("dialog", (dialog) => dialog.dismiss());
  await recovery.getByRole("button", { name: "동일 요청 다시 전달" }).click();
  assert.equal(
    (await app.environments.client(environment.id).request("GET", "/api/state"))
      .data.projects.length,
    1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(directory, "recovery-mobile.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await recovery.getByRole("button", { name: "동일 요청 다시 전달" }).click();
  await recovery.getByText(/^처리 응답을 확인했습니다/).waitFor();
  assert.equal(
    (await app.environments.client(environment.id).request("GET", "/api/state"))
      .data.projects.length,
    2,
  );
  await recovery
    .getByRole("button", { name: "확인했어요 · 복구 목록에서 닫기" })
    .click();
  await recovery.waitFor({ state: "hidden" });
  // 로컬 업무 접수 후 브라우저 응답을 버린다. 실제 HTTP/DB만 검사하고 업무 실행은 막는다.
  await page.setViewportSize({ width: 1440, height: 1000 });
  app.runner.pump = () => {};
  const local = new Company(app.store);
  const project = await local.addProject({
    companyId: company.id,
    create: true,
    parent: directory,
    folder: "local-project",
    name: "로컬 복구 프로젝트",
  });
  const employee = local.createEmployee({
    name: "로컬 김코딩",
    role: "개발",
    instructions: "복구 검사",
  });
  const assignment = local.assign(project.id, employee.id);
  await page.reload();
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(project.id);
  const prompt = "응답을 잃어도 이 업무는 하나만 생성";
  const chat = page.getByRole("textbox", { name: "직원에게 업무 요청" });
  await chat.fill(prompt);
  let localId;
  await page.route(
    "**/api/tasks",
    async (route) => {
      localId = route.request().headers()["idempotency-key"];
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "업무 요청 보내기" }).click();
  await recovery.getByText(/^처리 응답을 확인했습니다/).waitFor();
  assert.ok(localId);
  await page.reload();
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption(project.id);
  await expect(chat).toHaveValue(prompt);
  await recovery.getByText(/^처리 응답을 확인했습니다/).waitFor();
  const input = {
    projectId: project.id,
    assignmentId: assignment.id,
    prompt,
    mode: "direct",
    channel: "direct",
  };
  const repeat = (id) =>
    page.evaluate(
      async ({ id, input }) => {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": id,
          },
          body: JSON.stringify(input),
        });
        return { status: response.status, data: await response.json() };
      },
      { id, input },
    );
  assert.equal((await repeat(randomUUID())).status, 409);
  assert.equal(app.store.all("tasks").length, 1);
  const originalTask = app.store.all("tasks")[0];
  app.store.update("tasks", originalTask.id, { status: "blocked" });
  await app.close();
  app = await startServer(options);
  app.runner.pump = () => {};
  await app.environments.connect(environment.id);
  await page.goto(app.origin);
  await recovery.getByText(/^처리 응답을 확인했습니다/).waitFor();
  assert.equal((await repeat(randomUUID())).status, 409);
  assert.equal((await repeat(localId)).data.id, originalTask.id);
  assert.equal(app.store.all("tasks").length, 1);
  await page
    .getByRole("combobox", { name: "프로젝트 선택" })
    .selectOption({ label: "first · 원격 작업실" });
  await recovery
    .getByRole("button", { name: "업무 대화 열기", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "프로젝트 선택" }),
  ).toHaveValue(project.id);
  await expect(
    page.getByRole("combobox", { name: "업무 대화 선택" }),
  ).toHaveValue(originalTask.id);
  await recovery.getByText("원래 요청 확인", { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: join(directory, "local-recovered.png"),
    fullPage: true,
  });
  await recovery
    .getByRole("button", { name: "확인했어요 · 복구 목록에서 닫기" })
    .click();
  await recovery.waitFor({ state: "hidden" });
  assert.equal(app.store.all("tasks").length, 1);
  assert.deepEqual(errors, []);
  console.log(
    "통과: 원격 응답 유실 → 화면/앱 재시작 → 결과 조회 복구 → 미접수 재전달 취소/승인 → 중복 없음. 실제 모델 미사용.",
  );
  console.log("증거: " + directory);
  console.log(
    "로컬: 실제 접수 후 브라우저 응답 유실·탭 새로고침·실행부 재시작·새 ID 중복 차단·원래 ID 결과 복구·확인 후 목록 닫기 통과. 업무 큐 실행/모델 호출 없음.",
  );
} finally {
  await browser?.close();
  if (environment) await app.environments.stop(environment.id).catch(() => {});
  await app.close();
}
