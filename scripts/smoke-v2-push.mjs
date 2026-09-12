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
import { git, checkpoint } from "../apps/worker/src/git.mjs";

// 사용자 GitHub/SSH/모델을 호출하지 않고 임시 bare 저장소에 실제 푸시한다.
const directory = await mkdtemp(join(tmpdir(), "otter-push-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
});
app.runner.pump = () => {};
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "개발 회사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "프로젝트",
    name: "코드 없이 개발",
  });
  await writeFile(join(project.root, "결과.txt"), "개발 결과");
  await checkpoint({ path: project.root }, "첫 개발 결과");
  const destination = join(directory, "원격.git");
  await git(directory, ["init", "--bare", destination]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Git 푸시…" }).click();
  const dialog = page.getByRole("dialog", { name: "원격 저장소로 전송" });
  await expect(dialog.getByText(/^등록된 Git 원격이 없습니다/)).toBeVisible();
  await dialog.getByRole("button", { name: "닫기" }).click();
  await git(project.root, ["remote", "add", "origin", destination]);
  await page.getByRole("button", { name: "Git 푸시…" }).click();
  const check = dialog.getByRole("button", {
    name: "원격 상태와 전송 내용 확인",
  });
  await expect(
    dialog.getByRole("combobox", { name: "원격 저장소" }),
  ).toHaveValue("origin");
  await expect(
    dialog.getByRole("textbox", { name: "원격 대상 브랜치" }),
  ).toHaveValue("main");
  const approve = dialog.getByRole("button", {
    name: "승인하고 푸시",
    exact: true,
  });
  await expect(approve).toHaveCount(0);
  await check.click();
  await expect(approve).toBeDisabled();
  await expect(dialog.locator("pre")).toContainText("첫 개발 결과");
  assert.equal(await git(destination, ["show-ref"]).catch(() => ""), "");
  await dialog.getByRole("button", { name: "닫기" }).click();
  assert.equal(await git(destination, ["show-ref"]).catch(() => ""), "");
  await page.getByRole("button", { name: "Git 푸시…" }).click();
  await check.click();
  await expect(approve).toBeDisabled();
  await writeFile(join(project.root, "결과.txt"), "확인 이후 추가 개발");
  await checkpoint({ path: project.root }, "추가 개발 결과");
  await dialog.getByRole("checkbox").check();
  await approve.click();
  await expect(dialog.getByRole("alert")).toContainText("바뀌었습니다");
  assert.equal(await git(destination, ["show-ref"]).catch(() => ""), "");
  await check.click();
  await expect(approve).toBeDisabled();
  await expect(dialog.locator("pre")).toContainText("추가 개발 결과");
  await dialog.getByRole("checkbox").check();
  await page.screenshot({
    path: join(directory, "push-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(directory, "push-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await approve.click();
  await expect(dialog.getByRole("status")).toContainText(
    "전송 결과를 확인했습니다",
  );
  assert.equal(
    await git(destination, ["rev-parse", "refs/heads/main"]),
    await git(project.root, ["rev-parse", "HEAD"]),
  );
  await dialog.getByRole("button", { name: "닫기" }).click();
  await page.getByRole("button", { name: "Git 푸시…" }).click();
  await check.click();
  await expect(dialog.getByRole("status")).toContainText(
    "이미 원격 브랜치에 있습니다",
  );
  await expect(approve).toHaveCount(0);
  await dialog.getByRole("button", { name: "닫기" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "◷ 보고" }).click();
  await expect(
    page.getByRole("heading", { name: "원격 푸시 확인" }),
  ).toBeVisible();
  await expect(page.getByText("Git 전송 기록", { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      status: "passed",
      checks: [
        "원격 없음 안내",
        "조회만으로 전송하지 않음",
        "취소",
        "오래된 승인 거부",
        "명시적 CI/CD 동의 후 푸시",
        "중복 전송 방지",
        "별도 보고",
        "모바일",
      ],
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
