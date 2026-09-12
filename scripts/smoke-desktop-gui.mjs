import {
  _electron,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 개발 런타임의 자동화 API만 사용한다. 배포 바이너리의 inspector/fuse는 다시 켜지 않는다.
const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const directory = await mkdtemp(join(tmpdir(), "otter-desktop-gui-"));
const profile = join(directory, "profile");
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [
      fileURLToPath(new URL("../apps/desktop", import.meta.url)),
      "--user-data-dir=" + profile,
    ],
    chromiumSandbox: true,
    timeout: 15000,
  });
  const page = await app.firstWindow({ timeout: 15000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("button", { name: "⌁ 실행 환경", exact: true }),
  ).toBeVisible();
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  const preferences = await (
    await app.browserWindow(page)
  ).evaluate((window) => window.webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(
    await page.evaluate(() => typeof window.otter?.pickFolder),
    "function",
  );
  await page.getByRole("button", { name: "⌁ 실행 환경", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "실행 환경", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(directory, "environment.png") });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const pid = app.process().pid;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  );
  process.kill(pid, 0);
  await app.evaluate(({ Menu }) => {
    const reopen = Menu.getApplicationMenu().items[0].submenu.items.find(
      (item) => item.label === "사무실 열기",
    );
    reopen.click();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    )
    .toBe(true);
  assert.deepEqual(errors, []);
  const child = app.process();
  await app.close();
  app = null;
  assert.equal(child.exitCode, 0);
  await assert.rejects(access(join(profile, "v2/worker.lock")), {
    code: "ENOENT",
  });
  console.log(
    JSON.stringify({
      directory,
      windowReopened: true,
      chromiumSandbox: true,
      closed: true,
    }),
  );
} finally {
  await app?.close();
}
