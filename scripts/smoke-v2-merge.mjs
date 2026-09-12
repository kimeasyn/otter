import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { isolatedWorktree, git, checkpoint } from "../apps/worker/src/git.mjs";

// 모델 호출 없이 실제 Git/HTTP/브라우저 승인과 파일 반영을 검증한다.
const directory = await mkdtemp(join(tmpdir(), "otter-merge-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
});
app.runner.pump = () => {};
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "제품 회사", mode: "group" });
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
    prompt: "인사말 기능 결과",
  });
  const worktree = await isolatedWorktree(
    project.root,
    join(directory, "직원작업"),
    task.id,
  );
  await writeFile(join(worktree.path, "인사말.txt"), "안녕하세요");
  const resultCommit = await checkpoint(worktree, "인사말");
  app.store.update("tasks", task.id, {
    worktree,
    resultCommit,
    status: "review",
  });
  const before = await git(project.root, ["rev-parse", "HEAD"]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "☷ 업무" }).click();
  await page.getByRole("button", { name: "원본에 반영…" }).click();
  const dialog = page.getByRole("dialog", { name: "직원 결과를 원본에 반영" });
  const approve = dialog.getByRole("button", {
    name: "승인하고 원본에 반영",
    exact: true,
  });
  await expect(approve).toBeEnabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "원본 폴더" })).toHaveValue(
    project.root,
  );
  await expect(dialog.locator("pre")).toContainText("인사말.txt");
  assert.equal(await git(project.root, ["rev-parse", "HEAD"]), before);
  await dialog.getByRole("button", { name: "닫기" }).click();
  assert.equal(await git(project.root, ["rev-parse", "HEAD"]), before);
  await page.getByRole("button", { name: "원본에 반영…" }).click();
  await expect(approve).toBeEnabled();
  await writeFile(join(project.root, "기존 작업.txt"), "사용자가 먼저 작업");
  await checkpoint({ path: project.root }, "사용자 작업");
  await approve.click();
  await expect(dialog.getByRole("alert")).toContainText("바뀌었습니다");
  await assert.rejects(readFile(join(project.root, "인사말.txt")), {
    code: "ENOENT",
  });
  await dialog.getByRole("button", { name: "최신 상태 다시 확인" }).click();
  await expect(approve).toBeEnabled();
  await page.screenshot({
    path: join(directory, "merge-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(directory, "merge-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await approve.click();
  await expect(dialog.getByRole("status")).toContainText("main에 반영했습니다");
  assert.equal(
    await readFile(join(project.root, "인사말.txt"), "utf8"),
    "안녕하세요",
  );
  assert.equal(
    await readFile(join(project.root, "기존 작업.txt"), "utf8"),
    "사용자가 먼저 작업",
  );
  assert.equal(app.store.get("tasks", task.id).status, "review");
  await dialog.getByRole("button", { name: "닫기" }).click();
  await page.getByRole("button", { name: "원본에 반영…" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "이미 원본 이력에 포함",
  );
  await expect(approve).toHaveCount(0);
  await dialog.getByRole("button", { name: "닫기" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "◷ 보고" }).click();
  await expect(
    page.getByRole("heading", { name: "원본 반영 완료" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article").getByText("Git 반영 기록", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      status: "passed",
      checks: [
        "승인 전 원본 보존",
        "취소",
        "오래된 승인 거부",
        "명시 승인 병합",
        "원본 기존 변경 보존",
        "이미 반영됨",
        "별도 보고",
        "모바일",
      ],
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
