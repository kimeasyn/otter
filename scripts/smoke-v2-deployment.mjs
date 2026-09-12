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
import { checkpoint } from "../apps/worker/src/git.mjs";

const directory = await mkdtemp(join(tmpdir(), "otter-deployment-ui-"));
const app = await startServer({
  directory: join(directory, "worker"),
  port: 0,
  makeCodex: () => {
    throw new Error("모델 호출 금지");
  },
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "배포 검사", mode: "single" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  await writeFile(join(project.root, "README.md"), "배포할 커밋");
  await checkpoint({ path: project.root }, "배포 검사");
  const marker = join(directory, "deployed");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "배포…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "배포 명령 실행" });
  await dialog.getByLabel("실행 파일의 절대 경로").fill(process.execPath);
  const args = `-e\nrequire('node:fs').appendFileSync(process.argv[1], 'deployed\\n')\n${marker}`;
  await dialog.getByLabel("배포 인수 · 한 줄에 하나").fill(args);
  await dialog
    .getByRole("button", { name: "배포 범위 확인", exact: true })
    .click();
  const scope = dialog.getByRole("region", { name: "승인할 배포 범위" });
  await expect(scope).toContainText(project.root);
  await expect(scope).toContainText(
    process.platform === "win32"
      ? "상위 명령의 종료만 관찰"
      : "같은 프로세스 그룹이 남아 있으면",
  );
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const run = dialog.getByRole("button", {
    name: "승인하고 배포 명령 실행",
    exact: true,
  });
  await expect(run).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /위 명령·폴더·커밋/ }).check();
  await expect(run).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /실행 계정의 파일/ }).check();
  await page.screenshot({
    path: join(directory, "deployment-desktop.png"),
    fullPage: true,
  });
  await run.click();
  await expect
    .poll(() => app.store.get("projects", project.id).deployment?.status)
    .toBe("succeeded");
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: "명령 종료 · 서비스 확인 필요" }),
  ).toBeVisible();
  assert.equal(await readFile(marker, "utf8"), "deployed\n");
  await expect(
    dialog.getByRole("region", { name: "마지막 배포 기록" }),
  ).toContainText("상위 명령: 종료 확인");
  if (process.platform !== "win32")
    await expect(
      dialog.getByRole("region", { name: "마지막 배포 기록" }),
    ).toContainText("부재 확인");
  await dialog
    .getByRole("button", { name: "배포 범위 확인", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: /위 명령·폴더·커밋/ }).check();
  await dialog.getByRole("checkbox", { name: /실행 계정의 파일/ }).check();
  await expect(run).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", { name: /이전 배포 결과/ }),
  ).toBeVisible();
  // 실패 명령을 명시 승인한다. 서비스 배포나 실제 계정은 사용하지 않는다.
  await dialog
    .getByLabel("배포 인수 · 한 줄에 하나")
    .fill("-e\nprocess.exit(1)");
  await dialog
    .getByRole("button", { name: "배포 범위 확인", exact: true })
    .click();
  await dialog.getByRole("checkbox", { name: /위 명령·폴더·커밋/ }).check();
  await dialog.getByRole("checkbox", { name: /실행 계정의 파일/ }).check();
  await dialog.getByRole("checkbox", { name: /이전 배포 결과/ }).check();
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("결과 확인 필요");
  await expect(
    dialog.getByRole("button", { name: "확인 결과 기록" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("외부 서비스에서 확인한 결과")
    .fill("검사 명령이 종료됐고 외부 서비스 변경은 없다.");
  await dialog
    .getByRole("checkbox", { name: /명령과 후속 프로세스가 끝났고/ })
    .check();
  await dialog.getByRole("button", { name: "확인 결과 기록" }).click();
  await expect
    .poll(() => app.store.get("projects", project.id).deployment?.status)
    .toBe("acknowledged");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(directory, "deployment-mobile.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: /◷ 보고/ }).click();
  await expect(
    page.getByRole("heading", { name: "배포 명령 종료", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "배포 결과 사용자 확인", exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      directory,
      status: "passed",
      checks: [
        "명시 범위 승인",
        "실제 명령",
        "중복 실행 동의",
        "실패 후 확인",
        "보고",
        "모바일",
      ],
    }),
  );
} finally {
  await browser?.close();
  await app.close();
}
