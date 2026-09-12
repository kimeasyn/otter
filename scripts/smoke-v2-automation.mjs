import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { isolatedWorktree, checkpoint, git } from "../apps/worker/src/git.mjs";

// 완료 전 결과만 준비한다. 화면 승인 이후 병합·푸시는 제품 코드와 실제 임시 Git 저장소를 사용한다.
const directory = await mkdtemp(join(tmpdir(), "otter-automation-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: () => {
    throw new Error("모델 실행 금지");
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "자동 반영 회사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "범위 안에서 작업",
  });
  const assignment = company.assign(project.id, employee.id);
  const destination = join(directory, "승인한 원격.git");
  const deploymentMarker = join(directory, "automatic-deployment");
  await git(directory, ["init", "--bare", destination]);
  await git(project.root, ["remote", "add", "origin", destination]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "⚙ 설정" }).click();
  const settings = page.getByRole("region", { name: "완료 후 자동 반영" });
  await expect(settings).toBeVisible();
  await settings
    .getByRole("combobox", { name: "원본 반영", exact: true })
    .selectOption("auto");
  await settings
    .getByRole("combobox", { name: "원격 푸시", exact: true })
    .selectOption("auto");
  await expect(settings.getByLabel("등록 원격")).toHaveValue("origin");
  const deployMode = settings.getByRole("combobox", {
    name: "배포 명령",
    exact: true,
  });
  await expect(deployMode).toHaveValue("approval");
  await deployMode.selectOption("auto");
  await settings
    .getByLabel("배포 실행 파일의 절대 경로")
    .fill(process.execPath);
  await settings
    .getByLabel("자동 배포 인수 · 한 줄에 하나")
    .fill(
      `-e\nrequire('node:fs').appendFileSync(process.argv[1], 'deployed\\n')\n${deploymentMarker}`,
    );
  await settings.getByRole("button", { name: "자동 반영 범위 확인" }).click();
  await expect(settings).toContainText(destination);
  const save = settings.getByRole("button", { name: "자동 반영 설정 저장" });
  await expect(save).toBeDisabled();
  const confirm = settings.getByRole("checkbox", {
    name: /완료된 업무를 이 범위/,
  });
  const confirmRemote = settings.getByRole("checkbox", {
    name: /원본 브랜치의 기존 커밋/,
  });
  const confirmDeployment = settings.getByRole("checkbox", {
    name: /이후 완료 업무의 원본 커밋마다/,
  });
  await confirm.check();
  await expect(save).toBeDisabled();
  await confirmRemote.check();
  await expect(save).toBeDisabled();
  await confirmDeployment.check();
  app.store.update("projects", project.id, { name: "설정 동시 수정" });
  await save.click();
  await expect(
    page.getByRole("alert").filter({ hasText: /확인/ }).first(),
  ).toBeVisible();
  assert.equal(app.store.get("projects", project.id).automation, undefined);
  await settings.getByRole("button", { name: "자동 반영 범위 확인" }).click();
  await confirm.check();
  await confirmRemote.check();
  await confirmDeployment.check();
  await settings.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(directory, "automation-settings.png"),
    fullPage: true,
  });
  await save.click();
  await expect(settings.getByRole("status")).toContainText("새 업무부터");
  assert.equal(await git(destination, ["show-ref"]).catch(() => ""), "");
  await assert.rejects(readFile(deploymentMarker), { code: "ENOENT" });
  const task = company.requestTask({
    projectId: project.id,
    assignmentId: assignment.id,
    prompt: "승인 후 자동 반영할 결과",
  });
  const worktree = await isolatedWorktree(
    project.root,
    join(directory, "task"),
    task.id,
  );
  await writeFile(join(worktree.path, "result.txt"), "화면 승인 후 자동 반영");
  app.store.update("tasks", task.id, {
    worktree,
    resultCommit: await checkpoint(worktree, "결과"),
    status: "review",
  });
  await page.getByRole("button", { name: "☷ 업무" }).click();
  await page.getByRole("button", { name: "검토 완료", exact: true }).click();
  const review = page.getByRole("dialog", { name: "업무 결과 검토" });
  const finish = review.getByRole("button", {
    name: "확인한 결과를 완료 처리",
    exact: true,
  });
  await expect(finish).toBeDisabled();
  await review.getByRole("checkbox").check();
  app.store.update("tasks", task.id, { generation: 2 });
  await expect(review.getByRole("alert")).toContainText("검토 대상이 변경");
  await expect(finish).toBeDisabled();
  assert.equal(app.store.get("tasks", task.id).status, "review");
  await review.getByRole("button", { name: "돌아가기" }).click();
  await page.getByRole("button", { name: "검토 완료", exact: true }).click();
  await expect(review.getByRole("checkbox")).not.toBeChecked();
  await review.getByRole("checkbox").check();
  // 화면 갱신보다 서버의 결과 변경이 먼저 일어난 경우도 서버에서 거절한다.
  await page.route(
    `**/api/tasks/${task.id}/accept`,
    async (route) => {
      app.store.update("tasks", task.id, { generation: 3 });
      await route.continue();
    },
    { times: 1 },
  );
  await finish.click();
  await expect(review.getByRole("alert").last()).toContainText(
    "검토 대상이 변경",
  );
  assert.equal(app.store.get("tasks", task.id).status, "review");
  await expect(review.getByRole("button", { name: "돌아가기" })).toBeEnabled();
  await review.getByRole("button", { name: "돌아가기" }).click();
  await page.getByRole("button", { name: "검토 완료", exact: true }).click();
  await expect(review).toContainText("실행 3회차");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(directory, "review-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const reviewed = app.store.get("tasks", task.id);
  await review.getByRole("checkbox").check();
  await finish.click();
  await expect
    .poll(() => app.store.get("tasks", task.id).automation?.status, {
      timeout: 15000,
    })
    .toBe("done");
  assert.deepEqual(app.store.get("tasks", task.id).acceptedReview, {
    revision: reviewed.revision,
    generation: 3,
    resultCommit: reviewed.resultCommit,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByRole("status").filter({ hasText: "자동 반영: 완료" }),
  ).toBeVisible();
  assert.equal(
    await readFile(join(project.root, "result.txt"), "utf8"),
    "화면 승인 후 자동 반영",
  );
  assert.equal(
    await git(destination, ["rev-parse", "refs/heads/main"]),
    app.store.get("tasks", task.id).merge.commit,
  );
  assert.equal(await readFile(deploymentMarker, "utf8"), "deployed\n");
  assert.equal(
    app.store.get("projects", project.id).deployment.status,
    "succeeded",
  );
  await page.getByRole("button", { name: /◷ 보고/ }).click();
  await expect(
    page.getByRole("heading", { name: "자동 반영 완료", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "배포 명령 종료", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "⚙ 설정" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const button of await page
    .locator(".page-heading .button-row > button")
    .all()) {
    assert.ok(
      (await button.boundingBox()).height < 60,
      "좁은 화면에서 상단 동작 버튼의 글자가 세로로 찌그러지지 않는다",
    );
  }
  await settings.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(directory, "automation-mobile.png"),
    fullPage: true,
  });
  await settings.getByRole("button", { name: "자동 반영 해제" }).click();
  await expect
    .poll(() => app.store.get("projects", project.id).automation)
    .toBe(null);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      status: "passed",
      checks: [
        "기본 수동 승인",
        "대상·CI/CD 동의",
        "오래된 설정 거부",
        "검토 중 결과 변경·서버 충돌 거부",
        "최신 결과 재확인·승인 대상 기록",
        "완료 후 실제 병합·푸시",
        "배포 별도 동의·실제 명령",
        "별도 보고",
        "해제",
        "모바일",
      ],
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
