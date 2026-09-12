// 명시적으로 실행하는 유료/구독 사용 수용 테스트. 자동 테스트에서는 호출하지 않는다.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../apps/worker/src/server.mjs";

if (!process.argv.includes("--run"))
  throw new Error(
    "기존 Codex 계정의 사용량을 소비합니다. 실행하려면 --run을 지정하세요.",
  );
const directory = await mkdtemp(join(tmpdir(), "otter-live-codex-"));
const pmMode = process.argv.includes("--pm");
const ideaMode = process.argv.includes("--idea");
if (pmMode && ideaMode)
  throw new Error("--pm과 --idea는 별도로 검사해 주세요.");
const app = await startServer({ directory, port: 0 });
const call = async (path, input) => {
  const response = await fetch(app.origin + "/api/" + path, {
    method: input ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + app.token,
      "Content-Type": "application/json",
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
};
console.log("실제 Codex 임시 검사: " + directory);
try {
  const company = await call("companies", {
    name: "Codex 연결 확인",
    mode: "single",
  });
  const project = ideaMode
    ? await prepareIdea(company)
    : await call("projects", {
        companyId: company.id,
        create: true,
        parent: directory,
        folder: "project",
      });
  const employee = ideaMode
    ? null
    : await call("employees", {
        name: "연동 확인",
        role: pmMode ? "PM" : "단일 파일 작성",
        instructions: pmMode
          ? "계획과 배정은 Otter 도구로만 진행하세요. 원래 목표에 필요하지 않은 추가 업무나 신규 직원 제안은 하지 마세요. 직접 파일을 만들지 마세요."
          : "요청한 파일 하나만 apply_patch로 작성하세요. 셸, 네트워크, 하위 에이전트 호출은 하지 마세요.",
      });
  const assignment = ideaMode
    ? { id: project.developerAssignmentId }
    : await call("assignments", {
        projectId: project.id,
        employeeId: employee.id,
      });
  if (pmMode)
    for (const role of ["개발자", "리뷰어"]) {
      const colleague = await call("employees", {
        name: role,
        role,
        instructions:
          role === "개발자"
            ? "요청 파일 하나만 apply_patch로 작성하세요. 셸, 네트워크, 새 에이전트 호출 금지."
            : "인계된 파일은 정확히 cat -- hello.txt 명령 하나로 읽어 리뷰하고 한 문장으로 보고하세요. Python 등 다른 명령은 쓰지 마세요. 파일을 변경하거나 네트워크를 사용하지 마세요.",
      });
      await call("assignments", {
        projectId: project.id,
        employeeId: colleague.id,
      });
    }
  const task = await call("tasks", {
    projectId: project.id,
    assignmentId: assignment.id,
    mode: pmMode ? "delegate" : "direct",
    prompt: pmMode
      ? "otter_team으로 팀을 확인한 뒤 개발자에게 hello.txt 파일 하나를 만들고 정확히 Hello Otter 한 줄을 넣도록 otter_delegate로 배정하세요. 이어서 리뷰어에게 그 개발 업무 ID를 dependsOn으로 지정하여 실제 파일 내용을 확인하는 업무를 배정하세요. 업무는 정확히 두 개면 됩니다. 직접 코딩/명령 실행/새 직원 채용은 하지 마세요. 배정 후 턴을 마치고, Otter가 팀 결과를 전달해 재개하면 실제 보고를 확인해 최종 결과를 한 문장으로 보고하세요."
      : "이 임시 폴더에 hello.txt 파일 하나를 만들고 정확히 Hello Otter 한 줄을 넣어 주세요. apply_patch만 사용하고 완료 보고는 한 문장으로 해 주세요.",
  });
  let lastStatus = "";
  let state;
  const deadline = Date.now() + (pmMode ? 240000 : 180000);
  while (true) {
    state = await call("state?projectId=" + project.id);
    const current = state.tasks.find((t) => t.id === task.id);
    if (current.status !== lastStatus) {
      console.log("업무 상태: " + current.status);
      lastStatus = current.status;
    }
    for (const approval of state.approvals.filter(
      (a) => a.status === "pending",
    )) {
      const changes = approval.params.changes;
      const target = state.tasks.find((t) => t.id === approval.taskId);
      // 이 테스트가 생성한 정확한 파일의 작은 추가만 승인한다. 실행 명령/다른 경로는 승인하지 않는다.
      const fileAllowed =
        approval.method === "item/fileChange/requestApproval" &&
        !approval.params.grantRoot &&
        changes?.length === 1 &&
        resolve(target.worktree.path, changes[0].path) ===
          join(target.worktree.path, "hello.txt") &&
        changes[0].diff.includes("Hello Otter") &&
        changes[0].diff.length < 500;
      const readAllowed =
        pmMode &&
        approval.method === "item/commandExecution/requestApproval" &&
        approval.params.cwd === target.worktree.path &&
        !approval.params.networkApprovalContext &&
        !approval.params.additionalPermissions &&
        [
          "cat -- hello.txt",
          "/bin/bash -lc 'cat -- hello.txt'",
          '/bin/bash -lc "cat -- hello.txt"',
        ].includes(approval.params.command);
      const allowed = fileAllowed || readAllowed;
      if (!allowed)
        throw new Error(
          "테스트 범위를 벗어나거나 내용을 확인할 수 없는 승인 요청: " +
            JSON.stringify(approval.params),
        );
      await call(`approvals/${approval.id}/resolve`, {
        decision: "accept",
        ...(readAllowed ? { scopeConfirmed: true } : {}),
      });
      console.log(
        fileAllowed
          ? "검사 폴더 hello.txt 변경만 승인"
          : "검사 폴더 hello.txt 읽기만 승인",
      );
    }
    if (
      ["review", "failed", "interrupted", "blocked"].includes(current.status)
    ) {
      assert.equal(
        current.status,
        "review",
        current.error || "Codex 실행 실패",
      );
      assert.equal(
        (
          await readFile(join(current.worktree.path, "hello.txt"), "utf8")
        ).trim(),
        "Hello Otter",
      );
      if (pmMode) {
        const children = state.tasks.filter((t) => t.parentTaskId === task.id);
        assert.equal(children.length, 2);
        assert.ok(children.every((t) => t.status === "handoff"));
        const review = children.find((t) => t.settings.role === "리뷰어");
        assert.ok(
          app.store
            .events()
            .some(
              (e) =>
                e.kind === "execution.item" &&
                e.data.taskId === review?.id &&
                e.data.type === "commandExecution" &&
                e.data.status === "completed" &&
                e.data.exitCode === 0,
            ),
          "리뷰어의 실제 파일 읽기 명령 성공 이벤트가 필요합니다.",
        );
        assert.equal(
          state.messages.filter((m) => m.kind === "handoff").length,
          2,
        );
        assert.ok(
          current.generation >= 2,
          "PM이 팀 결과 이후 재개되어야 합니다",
        );
      } else
        assert.equal(
          state.reports.filter((r) => r.taskId === task.id).length,
          1,
        );
      await call(`tasks/${task.id}/accept`, {
        revision: current.revision,
        confirm: true,
      });
      console.log(
        "통과: 실제 파일 생성 → 보고 → 사용자 검토 완료. 임시 파일을 보존합니다.",
      );
      break;
    }
    if (Date.now() > deadline)
      throw new Error(
        "검사 대기 한도 초과. 실행을 중단하며 자동 재실행하지 않습니다.",
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await app.close();
}

async function prepareIdea(company) {
  const initial = await call("projects/idea", {
    companyId: company.id,
    name: "실제 PM 아이디어 검사",
    idea: "hello.txt로 시작하는 작은 프로젝트",
    confirmPM: true,
    pm: {
      name: "인터뷰 PM",
      model: "",
      instructions:
        "짧은 인터뷰와 Otter 문서·채용 제안만 수행한다. 셸·파일 변경·외부 서비스 호출 금지. 사용자가 정한 문서와 직원 설정을 정확히 사용한다.",
    },
  });
  const task = await call("tasks", {
    projectId: initial.id,
    assignmentId: initial.pmAssignmentId,
    prompt:
      "개발 전 아이디어 인터뷰입니다. 이번 응답에서는 'hello.txt에 어떤 내용을 넣을까요?'라는 질문 하나만 하고 턴을 마치세요. 도구 호출이나 문서 제안은 다음 답변 뒤에 하세요.",
  });
  const expected = {
    목표: "hello.txt 파일 하나에 Hello Otter 한 줄을 작성한다.",
    요구사항:
      "hello.txt 내용은 정확히 Hello Otter 한 줄이다. 다른 파일·네트워크·외부 공개는 범위에서 제외한다.",
    "프로젝트 지침":
      "hello.txt만 apply_patch로 작성한다. 셸·네트워크·하위 에이전트 호출은 하지 않는다.",
    "개발 계획":
      "파일 담당이 hello.txt를 작성하고 결과를 보고한다. 사용자가 파일 내용을 확인한 뒤 검토 완료한다.",
  };
  const hire = {
    name: "파일 담당",
    role: "단일 파일 작성",
    model: "",
    instructions:
      "요청한 hello.txt 하나만 apply_patch로 작성한다. 셸·네트워크·하위 에이전트 호출은 하지 않는다.",
    skills: "",
  };
  const waitForInterview = async (approve) => {
    const deadline = Date.now() + 240000;
    let last = "";
    while (true) {
      const state = await call("state?projectId=" + initial.id);
      const current = state.tasks.find((t) => t.id === task.id);
      if (last !== current.status) {
        console.log("인터뷰 상태: " + current.status);
        last = current.status;
      }
      for (const proposal of state.approvals.filter(
        (a) => a.status === "pending",
      )) {
        const allowed =
          approve &&
          ((proposal.method === "otter/document" &&
            proposal.params.content === expected[proposal.params.title]) ||
            (proposal.method === "otter/hire" &&
              Object.entries(hire).every(
                ([key, value]) => proposal.params[key] === value,
              )));
        if (!allowed)
          throw Error("정한 인터뷰 검사 범위 밖의 제안: " + proposal.method);
        await call(`approvals/${proposal.id}/resolve`, { decision: "accept" });
        console.log(
          "검사에서 정한 " +
            (proposal.method === "otter/hire"
              ? "직원 설정"
              : proposal.params.title) +
            "만 승인",
        );
      }
      if (
        ["review", "failed", "interrupted", "blocked"].includes(current.status)
      ) {
        assert.equal(current.status, "review", current.error || "인터뷰 실패");
        return state;
      }
      if (Date.now() > deadline)
        throw Error("인터뷰 검사 시간 초과. 자동 재실행하지 않습니다.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  await waitForInterview(false);
  await call(`tasks/${task.id}/continue`, {
    prompt: `Hello Otter 한 줄로 하자. otter_team으로 실제 문서 ID를 확인하고, 다음 네 문서의 내용을 정확히 제안해 줘: ${JSON.stringify(expected)}. 다음 직원 설정도 정확히 otter_propose_employee로 제안하고 필요 이유를 설명해 줘: ${JSON.stringify(hire)}. 구현하지 말고 제안 후 턴을 마쳐. Otter가 사용자 결정을 전달하면 반영 여부를 확인하고 준비 상태를 한 문장으로 보고해 줘. 승인된 내용을 반복 제안하지 마.`,
  });
  const state = await waitForInterview(true);
  for (const [title, content] of Object.entries(expected))
    assert.equal(
      state.documents.find((d) => d.title === title)?.content,
      content,
    );
  const developer = state.assignments.find(
    (a) => a.settings.name === hire.name,
  );
  assert.ok(developer, "승인한 개발 직원이 필요합니다");
  const current = state.tasks.find((t) => t.id === task.id);
  assert.ok(current.generation >= 3, "질문/답변과 승인 이후 같은 인터뷰 재개");
  assert.equal(current.resultCommit, undefined);
  const project = await call(`projects/${initial.id}/activate`, {
    revision: initial.revision,
    confirm: true,
    parent: directory,
    folder: "project",
    documents: Object.fromEntries(
      state.documents.map((d) => [d.id, d.revision]),
    ),
    team: Object.fromEntries(state.assignments.map((a) => [a.id, a.revision])),
  });
  assert.equal(project.id, initial.id);
  console.log("실제 PM 인터뷰·문서/채용 승인·저장 위치 확정 통과");
  return { ...project, developerAssignmentId: developer.id };
}
