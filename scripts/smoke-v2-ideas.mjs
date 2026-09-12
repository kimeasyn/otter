import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";
import { git } from "../apps/worker/src/git.mjs";

// Deterministic GUI flow only. No model call or account usage in this script.
let turns = 0;
class InterviewFixture extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.replies = new Map();
  }
  async initialize() {}
  async request(method, params) {
    if (method.startsWith("thread/")) {
      this.settings = params;
      return { thread: { id: "idea-ui-thread" } };
    }
    if (method === "turn/start") {
      const turn = ++turns;
      setImmediate(async () => {
        try {
          if (turn === 1) {
            assert.match(this.settings.permissions, /^otter-interview-/);
            this.complete("누가 사용할 서비스인가요? (합성 PM 질문)");
          } else if (turn === 2) {
            const team = this.tool("otter_team", {});
            for (const doc of team.documents)
              this.tool("otter_propose_document", {
                documentId: doc.id,
                revision: doc.revision,
                content: `${doc.title}: 혼자 사용하는 할 일 목록. hello.txt로 시작하고 실제 확인한 결과만 보고한다.`,
                reason: "사용자 답변을 반영한 합성 제안",
              });
            this.tool("otter_propose_employee", {
              name: "구현 담당",
              role: "개발·테스트",
              model: "",
              instructions: "승인한 범위만 구현한다",
              skills: "",
              reason: "hello.txt 구현과 검증을 담당",
            });
            this.tool("otter_propose_knowledge", {
              title: "작은 범위로 검증하기",
              content: "기능을 작게 나누고 확인한 결과만 보고한다.",
              reason:
                "다른 프로젝트에서도 과도한 구현과 허위 완료 보고를 줄인다.",
            });
            this.complete(
              "네 문서와 개발 담당을 제안했습니다. 검토해 주세요. (합성 PM)",
            );
          } else if (turn === 3)
            this.complete(
              "문서와 팀이 준비됐습니다. 저장 위치를 선택해 주세요. (합성 PM)",
            );
          else if (turn === 4) {
            this.emit("notification", {
              method: "turn/completed",
              params: {
                turn: {
                  status: "failed",
                  error: {
                    message: "합성 일시 오류",
                    codexErrorInfo: "serverOverloaded",
                  },
                },
              },
            });
          } else {
            assert.equal(this.settings.sandbox, "workspace-write");
            await writeFile(join(this.cwd, "hello.txt"), "hello\n");
            this.complete(
              "hello.txt 작성 완료. 합성 제공자 검사이며 실제 모델 작업은 아닙니다.",
            );
          }
        } catch (error) {
          this.emit("notification", {
            method: "turn/completed",
            params: {
              turn: { status: "failed", error: { message: error.message } },
            },
          });
        }
      });
      return { turn: { id: "idea-ui-turn" } };
    }
  }
  reply(id, result) {
    this.replies.set(id, result);
  }
  refuse(id) {
    throw Error("지원하지 않는 합성 요청: " + id);
  }
  close() {}
  tool(tool, args) {
    const id = this.replies.size + 1;
    this.emit("request", {
      id,
      method: "item/tool/call",
      params: {
        threadId: "idea-ui-thread",
        turnId: "idea-ui-turn",
        tool,
        arguments: args,
      },
    });
    const result = this.replies.get(id);
    assert.equal(result.success, true);
    return JSON.parse(result.contentItems[0].text);
  }
  complete(text) {
    this.emit("notification", {
      method: "item/completed",
      params: { item: { type: "agentMessage", text } },
    });
    this.emit("notification", {
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
  }
}

const directory = await mkdtemp(join(tmpdir(), "otter-idea-ui-"));
const app = await startServer({
  directory,
  port: 0,
  makeCodex: ({ cwd }) => new InterviewFixture(cwd),
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
  await page.getByRole("button", { name: "아이디어부터", exact: true }).click();
  await page
    .getByRole("combobox", { name: "회사 구성", exact: true })
    .selectOption("group");
  assert.equal(
    await page.getByRole("textbox", { name: "폴더 경로" }).count(),
    0,
  );
  await page
    .getByRole("textbox", { name: "어떤 것을 만들고 싶나요?" })
    .fill("작은 할 일 목록을 만들고 싶다");
  await page
    .getByRole("textbox", { name: "프로젝트 표시 이름" })
    .fill("아이디어 스튜디오");
  assert.equal(await page.getByRole("checkbox").count(), 0);
  assert.equal(app.store.all("projects").length, 0);
  assert.equal(app.store.all("assignments").length, 0);
  await page.getByRole("button", { name: "PM 배정하고 회의실 열기" }).click();
  await page
    .getByRole("heading", { name: "아이디어 회의실", exact: true })
    .waitFor();
  const project = app.store.all("projects")[0];
  assert.deepEqual(await readdir(project.root), []);
  assert.equal(app.store.all("tasks").length, 0);
  await page.getByRole("button", { name: "PM에게 아이디어 전달" }).click();
  await page
    .getByText("누가 사용할 서비스인가요? (합성 PM 질문)", { exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByText("누가 사용할 서비스인가요? (합성 PM 질문)", { exact: true })
    .waitFor();
  await page
    .getByRole("textbox", { name: "직원에게 업무 요청" })
    .fill("혼자 사용할 거야. hello.txt부터 시작하자.");
  await page.getByRole("button", { name: "업무 요청 보내기" }).click();
  await page.getByRole("button", { name: "채용 승인", exact: true }).waitFor();
  assert.equal(app.store.all("employees").length, 1);
  assert.equal(
    await page
      .getByRole("button", { name: "저장 위치 확정·개발 공간 열기" })
      .isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(directory, "idea-proposals.png"),
    fullPage: true,
  });
  for (let i = 0; i < 4; i++) {
    const approval = page
      .locator(".approval-card")
      .filter({
        has: page.getByRole("button", { name: "변경 반영", exact: true }),
      })
      .first();
    await approval
      .getByRole("button", { name: "변경 반영", exact: true })
      .click();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".approval-card").length === count,
      5 - i,
    );
  }
  await page.getByRole("button", { name: "채용 승인", exact: true }).click();
  assert.equal(app.store.all("knowledge").length, 0);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "본문 확인·공유 승인", exact: true })
    .click();
  assert.equal(
    app.store.all("knowledge").length,
    0,
    "공유 확인을 취소하면 등록하지 않는다",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "본문 확인·공유 승인", exact: true })
    .click();
  await page
    .getByText(
      "문서와 팀이 준비됐습니다. 저장 위치를 선택해 주세요. (합성 PM)",
      { exact: true },
    )
    .waitFor();
  const interviewTask = app.store.all("tasks")[0];
  assert.equal(
    app.store.all("tasks").length,
    1,
    "답변은 같은 인터뷰를 이어간다",
  );
  const goal = page.locator(".idea-document").filter({ hasText: /^목표 ·/ });
  await goal.locator("summary").click();
  await goal
    .getByRole("textbox", { name: "목표", exact: true })
    .fill(
      "혼자 쓰는 할 일 목록. hello.txt로 시작한다. 사용자가 직접 다듬은 목표.",
    );
  assert.equal(
    await page
      .getByRole("button", { name: "저장 위치 확정·개발 공간 열기" })
      .isDisabled(),
    true,
    "작성 중인 문서를 전환으로 잃지 않는다",
  );
  await page.getByRole("button", { name: "▤ 문서·지침" }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "목표", exact: true }).inputValue(),
    "혼자 쓰는 할 일 목록. hello.txt로 시작한다. 사용자가 직접 다듬은 목표.",
  );
  await page.getByRole("button", { name: "▦ 사무실" }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "저장 위치 확정·개발 공간 열기" })
      .isDisabled(),
    true,
    "문서 화면을 다녀온 뒤에도 복원된 초안이 개발 전환을 막는다",
  );
  await goal.locator("summary").click();
  await goal.getByRole("button", { name: "변경 저장", exact: true }).click();
  await goal.getByRole("button", { name: "저장됨 ✓", exact: true }).waitFor();
  await goal.locator("summary").click();
  await page.getByRole("textbox", { name: "폴더 경로" }).fill(directory);
  await page.getByRole("button", { name: "폴더 찾기", exact: true }).click();
  await page.getByRole("button", { name: "이 폴더 선택", exact: true }).click();
  await page.getByRole("textbox", { name: "새 폴더 이름" }).fill("service");
  assert.equal(await page.getByRole("checkbox").count(), 0);
  assert.equal(app.store.get("projects", project.id).stage, "idea");
  await page.screenshot({
    path: join(directory, "idea-ready.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "아이디어 화면의 모바일 가로 넘침",
  );
  await page.screenshot({
    path: join(directory, "idea-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "저장 위치 확정·개발 공간 열기" })
    .click();
  await page.getByRole("heading", { name: "사무실", exact: true }).waitFor();
  assert.equal(
    app.store.get("projects", project.id).root,
    join(directory, "service"),
  );
  assert.equal(
    app.store.get("tasks", interviewTask.id).providerThreadId,
    "idea-ui-thread",
  );
  await page.getByRole("button", { name: "⚙ 설정", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "일시적 오류 자동 재시도 횟수" })
    .fill("1");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await (await fetch("/api/state")).json()).settings.retries === 1,
  );
  await page.getByRole("button", { name: "▦ 사무실", exact: true }).click();
  await page
    .getByRole("button", { name: "구현 담당, 업무 없음, 대화 열기" })
    .click();
  await page
    .getByRole("textbox", { name: "직원에게 업무 요청" })
    .fill("hello.txt 작성해 줘");
  await page.getByRole("button", { name: "업무 요청 보내기" }).click();
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page.getByText("재시도 대기", { exact: true }).waitFor();
  await page.screenshot({
    path: join(directory, "retry-pending.png"),
    fullPage: true,
  });
  await page
    .locator(".task-card")
    .filter({
      has: page.getByRole("heading", {
        name: "hello.txt 작성해 줘",
        exact: true,
      }),
    })
    .getByRole("button", { name: "대화 열기 →", exact: true })
    .click();
  await page
    .getByText(
      "hello.txt 작성 완료. 합성 제공자 검사이며 실제 모델 작업은 아닙니다.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "☷ 업무", exact: true }).click();
  await page
    .getByRole("button", { name: "검토 완료", exact: true })
    .last()
    .click();
  assert.equal(
    await page
      .getByRole("dialog", { name: "업무 결과 검토" })
      .getByRole("checkbox")
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "확인한 결과를 완료 처리", exact: true })
    .click();
  const development = app.store
    .all("tasks")
    .find((t) => t.mode !== "interview");
  assert.equal(development.retryCount, 1);
  assert.equal(development.maxRetries, 1);
  assert.equal(development.attempt, 2);
  assert.equal(
    await git(join(directory, "service"), [
      "show",
      `${development.resultCommit}:hello.txt`,
    ]),
    "hello",
  );
  assert.deepEqual(errors, []);
  assert.equal(app.store.all("knowledge").length, 1);
  assert.ok(
    !app.store.all("documents", project.id).some((d) => d.kind === "knowledge"),
  );
  await page
    .getByRole("button", { name: "＋ 프로젝트 시작", exact: true })
    .click();
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  await page
    .getByRole("combobox", { name: "회사", exact: true })
    .selectOption(project.companyId);
  await page.getByRole("textbox", { name: "폴더 경로" }).fill(directory);
  await page
    .getByRole("textbox", { name: "새 폴더 이름" })
    .fill("second-project");
  await page
    .getByRole("textbox", { name: "프로젝트 표시 이름" })
    .fill("재사용할 프로젝트");
  await page
    .getByRole("button", { name: "프로젝트 열기", exact: true })
    .click();
  await page.getByRole("button", { name: "▤ 문서·지침", exact: true }).click();
  await page.getByText(/^회사 공유 지식 ·/).click();
  const card = page
    .locator(".knowledge-card")
    .filter({ hasText: "작은 범위로 검증하기" });
  await card.getByText("공유 본문 확인", { exact: true }).click();
  const target = app.store
    .all("projects")
    .find((p) => p.name === "재사용할 프로젝트");
  assert.equal(app.store.all("documents", target.id).length, 3);
  page.once("dialog", (dialog) => dialog.accept());
  await card
    .getByRole("button", { name: "이 프로젝트에 가져오기", exact: true })
    .click();
  await card
    .getByRole("button", { name: "이 프로젝트에 가져옴", exact: true })
    .waitFor();
  const editor = page.locator(".document-editor").filter({
    has: page.getByRole("heading", {
      name: "작은 범위로 검증하기",
      exact: true,
    }),
  });
  await editor
    .getByRole("textbox", { name: "작은 범위로 검증하기", exact: true })
    .fill("이 프로젝트에서는 작은 테스트부터 작성한다.");
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await editor.getByRole("button", { name: "저장됨 ✓", exact: true }).waitFor();
  assert.equal(
    app.store.all("knowledge")[0].content,
    "기능을 작게 나누고 확인한 결과만 보고한다.",
  );
  await page.screenshot({
    path: join(directory, "knowledge-copy.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "공유 중지", exact: true }).click();
  await page.getByRole("checkbox", { name: "공유 중지한 지식도 보기" }).check();
  await card.getByText(/새 적용 중지/).waitFor();
  assert.equal(
    await editor
      .getByRole("textbox", { name: "작은 범위로 검증하기", exact: true })
      .inputValue(),
    "이 프로젝트에서는 작은 테스트부터 작성한다.",
  );
  assert.deepEqual(errors, []);
  console.log(
    "통과: 아이디어 전체 GUI 흐름 + 재시도 설정·대기·동일 대화 복귀 + 직원 공유 제안·확인 취소/승인·다른 프로젝트 선택 적용·사본 편집·공유 중지. 합성 제공자, 실제 모델 미사용.",
  );
  console.log("증거: " + directory);
} finally {
  await browser?.close();
  await app.close();
}
