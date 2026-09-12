import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../apps/worker/src/server.mjs";

// 설치된 Codex의 고정 진단만 사용한다. thread/turn과 모델 생성은 하지 않는다.
const directory = await mkdtemp(join(tmpdir(), "otter-readiness-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "⌁ 실행 환경", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "실행 환경", exact: true });
  const check = dialog.getByRole("region", { name: "Codex 준비 상태" });
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/codex-check"),
  );
  await check.getByRole("button", { name: "Codex 준비 상태 확인" }).click();
  const result = await (await response).json();
  assert.equal(result.checks.length, 3);
  for (const item of result.checks) {
    const label = { passed: "확인됨", failed: "조치 필요", unknown: "미확인" }[
      item.status
    ];
    await expect(
      check.getByText(`${item.name} · ${label}`, { exact: true }),
    ).toBeVisible();
    await expect(check.getByText(item.message, { exact: true })).toBeVisible();
  }
  await expect(check).toContainText(
    "실제 모델 응답이나 프로젝트별 작업 성공을 보장하지 않습니다",
  );
  await page.screenshot({
    path: join(directory, "readiness-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check.scrollIntoViewIfNeeded();
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  );
  await expect(
    check.getByRole("button", { name: "Codex 준비 상태 확인" }),
  ).toBeVisible();
  await page.screenshot({
    path: join(directory, "readiness-mobile.png"),
    fullPage: true,
  });
  assert.equal(app.store.all("tasks").length, 0);
  assert.equal(app.store.all("reports").length, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      checks: result.checks.map(({ name, status }) => ({ name, status })),
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
