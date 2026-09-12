import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../apps/worker/src/server.mjs";

// 실제 HTTP/SQLite/브라우저 설정 흐름. 제공자는 대체하며 실행·로그인·모델 호출은 하지 않는다.
const directory = await mkdtemp(join(tmpdir(), "otter-codex-settings-ui-"));
const commands = [];
const options = {
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: ({ command }) => {
    commands.push(command);
    throw new Error("검사용 제공자: 연결 실패");
  },
};
let app = await startServer(options);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "⌁ 실행 환경", exact: true })
      .click();
    await page.getByText("Codex 실행 파일 설정", { exact: true }).click();
  };
  await open();
  const dialog = page.getByRole("dialog", { name: "실행 환경", exact: true });
  const path = dialog.getByLabel("Codex 실행 파일의 절대 경로");
  const consent = dialog.getByRole("checkbox");
  const save = dialog.getByRole("button", { name: "실행 파일 설정 저장" });
  await expect(path).toHaveValue("");
  await expect(save).toBeDisabled();
  await path.fill("relative-path");
  await consent.check();
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("절대 경로");
  await path.fill(process.execPath);
  await expect(save).toBeDisabled();
  await consent.check();
  await save.click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "저장했습니다" }),
  ).toBeVisible();
  assert.equal(commands.length, 0, "저장만으로 실행하지 않는다");
  const canonical = await realpath(process.execPath);
  await expect(path).toHaveValue(canonical);
  await dialog.getByRole("button", { name: "Codex 준비 상태 확인" }).click();
  await expect(
    dialog.getByText("Codex 연결 · 조치 필요", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(commands, [canonical]);
  await page.screenshot({
    path: join(directory, "settings-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await path.scrollIntoViewIfNeeded();
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  );
  await page.screenshot({
    path: join(directory, "settings-mobile.png"),
    fullPage: true,
  });

  await page.goto("about:blank");
  await app.close();
  app = await startServer(options);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open();
  await expect(path).toHaveValue(canonical);
  await expect(save).toBeDisabled();
  await path.fill("");
  await consent.check();
  await save.click();
  await expect(
    dialog.getByRole("status").filter({ hasText: "저장했습니다" }),
  ).toBeVisible();
  assert.deepEqual(commands, [canonical]);
  await dialog.getByRole("button", { name: "Codex 준비 상태 확인" }).click();
  await expect(
    dialog.getByText("Codex 연결 · 조치 필요", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(commands, [canonical, "codex"]);
  assert.equal(app.store.all("tasks").length, 0);
  assert.equal(app.store.all("reports").length, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      persisted: true,
      provider: "replaced",
      calls: commands.length,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
