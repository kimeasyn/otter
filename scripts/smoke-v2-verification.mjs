import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { Company } from "../apps/worker/src/company.mjs";

// 제공자/샌드박스 전송은 대체한다. 정해진 임시 파일 검사는 실제 Node 프로세스로 실행한다.
const exec = promisify(execFile);
class Fixture extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
  }
  async initialize() {}
  async request(method, params) {
    if (method.startsWith("thread/"))
      return { thread: { id: "verification-ui" } };
    if (method === "turn/start") {
      await writeFile(join(this.cwd, "hello.txt"), "hello");
      setImmediate(() => {
        this.emit("notification", {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              text: "합성 직원: 구현 완료. 실제 검증 기록은 Otter에서 확인하세요.",
            },
          },
        });
        this.emit("notification", {
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      });
      return { turn: { id: "turn" } };
    }
    if (method === "command/exec") {
      assert.equal(params.command[0], process.execPath);
      assert.equal(params.sandboxPolicy.networkAccess, false);
      try {
        return {
          exitCode: 0,
          ...(await exec(params.command[0], params.command.slice(1), {
            cwd: this.cwd,
            timeout: params.timeoutMs,
          })),
        };
      } catch (e) {
        return { exitCode: e.code, stdout: e.stdout, stderr: e.stderr };
      }
    }
    throw new Error("예상하지 않은 호출: " + method);
  }
  close() {}
  refuse() {}
}
const directory = await mkdtemp(join(tmpdir(), "otter-verification-ui-"));
const app = await startServer({
  directory,
  port: 0,
  makeCodex: ({ cwd }) => new Fixture(cwd),
});
let browser;
try {
  const company = new Company(app.store);
  const org = company.createCompany({ name: "검증 스튜디오", mode: "group" });
  const project = await company.addProject({
    companyId: org.id,
    create: true,
    parent: directory,
    folder: "project",
  });
  const employee = company.createEmployee({
    name: "김코딩",
    role: "개발",
    instructions: "테스트",
  });
  company.assign(project.id, employee.id);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin);
  await page.getByRole("button", { name: "⚙ 설정", exact: true }).click();
  await page
    .getByRole("combobox", { name: "완료 판단" })
    .selectOption("verified");
  assert.equal(
    await page.getByRole("button", { name: "완료 방식 저장" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "검증 명령 추가" }).click();
  await page
    .getByRole("textbox", { name: "실행 파일", exact: true })
    .fill(process.execPath);
  await page
    .getByRole("textbox", { name: "인수 · 한 줄에 하나" })
    .fill(
      "-e\nif(require('fs').readFileSync('hello.txt','utf8')!=='hello') process.exit(1)",
    );
  assert.equal(
    await page.getByRole("button", { name: "완료 방식 저장" }).isDisabled(),
    true,
  );
  await page
    .getByRole("checkbox", { name: /이 명령과 실행되는 프로젝트/ })
    .check();
  await page.getByRole("button", { name: "완료 방식 저장" }).click();
  await page.getByText("완료 방식을 저장했습니다.", { exact: true }).waitFor();
  assert.ok(
    (await page.locator(".completion-confirm").boundingBox()).height < 100,
    "실행 동의 문구가 세로로 찌그러지지 않는다",
  );
  await page.screenshot({
    path: join(directory, "completion-settings.png"),
    fullPage: true,
  });
  async function request(title) {
    await page.getByRole("button", { name: "▦ 사무실", exact: true }).click();
    await page.getByRole("textbox", { name: "직원에게 업무 요청" }).fill(title);
    await page.getByRole("button", { name: "업무 요청 보내기" }).click();
    await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
    return page
      .locator(".task-card")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  }
  const success = await request("hello 파일 자동 검증");
  await success
    .getByText("완료 판정: 지정 검증 통과 · Git 반영 상태는 별도", {
      exact: true,
    })
    .waitFor();
  await success
    .getByText("별도 검증 · 지정 검사 통과", { exact: true })
    .click();
  await success.getByText(/종료 코드 0/).waitFor();
  assert.equal(
    await success.getByRole("button", { name: "검토 완료" }).count(),
    0,
  );
  await page.screenshot({
    path: join(directory, "verified-result.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "⚙ 설정", exact: true }).click();
  await page
    .getByRole("textbox", { name: "인수 · 한 줄에 하나" })
    .fill("-e\nprocess.exit(1)");
  await page
    .getByRole("checkbox", { name: /이 명령과 실행되는 프로젝트/ })
    .check();
  await page.getByRole("button", { name: "완료 방식 저장" }).click();
  await page.getByText("완료 방식을 저장했습니다.", { exact: true }).waitFor();
  // 기존 완료 업무를 이어가지 않고 새 요청으로 검사한다.
  await page.getByRole("button", { name: "▦ 사무실", exact: true }).click();
  await page.getByRole("combobox", { name: "업무 대화 선택" }).selectOption("");
  const failure = await request("실패 검증은 완료 금지");
  await failure.getByText("별도 검증 · 실패", { exact: true }).waitFor();
  assert.equal(
    await failure
      .getByText("지정 검증 통과로 자동 완료 · 병합/배포 아님", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    app.store.all("tasks").find((t) => t.title === "실패 검증은 완료 금지")
      .status,
    "blocked",
  );
  await page.getByRole("button", { name: /^◷ 보고/ }).click();
  await page.getByText("별도 검증 · 실패", { exact: true }).waitFor();
  await page.screenshot({
    path: join(directory, "verification-report.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(directory, "verification-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "통과: 완료 정책 승인/저장 → 별도 검증 자동 완료 → 검증 실패 시 차단 → 보고. 모델·샌드박스는 합성, 검사 명령은 실제 Node 실행.",
  );
  console.log("증거: " + directory);
} finally {
  await browser?.close();
  await app.close();
}
