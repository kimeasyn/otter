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
const directory = await mkdtemp(join(tmpdir(), "otter-models-ui-"));
const calls = [];
const app = await startServer({
  directory,
  port: 0,
  makeCodex: () => {
    const client = new EventEmitter();
    client.initialize = async () => {};
    client.close = async () => {};
    client.refuse = () => {};
    client.request = async (method) => {
      calls.push(method);
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
  const org = company.createCompany({ name: "조회 검사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    model: "existing-model",
    instructions: "검사",
  });
  company.assign(project.id, employee.id);
  const before = app.store.all("assignments");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page
    .getByRole("button", { name: "프로젝트 설정", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const list = dialog.getByRole("combobox", {
    name: "Codex 모델",
    exact: true,
  });
  await expect(dialog.getByRole("option", { name: /검사 모델/ })).toHaveCount(
    1,
  );
  await expect(
    dialog.getByRole("textbox", { name: "Codex 모델", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "모델 목록 조회" }),
  ).toHaveCount(0);
  await expect(list).toBeVisible();
  await expect(
    dialog.getByText(/저장하려면 목록에서 다시 선택하세요/),
  ).toBeVisible();
  await expect(list).toHaveValue("");
  await dialog.getByRole("button", { name: "설정 저장" }).click();
  assert.deepEqual(
    app.store.all("assignments"),
    before,
    "미선택 상태에서는 저장하지 않는다",
  );
  await list.selectOption("fixture-model");
  await expect(dialog.getByLabel("Codex 모델", { exact: true })).toHaveValue(
    "fixture-model",
  );
  await dialog.screenshot({ path: join(directory, "models-mobile.png") });
  assert.deepEqual(
    app.store.all("assignments"),
    before,
    "선택은 저장이 아니다",
  );
  assert.equal(app.store.all("tasks").length, 0);
  assert.deepEqual(calls, ["model/list"]);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ directory, passed: true, modelTurns: 0, savedChanges: 0 }),
  );
} finally {
  await browser?.close();
  await app.close();
}
