import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { isolatedWorktree, git } from "../apps/worker/src/git.mjs";

// 실제 Git/HTTP 경로 확인. 네이티브 IDE 연결만 기록하는 대체 함수를 사용한다.
const directory = await mkdtemp(join(tmpdir(), "otter-editor-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
});
app.runner.pump = () => {};
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "IDE 검사 회사", mode: "group" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "프로젝트",
    name: "코드 없이 개발",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "범위 내 작업",
  });
  const assignment = company.assign(project.id, employee.id);
  const task = company.requestTask({
    projectId: project.id,
    assignmentId: assignment.id,
    prompt: "결과 확인할 업무",
  });
  const worktree = await isolatedWorktree(
    project.root,
    join(directory, "작업 # & ' 한글"),
    task.id,
  );
  app.store.update("tasks", task.id, { worktree, status: "review" });
  await writeFile(join(worktree.path, "작업.txt"), "커밋하지 않은 직원 결과");
  const before = await git(worktree.path, ["status", "--porcelain"]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.editorCalls = [];
    window.otter = {
      pickFolder: async () => null,
      openEditor: async (input) => {
        window.editorCalls.push(input);
        return { launched: true };
      },
    };
  });
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "외부 IDE에서 열기", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "프로젝트 원본 열기" });
  await expect(
    dialog.getByRole("textbox", { name: "실제로 열 폴더" }),
  ).toHaveValue(project.root);
  await dialog
    .getByRole("button", { name: "VS Code 열기", exact: true })
    .click();
  await dialog.getByText(/^VS Code 실행 요청을 전달했습니다/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.editorCalls[0]), {
    projectId: project.id,
    taskId: undefined,
    environmentId: "local",
    sshHost: "",
    chooseExecutable: false,
  });
  await dialog.getByRole("button", { name: "닫기" }).click();
  await page.getByRole("button", { name: "☷ 업무" }).click();
  await page.getByRole("button", { name: "작업 폴더 IDE로 열기" }).click();
  const taskDialog = page.getByRole("dialog", { name: "직원 작업 폴더 열기" });
  await expect(
    taskDialog.getByRole("textbox", { name: "실제로 열 폴더" }),
  ).toHaveValue(worktree.path);
  await taskDialog
    .getByRole("checkbox", { name: "VS Code 실행 파일 다시 선택" })
    .check();
  await taskDialog
    .getByRole("button", { name: "VS Code 열기", exact: true })
    .click();
  await taskDialog.getByText(/^VS Code 실행 요청을 전달했습니다/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.editorCalls[1]), {
    projectId: project.id,
    taskId: task.id,
    environmentId: "local",
    sshHost: "",
    chooseExecutable: true,
  });
  await page.screenshot({
    path: join(directory, "task-editor.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.otter.openEditor = async () => {
      throw new Error("합성 IDE 실행 실패");
    };
  });
  await taskDialog
    .getByRole("button", { name: "VS Code 열기", exact: true })
    .click();
  await taskDialog
    .getByRole("alert")
    .filter({ hasText: "합성 IDE 실행 실패" })
    .waitFor();
  await expect(
    taskDialog.getByRole("textbox", { name: "실제로 열 폴더" }),
  ).toHaveValue(worktree.path);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(directory, "editor-mobile.png"),
    fullPage: true,
  });
  await taskDialog.getByRole("button", { name: "닫기" }).click();
  await page.evaluate(() => {
    delete window.otter;
  });
  await page.getByRole("button", { name: "작업 폴더 IDE로 열기" }).click();
  await taskDialog.getByText(/브라우저에서는 경로를 복사/).waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    }),
  );
  await taskDialog.getByRole("button", { name: "폴더 경로 복사" }).click();
  await taskDialog
    .getByRole("alert")
    .filter({ hasText: "위 경로를 선택해 직접 복사" })
    .waitFor();
  await expect(
    taskDialog.getByRole("button", { name: "VS Code 열기", exact: true }),
  ).toHaveCount(0);
  assert.equal(await git(worktree.path, ["status", "--porcelain"]), before);
  assert.equal(await git(project.root, ["status", "--porcelain"]), "");
  assert.deepEqual(errors, []);
  console.log(
    `원본/작업 폴더 경로·네이티브 연결 인자·오류·브라우저 대안·모바일 검사 통과: ${directory}`,
  );
  console.log(
    "IDE 창/모델은 실행하지 않았습니다. 네이티브 연결은 대체 함수입니다.",
  );
} finally {
  await browser?.close();
  await app.close();
}
