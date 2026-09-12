import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";
import { saveRecordBackup } from "../apps/desktop/src/backup.mjs";

// 파일 선택/IPC만 대체한다. 사용자 DB가 아닌 임시 실행부의 실제 SQLite를 저장한다.
const directory = await mkdtemp(join(tmpdir(), "otter-backup-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: () => {
    throw new Error("브라우저 검사에서 모델 실행 금지");
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "백업 확인 회사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
    name: "기록 백업 확인",
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const output = join(directory, "로컬 기록 사본.sqlite");
  let calls = 0;
  await page.exposeFunction("testRecordBackup", async () => {
    calls++;
    if (calls === 1) return { saved: false };
    return saveRecordBackup(app.store, output);
  });
  await page.addInitScript(() => {
    window.otter = { backupRecords: () => window.testRecordBackup() };
  });
  await page.goto(app.origin);
  await page.getByRole("button", { name: /설정/ }).click();
  const section = page.getByRole("region", { name: "로컬 기록 백업" });
  await expect(section.locator("details")).not.toHaveAttribute("open", "");
  await section.locator("summary").click();
  await expect(
    section.getByText(/원격 프로젝트의 전체 백업이 아닙니다/),
  ).toBeVisible();
  const save = section.getByRole("button", {
    name: "범위 확인 후 파일로 저장…",
  });
  await save.click();
  await expect(save).toBeEnabled();
  await expect(section.getByRole("status")).toHaveCount(0);
  await save.click();
  await expect(section.getByRole("status")).toContainText("저장·검증 완료");
  await expect(section.getByRole("status")).toContainText(output);
  const bytes = await readFile(output);
  const db = new DatabaseSync(output, { readOnly: true });
  try {
    assert.equal(
      JSON.parse(
        db.prepare("SELECT data FROM projects WHERE id=?").get(project.id).data,
      ).name,
      project.name,
    );
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    db.close();
  }
  await page.screenshot({
    path: join(directory, "backup-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(directory, "backup-mobile.png"),
    fullPage: true,
  });
  await save.click();
  await expect(section.getByRole("alert")).toContainText("덮어쓰지 말고");
  await expect(section.getByRole("status")).toHaveCount(0);
  assert.deepEqual(await readFile(output), bytes);
  assert.equal(calls, 3);
  await page.evaluate(() => {
    delete window.otter;
  });
  await page.getByRole("button", { name: /사무실/ }).click();
  await page.getByRole("button", { name: /설정/ }).click();
  await section.locator("summary").click();
  await expect(section.getByText(/브라우저 개발 화면에서는/)).toBeVisible();
  await expect(save).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.equal(app.runner.active.size, 0);
  console.log(
    JSON.stringify({
      directory,
      nativeDialogs: "대체 연결",
      sqliteBackup: "실제 저장",
      cancellation: true,
      overwriteBlocked: true,
      mobile: true,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
