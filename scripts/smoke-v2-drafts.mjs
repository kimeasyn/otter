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

// 실제 HTTP/SQLite/브라우저 저장소를 검사한다. 업무 큐 실행은 멈추며 모델을 호출하지 않는다.
const directory = await mkdtemp(join(tmpdir(), "otter-drafts-ui-"));
const app = await startServer({ directory, port: 0 });
app.runner.pump = () => {};
const company = new Company(app.store);
let browser;
const releases = [];
try {
  const org = company.createCompany({ name: "초안 검사 회사", mode: "group" });
  const a = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "alpha",
    name: "알파 프로젝트",
  });
  const b = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "beta",
    name: "베타 프로젝트",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "초안 검사",
    skills: "",
  });
  const reviewer = company.createEmployee({
    name: "박리뷰",
    role: "리뷰",
    instructions: "초안 검사",
    skills: "",
  });
  const member = company.assign(a.id, employee.id);
  company.assign(a.id, reviewer.id);
  company.assign(b.id, employee.id);
  const task = company.requestTask({
    projectId: a.id,
    assignmentId: member.id,
    prompt: "기존 업무 대화",
  });
  app.store.update("tasks", task.id, { status: "review" });
  const doc = app.store.all("documents", a.id)[0];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const holdNext = async (path) => {
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    releases.push(release.resolve);
    await page.route(
      path,
      async (route) => {
        const response = await route.fetch();
        ready.resolve();
        await release.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    return { ready: ready.promise, release: release.resolve };
  };
  await page.goto(app.origin);
  const project = page.getByRole("combobox", { name: "프로젝트 선택" });
  await project.selectOption(a.id);
  const chat = page.getByRole("textbox", { name: "직원에게 업무 요청" });
  await chat.fill("알파 김코딩의 미전송 요청");
  await page
    .getByRole("combobox", { name: "요청 방식" })
    .selectOption("delegate");
  await page
    .getByRole("button", { name: /박리뷰, 업무 없음, 대화 열기/ })
    .click();
  await expect(chat).toHaveValue("");
  await chat.fill("알파 박리뷰의 요청");
  await page.getByRole("button", { name: /김코딩,.*대화 열기/ }).click();
  await expect(chat).toHaveValue("알파 김코딩의 미전송 요청");
  await expect(page.getByRole("combobox", { name: "요청 방식" })).toHaveValue(
    "delegate",
  );
  await project.selectOption(b.id);
  await expect(chat).toHaveValue("");
  await chat.fill("베타 김코딩의 요청");
  await project.selectOption(a.id);
  await expect(chat).toHaveValue("알파 김코딩의 미전송 요청");
  const thread = page.getByRole("combobox", { name: "업무 대화 선택" });
  await thread.selectOption(task.id);
  await expect(chat).toHaveValue("");
  await chat.fill("기존 업무에서 이어갈 내용");
  await thread.selectOption("");
  await expect(chat).toHaveValue("알파 김코딩의 미전송 요청");
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(chat).toHaveValue("");
  await chat.fill("프로젝트 대화의 초안");
  await page.getByRole("button", { name: "1:1", exact: true }).click();
  await expect(chat).toHaveValue("알파 김코딩의 미전송 요청");
  await page.getByRole("button", { name: "▤ 문서·지침" }).click();
  const editor = page
    .locator(".document-editor")
    .filter({ has: page.getByRole("heading", { name: "목표", exact: true }) });
  const content = editor.getByRole("textbox");
  await content.fill("아직 반영하지 않은 목표");
  await page.getByRole("button", { name: "▦ 사무실" }).click();
  await expect(chat).toHaveValue("알파 김코딩의 미전송 요청");
  await page.reload();
  await project.selectOption(a.id);
  await expect(chat).toHaveValue("알파 김코딩의 미전송 요청");
  await page.getByRole("button", { name: "▤ 문서·지침" }).click();
  await expect(content).toHaveValue("아직 반영하지 않은 목표");
  assert.equal(app.store.get("documents", doc.id).content, "");
  assert.equal(app.store.all("tasks").length, 1);
  company.editDocument(doc.id, {
    ...doc,
    content: "다른 곳에서 먼저 저장한 목표",
  });
  await editor
    .getByText("다른 변경이 먼저 저장되었습니다.", { exact: false })
    .waitFor();
  await expect(
    editor.getByRole("button", { name: "변경 저장" }),
  ).toBeDisabled();
  await expect(content).toHaveValue("아직 반영하지 않은 목표");
  await page.screenshot({
    path: join(directory, "document-conflict.png"),
    fullPage: true,
  });
  await editor
    .getByRole("button", { name: "내 편집을 새 변경안으로 유지" })
    .click();
  const saving = await holdNext(`**/api/documents/${doc.id}/edit`);
  await editor.getByRole("button", { name: "변경 저장" }).click();
  await saving.ready;
  await content.fill("저장 응답을 기다리며 추가한 내용");
  saving.release();
  await expect(editor.getByRole("button", { name: "변경 저장" })).toBeEnabled();
  await expect(content).toHaveValue("저장 응답을 기다리며 추가한 내용");
  assert.equal(
    app.store.get("documents", doc.id).content,
    "아직 반영하지 않은 목표",
  );
  await editor.getByRole("button", { name: "변경 저장" }).click();
  await editor.getByRole("button", { name: "저장됨 ✓" }).waitFor();
  assert.equal(
    app.store.get("documents", doc.id).content,
    "저장 응답을 기다리며 추가한 내용",
  );

  await page.getByRole("button", { name: "▦ 사무실" }).click();
  const sending = await holdNext("**/api/tasks");
  await page.getByRole("button", { name: "업무 요청 보내기" }).click();
  await sending.ready;
  await chat.fill("응답 도착 전에 쓴 다음 요청");
  sending.release();
  await expect(
    page.getByRole("button", { name: "업무 요청 보내기" }),
  ).toBeEnabled();
  await expect(chat).toHaveValue("응답 도착 전에 쓴 다음 요청");
  await expect(thread).toHaveValue("");
  assert.equal(app.store.all("tasks").length, 2);
  assert.equal(
    app.store
      .all("tasks")
      .filter((t) => t.prompt === "알파 김코딩의 미전송 요청").length,
    1,
  );
  // 응답 중 대화 대상을 바꿔도 새 대상의 초안/선택을 덮어쓰지 않는다.
  const switched = await holdNext("**/api/tasks");
  await page.getByRole("button", { name: "업무 요청 보내기" }).click();
  await switched.ready;
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(chat).toHaveValue("프로젝트 대화의 초안");
  switched.release();
  await expect(
    page.getByRole("button", { name: "업무 요청 보내기" }),
  ).toBeEnabled();
  await expect(thread).toHaveValue("");
  await expect(chat).toHaveValue("프로젝트 대화의 초안");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "초안 버리기" }).click();
  await expect(chat).toHaveValue("프로젝트 대화의 초안");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "초안 버리기" }).click();
  await expect(chat).toHaveValue("");
  assert.equal(app.store.all("tasks").length, 3);
  await page.getByRole("button", { name: "1:1", exact: true }).click();
  await thread.selectOption(task.id);
  await expect(chat).toHaveValue("기존 업무에서 이어갈 내용");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(directory, "chat-draft-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    `초안 이동·새로고침·격리·충돌·늦은 응답·폐기 검사 통과: ${directory}`,
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await app.close();
}
