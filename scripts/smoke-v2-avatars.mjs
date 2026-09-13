import {
  chromium,
  expect,
} from "../apps/web/node_modules/@playwright/test/index.mjs";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

const directory = await mkdtemp(join(tmpdir(), "otter-avatars-ui-"));
const app = await startServer({
  directory,
  port: 0,
  makeCodex: () => {
    const client = new EventEmitter();
    client.initialize = client.close = async () => {};
    client.refuse = () => {};
    client.request = async (method) => {
      assert.equal(method, "model/list");
      return {
        data: [
          { model: "fixture-model", displayName: "검사 모델", isDefault: true },
        ],
        nextCursor: null,
      };
    };
    return client;
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "아바타 검사", mode: "single" });
  await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page.getByRole("button", { name: "＋ 직원 배정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "이전 아바타" }).click();
  await dialog.getByRole("button", { name: "이전 아바타" }).click();
  await expect(dialog.getByRole("status")).toContainText("모자");
  await dialog
    .getByRole("textbox", { name: "이름", exact: true })
    .fill("아바타 직원");
  await dialog.getByRole("textbox", { name: "역할", exact: true }).fill("개발");
  await dialog
    .getByRole("combobox", { name: "Codex 모델", exact: true })
    .selectOption("fixture-model");
  await dialog
    .getByRole("button", { name: "이 프로젝트에 배정", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  assert.equal(app.store.all("employees")[0].appearance.avatar, "cap");
  assert.equal(app.store.all("assignments")[0].appearance.avatar, "cap");
  await page
    .getByRole("button", { name: "프로젝트 설정", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("모자");
  await dialog.getByRole("button", { name: "다음 아바타" }).click();
  await expect(dialog.getByRole("status")).toContainText("헤드셋");
  await expect(
    dialog.getByRole("combobox", { name: "Codex 모델", exact: true }),
  ).toHaveValue("fixture-model");
  await dialog.screenshot({ path: join(directory, "avatars-mobile.png") });
  await dialog.getByRole("button", { name: "설정 저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(app.store.all("assignments")[0].appearance.avatar, "headset");
  assert.equal(app.store.all("employees")[0].appearance.avatar, "cap");
  await page.reload();
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await expect(
    page.locator('.staff-card > svg[data-avatar="headset"]'),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  assert.equal(app.store.all("tasks").length, 0);
  console.log(JSON.stringify({ directory, passed: true, modelTurns: 0 }));
} finally {
  await browser?.close();
  await app.close();
}
