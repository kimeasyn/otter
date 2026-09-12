import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startServer } from "../apps/worker/src/server.mjs";
import { Remote } from "../apps/worker/src/remote.mjs";

const directory = await mkdtemp(join(tmpdir(), "otter-ui-smoke-"));
const app = await startServer({
  directory,
  port: 0,
  makeRemote: (environment) =>
    new Remote(environment, {
      launch: (_command, _args, options) =>
        spawn(
          process.execPath,
          [
            new URL("../apps/worker/src/remote-bootstrap.mjs", import.meta.url)
              .pathname,
          ],
          options,
        ),
    }),
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
  await page.getByRole("button", { name: "첫 프로젝트 시작하기" }).click();
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  await page.getByRole("button", { name: "폴더 찾기" }).click();
  await page.getByRole("button", { name: "이 폴더 선택" }).waitFor();
  await page.getByRole("button", { name: "이 폴더 선택" }).click();
  await page.getByRole("textbox", { name: "폴더 경로" }).fill(directory);
  await page.getByRole("textbox", { name: "새 폴더 이름" }).fill("studio");
  await page
    .getByRole("textbox", { name: "프로젝트 표시 이름" })
    .fill("나의 작은 스튜디오");
  await page
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await page.getByRole("button", { name: "＋ 직원 배정" }).click();
  await page.getByRole("textbox", { name: "이름", exact: true }).fill("김코딩");
  await page
    .getByRole("textbox", { name: "역할", exact: true })
    .fill("백엔드 개발자");
  await page.getByRole("button", { name: "이 프로젝트에 배정" }).click();
  await page
    .getByRole("button", { name: "김코딩, 업무 없음, 대화 열기" })
    .click();
  await page.getByRole("textbox", { name: "직원에게 업무 요청" }).waitFor();
  await page.getByRole("button", { name: "♙ 직원" }).click();
  await page.getByRole("button", { name: "프로젝트 설정" }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "지침", exact: true })
    .fill("이 프로젝트에서만 사용하는 지침");
  await page.getByRole("button", { name: "설정 저장" }).click();
  await page.getByRole("button", { name: "직원 라이브러리" }).click();
  await page.getByRole("button", { name: "원본 편집" }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "지침", exact: true })
    .fill("다른 프로젝트에서도 선택해서 가져올 공통 지침");
  await page.getByRole("button", { name: "설정 저장" }).click();
  await page.getByRole("button", { name: "프로젝트 팀" }).click();
  await page
    .getByText("이 프로젝트에서만 사용하는 지침", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: /원본과 비교/ }).click();
  await page.getByRole("checkbox", { name: /지침 반영/ }).check();
  await page.getByRole("button", { name: "선택한 변경 반영" }).click();
  await page
    .getByText("다른 프로젝트에서도 선택해서 가져올 공통 지침", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "직원 라이브러리" }).click();
  await page
    .getByRole("button", { name: "파생 직원 만들기", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "이름", exact: true })
    .fill("박리뷰");
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "역할", exact: true })
    .fill("코드 리뷰어");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "파생 직원 만들기", exact: true })
    .click();
  await page.getByRole("heading", { name: "박리뷰" }).waitFor();
  await page.getByRole("button", { name: "＋ 직원 배정" }).click();
  await page
    .getByRole("combobox", { name: "직원 선택" })
    .selectOption({ label: "박리뷰 · 코드 리뷰어" });
  await page.getByRole("button", { name: "이 프로젝트에 배정" }).click();
  await page.getByRole("button", { name: "▦ 사무실" }).click();
  await page
    .getByRole("button", { name: "박리뷰, 업무 없음, 대화 열기" })
    .waitFor();
  await page.screenshot({
    path: join(directory, "office-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "▤ 문서·지침" }).click();
  await page
    .getByRole("textbox", { name: "목표", exact: true })
    .fill("다른 사람의 코드를 덮어쓰지 않는 개발 작업공간");
  await page.getByRole("button", { name: "변경 저장" }).first().click();
  await page.getByRole("button", { name: "저장됨 ✓" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "▤ 문서·지침" }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "목표", exact: true }).inputValue(),
    "다른 사람의 코드를 덮어쓰지 않는 개발 작업공간",
  );
  const instructionEditor = page.locator(".document-editor").filter({
    has: page.getByRole("heading", { name: "프로젝트 지침", exact: true }),
  });
  await page
    .getByRole("textbox", { name: "프로젝트 지침", exact: true })
    .fill("GUI에서 저장한 프로젝트 지침");
  await instructionEditor
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "저장됨 ✓", exact: true })
    .waitFor();
  await instructionEditor.getByText(/저장소 지침 파일/).click();
  await instructionEditor
    .getByRole("button", { name: "파일과 비교", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "문서를 원본 파일에 반영", exact: true })
    .click();
  await instructionEditor.getByText(/원본 파일에 저장했습니다/).waitFor();
  assert.equal(
    await readFile(join(directory, "studio", "AGENTS.md"), "utf8"),
    "GUI에서 저장한 프로젝트 지침",
  );
  await instructionEditor
    .getByRole("button", { name: "파일과 비교", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "문서를 원본 파일에 반영", exact: true })
    .waitFor();
  await writeFile(
    join(directory, "studio", "AGENTS.md"),
    "외부 IDE에서 바꾼 지침",
  );
  await instructionEditor
    .getByRole("button", { name: "문서를 원본 파일에 반영", exact: true })
    .click();
  await instructionEditor.getByRole("alert").waitFor();
  assert.equal(
    await readFile(join(directory, "studio", "AGENTS.md"), "utf8"),
    "외부 IDE에서 바꾼 지침",
  );
  await instructionEditor
    .getByRole("button", { name: "파일과 비교", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "파일 내용을 문서로 가져오기", exact: true })
    .click();
  await instructionEditor
    .getByText("파일 내용을 Otter 문서로 가져왔습니다.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "프로젝트 지침", exact: true })
      .inputValue(),
    "외부 IDE에서 바꾼 지침",
  );
  await page
    .getByRole("textbox", { name: "프로젝트 지침", exact: true })
    .fill("작성 중인 내 지침");
  const instruction = app.store
    .all("documents")
    .find((document) => document.kind === "instructions");
  const changed = await page.request.post(
    app.origin + "/api/documents/" + instruction.id + "/edit",
    { data: { ...instruction, content: "서버에 먼저 저장된 지침" } },
  );
  assert.equal(changed.status(), 200);
  await instructionEditor
    .getByText(
      "다른 변경이 먼저 저장되었습니다. 작성 중인 내용은 유지했습니다.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "프로젝트 지침", exact: true })
      .inputValue(),
    "작성 중인 내 지침",
  );
  assert.ok(
    await instructionEditor
      .getByRole("button", { name: "변경 저장", exact: true })
      .isDisabled(),
  );
  await page.screenshot({
    path: join(directory, "document-conflict.png"),
    fullPage: true,
  });
  await instructionEditor
    .getByRole("button", { name: "내 편집을 새 변경안으로 유지", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "저장됨 ✓", exact: true })
    .waitFor();
  await instructionEditor
    .getByRole("button", { name: "파일과 비교", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "문서를 원본 파일에 반영", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(directory, "instruction-file-comparison.png"),
    fullPage: true,
  });
  await writeFile(
    join(directory, "studio", "preserve.txt"),
    "보관 후에도 그대로",
  );
  await page.getByRole("button", { name: "⚙ 설정" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "프로젝트 보관", exact: true })
    .click();
  await page
    .getByRole("button", { name: "나의 작은 스튜디오 다시 열기" })
    .click();
  await page.getByRole("button", { name: "▦ 사무실" }).click();
  await page
    .getByRole("button", { name: "김코딩, 업무 없음, 대화 열기" })
    .waitFor();
  assert.equal(
    await readFile(join(directory, "studio", "preserve.txt"), "utf8"),
    "보관 후에도 그대로",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(directory, "office-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "모바일 가로 넘침",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "⌁ 실행 환경", exact: true }).click();
  await page
    .getByRole("textbox", { name: "환경 이름", exact: true })
    .fill("원격 UI 검사");
  await page
    .getByRole("textbox", { name: "호스트 / SSH 별칭", exact: true })
    .fill("test.invalid");
  await page.getByText("Node 경로와 실행부 저장 위치", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "실행부 전용 폴더", exact: true })
    .fill(join(directory, "remote-worker"));
  await page
    .getByRole("button", { name: "등록하고 연결", exact: true })
    .click();
  await page
    .getByRole("button", { name: "연결만 해제", exact: true })
    .waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "업무 중단·예약 반환", exact: true })
    .click();
  await page
    .getByRole("button", { name: "업무 중단·예약 반환", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(app.environments.reserved(), 0);
  await page
    .getByRole("button", { name: "연결 설정 수정", exact: true })
    .click();
  await page
    .getByRole("spinbutton", { name: "예약 실행 수", exact: true })
    .fill("2");
  await page
    .getByRole("textbox", { name: "환경 이름", exact: true })
    .fill("수정한 원격 UI 검사");
  await page
    .getByRole("button", { name: "연결 설정 저장", exact: true })
    .click();
  await page
    .getByRole("button", { name: "연결 설정 저장", exact: true })
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "다시 연결", exact: true }).click();
  await page
    .getByRole("button", { name: "연결만 해제", exact: true })
    .waitFor();
  assert.equal(app.environments.reserved(), 2);
  await page.screenshot({
    path: join(directory, "environment-lifecycle.png"),
    fullPage: true,
  });
  await page.screenshot({
    path: join(directory, "environments.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 프로젝트 시작", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "실행 환경", exact: true })
    .selectOption({ label: "수정한 원격 UI 검사 · SSH" });
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  // A remote picker must never open the local native dialog, even in an installed renderer.
  await page.evaluate(() => {
    window.otter = {
      pickFolder: async () => {
        throw new Error("원격에서 로컬 파일 선택기를 호출했습니다.");
      },
    };
  });
  await page
    .getByRole("textbox", { name: "폴더 경로", exact: true })
    .fill(directory);
  await page.getByRole("button", { name: "폴더 찾기", exact: true }).click();
  await page.getByRole("button", { name: "이 폴더 선택", exact: true }).click();
  await page
    .getByRole("textbox", { name: "새 폴더 이름", exact: true })
    .fill("remote-studio");
  await page
    .getByRole("textbox", { name: "프로젝트 표시 이름", exact: true })
    .fill("원격 스튜디오");
  await page
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "외부 IDE에서 열기", exact: true })
    .click();
  const editorDialog = page.getByRole("dialog", { name: "프로젝트 원본 열기" });
  await editorDialog
    .getByRole("textbox", { name: "VS Code에 등록한 SSH Host 별칭" })
    .fill("verified-dev-host");
  await editorDialog.getByRole("button", { name: "작업 경로 확인" }).click();
  await editorDialog.getByRole("textbox", { name: "실제로 열 폴더" }).waitFor();
  assert.equal(
    await editorDialog
      .getByRole("textbox", { name: "실제로 열 폴더" })
      .inputValue(),
    join(directory, "remote-studio"),
  );
  await editorDialog.getByText("VS Code 실행 인자", { exact: true }).click();
  await editorDialog.getByText(/ssh-remote\+verified-dev-host/).waitFor();
  await page.screenshot({
    path: join(directory, "remote-editor.png"),
    fullPage: true,
  });
  await editorDialog.getByRole("button", { name: "닫기" }).click();
  await page.getByRole("button", { name: "＋ 직원 배정", exact: true }).click();
  await page
    .getByRole("combobox", { name: "직원 선택", exact: true })
    .selectOption({ label: "김코딩 · 백엔드 개발자" });
  await page
    .getByRole("button", { name: "이 프로젝트에 배정", exact: true })
    .click();
  await page
    .getByRole("button", { name: "김코딩, 업무 없음, 대화 열기", exact: true })
    .waitFor();
  // 원격 배정도 확인한 라이브러리 버전만 가져온다. 로컬 배정은 바꾸지 않는다.
  const localAssignments = app.store.all("assignments");
  const remoteEmployee = app.store
    .all("employees")
    .find((e) => e.name === "김코딩");
  const employeeUpdate = await page.request.post(
    `${app.origin}/api/employees/${remoteEmployee.id}/edit`,
    {
      data: { ...remoteEmployee, instructions: "원격에서 선택 반영할 새 지침" },
    },
  );
  assert.equal(employeeUpdate.status(), 200);
  await page.getByRole("button", { name: "♙ 직원", exact: true }).click();
  await page.getByRole("button", { name: "원본과 비교 · 1" }).click();
  const staffDialog = page.getByRole("dialog");
  await staffDialog.getByRole("checkbox", { name: /지침 반영/ }).check();
  const refreshResponse = page.waitForResponse((r) =>
    /\/assignments\/[^/]+\/refresh$/.test(r.url()),
  );
  await staffDialog.getByRole("button", { name: "선택한 변경 반영" }).click();
  const applied = await refreshResponse;
  assert.equal(applied.status(), 200);
  const remoteAssignment = await applied.json();
  assert.equal(
    remoteAssignment.settings.instructions,
    "원격에서 선택 반영할 새 지침",
  );
  const environmentId = applied.request().headers()["x-otter-environment"];
  const rejected = await page.request.post(
    `${app.origin}/api/assignments/${remoteAssignment.id}/refresh`,
    {
      headers: {
        "x-otter-environment": environmentId,
        "idempotency-key": "staff-stale-source-request",
      },
      data: {
        revision: remoteAssignment.revision,
        sourceRevision: remoteEmployee.revision,
        fields: ["instructions"],
      },
    },
  );
  assert.equal(rejected.status(), 409);
  const remoteCurrent = await app.environments
    .client(environmentId)
    .request("GET", `/api/assignments/${remoteAssignment.id}`);
  assert.deepEqual(remoteCurrent.data, remoteAssignment);
  assert.deepEqual(app.store.all("assignments"), localAssignments);
  await staffDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "▤ 문서·지침", exact: true }).click();
  await page
    .getByRole("textbox", { name: "목표", exact: true })
    .fill("원격에만 저장되는 문서");
  await page
    .getByRole("button", { name: "변경 저장", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "저장됨 ✓", exact: true }).waitFor();
  assert.equal(app.store.all("projects").length, 1);
  assert.ok(
    !app.store
      .all("documents")
      .some((document) => document.content === "원격에만 저장되는 문서"),
  );
  await page
    .getByRole("textbox", { name: "프로젝트 지침", exact: true })
    .fill("원격 프로젝트 전용 지침");
  await instructionEditor
    .getByRole("button", { name: "변경 저장", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "저장됨 ✓", exact: true })
    .waitFor();
  await instructionEditor.getByText(/저장소 지침 파일/).click();
  await instructionEditor
    .getByRole("button", { name: "파일과 비교", exact: true })
    .click();
  await instructionEditor
    .getByRole("button", { name: "문서를 원본 파일에 반영", exact: true })
    .click();
  await instructionEditor.getByText(/원본 파일에 저장했습니다/).waitFor();
  assert.equal(
    await readFile(join(directory, "remote-studio", "AGENTS.md"), "utf8"),
    "원격 프로젝트 전용 지침",
  );
  assert.equal(
    await readFile(join(directory, "studio", "AGENTS.md"), "utf8"),
    "외부 IDE에서 바꾼 지침",
  );
  await page.getByRole("button", { name: "⌁ 실행 환경", exact: true }).click();
  await page.getByRole("button", { name: "연결만 해제", exact: true }).click();
  await page.getByRole("button", { name: "다시 연결", exact: true }).waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "실행 환경 열기", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "목표", exact: true }).inputValue(),
    "원격에만 저장되는 문서",
  );
  await page.screenshot({
    path: join(directory, "remote-offline.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "실행 환경 열기", exact: true })
    .click();
  await page.getByRole("button", { name: "다시 연결", exact: true }).click();
  await page
    .getByRole("button", { name: "연결만 해제", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 프로젝트 시작", exact: true })
    .click();
  await page.getByRole("button", { name: "아이디어부터", exact: true }).click();
  await page
    .getByRole("combobox", { name: "실행 환경", exact: true })
    .selectOption({ label: "수정한 원격 UI 검사 · SSH" });
  await page
    .getByRole("textbox", { name: "어떤 것을 만들고 싶나요?" })
    .fill("원격 아이디어를 먼저 정리한다");
  await page
    .getByRole("textbox", { name: "프로젝트 표시 이름" })
    .fill("원격 아이디어");
  await page
    .getByRole("combobox", { name: "함께 정리할 PM" })
    .selectOption({ label: "김코딩 · 백엔드 개발자" });
  await page.getByRole("button", { name: "PM 배정하고 회의실 열기" }).click();
  await page
    .getByRole("heading", { name: "아이디어 회의실", exact: true })
    .waitFor();
  for (const title of ["요구사항", "프로젝트 지침", "개발 계획"]) {
    const section = page.locator(".idea-document").filter({ hasText: title });
    await section.locator("summary").click();
    await section
      .getByRole("textbox", { name: title, exact: true })
      .fill("원격에서만 정리한 " + title);
    await section
      .getByRole("button", { name: "변경 저장", exact: true })
      .click();
    await section
      .getByRole("button", { name: "저장됨 ✓", exact: true })
      .waitFor();
  }
  await page.getByRole("textbox", { name: "폴더 경로" }).fill(directory);
  await page.getByRole("button", { name: "폴더 찾기", exact: true }).click();
  await page.getByRole("button", { name: "이 폴더 선택", exact: true }).click();
  await page.getByRole("textbox", { name: "새 폴더 이름" }).fill("remote-idea");
  await page.screenshot({
    path: join(directory, "remote-idea-ready.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "저장 위치 확정·개발 공간 열기" })
    .click();
  await page.getByRole("heading", { name: "사무실", exact: true }).waitFor();
  assert.equal(
    app.store.all("projects").length,
    1,
    "원격 아이디어를 로컬 프로젝트로 저장하지 않는다",
  );
  assert.ok(
    !app.store
      .all("documents")
      .some((d) => d.content.includes("원격에서만 정리한")),
  );
  assert.equal(
    (
      await readFile(join(directory, "remote-idea", ".git", "HEAD"), "utf8")
    ).trim(),
    "ref: refs/heads/main",
  );
  assert.deepEqual(errors, []);
  await page.getByRole("button", { name: "▤ 문서·지침", exact: true }).click();
  await page.getByText(/^회사 공유 지식 ·/).click();
  await page.getByText("공유할 노하우 직접 작성", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "공유 지식 제목", exact: true })
    .fill("원격 공유 원칙");
  await page
    .getByRole("textbox", { name: "공유할 본문", exact: true })
    .fill("원격 변경 요청은 재전송해도 중복 적용하지 않는다.");
  await page
    .getByRole("textbox", { name: "재사용할 이유", exact: true })
    .fill("연결 복구의 안전성");
  await page
    .getByRole("checkbox", { name: /본문에 기밀이 없음을 확인/ })
    .check();
  await page
    .getByRole("button", { name: "확인한 본문 공유", exact: true })
    .click();
  const knowledgeCard = page
    .locator(".knowledge-card")
    .filter({ hasText: "원격 공유 원칙" });
  await knowledgeCard
    .getByRole("heading", { name: "원격 공유 원칙", exact: true })
    .waitFor();
  assert.equal(app.store.all("knowledge").length, 1);
  assert.equal(
    app.store.all("knowledge")[0].content,
    "원격 변경 요청은 재전송해도 중복 적용하지 않는다.",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await knowledgeCard
    .getByRole("button", { name: "이 프로젝트에 가져오기", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "원격 공유 원칙", exact: true })
    .waitFor();
  assert.ok(
    !app.store.all("documents").some((d) => d.title === "원격 공유 원칙"),
  );
  await page.screenshot({
    path: join(directory, "remote-knowledge.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await knowledgeCard
    .getByRole("button", { name: "공유 중지", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "공유 중지한 지식도 보기" }).check();
  await knowledgeCard.getByText(/새 적용 중지/).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "통과: 기존 로컬/원격 흐름 + 원격 아이디어·공유 지식 작성/승인·선택 적용·공유 중지. SSH 전송은 대체, 실제 모델 미사용.",
  );
  console.log("스크린샷: " + directory);
} finally {
  await browser?.close();
  let cleanupError;
  for (const environment of app.environments.list()) {
    try {
      await app.environments.stop(environment.id);
    } catch (error) {
      cleanupError = error;
    }
  }
  await app.close();
  if (cleanupError) throw cleanupError;
}
