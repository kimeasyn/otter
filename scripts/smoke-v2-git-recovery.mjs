import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { git, checkpoint, isolatedWorktree } from "../apps/worker/src/git.mjs";
import { ResultMerge } from "../apps/worker/src/merge.mjs";
import { ProjectPush } from "../apps/worker/src/push.mjs";

// 실제 임시 Git 병합/푸시 후 최종 기록 유실 상태만 재현한다. 외부 계정/모델 호출 없음.
const directory = await mkdtemp(join(tmpdir(), "otter-git-recovery-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
});
app.runner.pump = () => {};
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "결과 복구 회사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "프로젝트",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "범위 안에서 개발",
  });
  const assignment = company.assign(project.id, employee.id);
  const task = company.requestTask({
    projectId: project.id,
    assignmentId: assignment.id,
    prompt: "구현 결과",
  });
  const worktree = await isolatedWorktree(
    project.root,
    join(directory, "업무"),
    task.id,
  );
  await writeFile(join(worktree.path, "result.txt"), "실제 결과");
  app.store.update("tasks", task.id, {
    worktree,
    resultCommit: await checkpoint(worktree, "결과"),
    status: "review",
  });
  const merger = new ResultMerge(
    app.store,
    app.runner,
    join(directory, "worker"),
  );
  const mergePreview = await merger.preview(task.id);
  await merger.apply(task.id, {
    confirm: true,
    approval: mergePreview.approval,
  });
  const destination = join(directory, "원격.git");
  await git(directory, ["init", "--bare", destination]);
  await git(project.root, ["remote", "add", "origin", destination]);
  const push = new ProjectPush(app.store, app.runner);
  const input = { remote: "origin", branch: "main" };
  const pushPreview = await push.preview(project.id, input);
  await push.apply(project.id, {
    ...input,
    confirm: true,
    confirmAutomation: true,
    approval: pushPreview.approval,
  });
  const mergeRecord = app.store.get("tasks", task.id).merge;
  const pushRecord = app.store.get("projects", project.id).push;
  app.store.update("tasks", task.id, {
    merge: { ...mergeRecord, status: "unconfirmed" },
  });
  app.store.update("projects", project.id, {
    push: { ...pushRecord, status: "unconfirmed", process: undefined },
  });
  const head = await git(project.root, ["rev-parse", "HEAD"]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "☷ 업무" }).click();
  const recovery = page.getByRole("region", { name: "Git 결과 복구" });
  await recovery.getByRole("button", { name: "실제 Git 결과 대조" }).click();
  const restore = recovery.getByRole("button", { name: "반영 기록 복원" });
  await expect(restore).toBeDisabled();
  assert.equal(app.store.get("tasks", task.id).merge.status, "unconfirmed");
  app.store.update("tasks", task.id, { title: "변경된 업무 제목" });
  await recovery.getByRole("checkbox").check();
  await restore.click();
  await expect(recovery.getByRole("alert")).toContainText("바뀌었습니다");
  await recovery.getByRole("button", { name: "실제 Git 결과 대조" }).click();
  await expect(restore).toBeDisabled();
  await recovery.getByRole("checkbox").check();
  await page.screenshot({
    path: join(directory, "merge-recovery.png"),
    fullPage: true,
  });
  await restore.click();
  await expect(recovery).toHaveCount(0);
  assert.equal(app.store.get("tasks", task.id).merge.status, "merged");
  await page.getByRole("button", { name: "Git 푸시…" }).click();
  const dialog = page.getByRole("dialog", { name: "원격 저장소로 전송" });
  const pushRecovery = dialog.getByRole("region", { name: "Git 결과 복구" });
  await pushRecovery
    .getByRole("button", { name: "실제 Git 결과 대조" })
    .click();
  await expect(pushRecovery.getByRole("status")).toContainText(
    "실행 종료 증거가 부족",
  );
  await expect(
    pushRecovery.getByRole("button", { name: "반영 기록 복원" }),
  ).toHaveCount(0);
  await expect(
    pushRecovery.getByRole("button", { name: "미반영으로 기록" }),
  ).toHaveCount(0);
  app.store.update("projects", project.id, {
    push: { ...pushRecord, status: "unconfirmed" },
  });
  await pushRecovery
    .getByRole("button", { name: "실제 Git 결과 대조" })
    .click();
  const restorePush = pushRecovery.getByRole("button", {
    name: "반영 기록 복원",
  });
  await expect(restorePush).toBeDisabled();
  await pushRecovery.getByRole("checkbox").check();
  await page.setViewportSize({ width: 390, height: 844 });
  await restorePush.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(directory, "push-recovery-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await restorePush.click();
  await expect(pushRecovery).toHaveCount(0);
  assert.equal(app.store.get("projects", project.id).push.status, "pushed");
  assert.equal(await git(project.root, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(destination, ["rev-parse", "refs/heads/main"]), head);
  assert.equal(
    app.store
      .all("reports", project.id)
      .filter((r) => r.title === "Git 성공 기록 복원").length,
    2,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      status: "passed",
      checks: [
        "조회만으로 기록 불변",
        "오래된 확인 거부",
        "종료 미확인 처리 불가",
        "명시 승인 기록 복원",
        "원본/원격 커밋 불변",
        "모바일",
      ],
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
