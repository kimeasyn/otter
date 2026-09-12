import { DomainError, required, choice } from "./store.mjs";
import { Knowledge, knowledgeFields } from "./knowledge.mjs";

const string = { type: "string" };
const tool = (name, description, properties) => ({
  type: "function",
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});
export function coworkTools(mode) {
  const tools = [
    tool(
      "otter_propose_knowledge",
      "Propose a sanitized, reusable lesson for the same company's shared library. Include only the exact excerpt to share, never credentials, source files or private conversations. Nothing is published until the human explicitly approves sharing. Other projects must opt in to use it. End the turn after proposing; Otter resumes with the decision.",
      { title: string, content: string, reason: string },
    ),
    tool(
      "otter_team",
      "Read the current project team, document IDs, and current work. Only this project is accessible.",
      {},
    ),
    tool(
      "otter_message",
      'Send a real message to an assigned colleague. Use recipientAssignmentId="project" for the project channel. Messages to idle colleagues are available in their next task.',
      { recipientAssignmentId: string, text: string },
    ),
    tool(
      "otter_propose_document",
      "Propose a complete replacement for one project document. Never modify Otter data files directly. The user reviews the before/after and approves. Finish this turn after proposing; Otter resumes it with the decision.",
      {
        documentId: string,
        revision: { type: "integer" },
        content: string,
        reason: string,
      },
    ),
  ];
  if (["delegate", "interview"].includes(mode))
    tools.push(
      tool(
        "otter_delegate",
        "Assign a bounded task to an existing teammate. Use a stable unique key for this work, and list earlier task IDs in dependsOn when their code is required. Independent tasks run concurrently. Results are handed back automatically. Do not use native subagent tools.",
        {
          key: string,
          assignmentId: string,
          prompt: string,
          dependsOn: { type: "array", items: string },
        },
      ),
      tool(
        "otter_propose_employee",
        "Propose hiring ONE new employee. The employee does not exist until the human approves role, model and reason. Use an empty model to inherit the installed Codex default. Finish this turn after proposing; Otter resumes with the decision and assigned employee ID.",
        {
          name: string,
          role: string,
          model: string,
          instructions: string,
          skills: string,
          reason: string,
        },
      ),
    );
  return mode === "interview"
    ? tools.filter((t) => t.name !== "otter_delegate")
    : tools;
}

export class Cowork {
  constructor(company) {
    this.company = company;
    this.store = company.store;
  }
  team(task) {
    return {
      team: this.store.all("assignments", task.projectId).map((a) => ({
        assignmentId: a.id,
        name: a.settings.name,
        role: a.settings.role,
        model: a.settings.model,
      })),
      documents: this.store.all("documents", task.projectId).map((d) => ({
        id: d.id,
        title: d.title,
        revision: d.revision,
        content: d.content,
      })),
      tasks: this.store
        .all("tasks", task.projectId)
        .filter((t) => t.id === task.id || t.parentTaskId === task.id)
        .map((t) => ({
          id: t.id,
          key: t.delegationKey,
          title: t.title,
          status: t.status,
          dependencies: t.dependencies,
          resultCommit: t.resultCommit,
          error: t.error,
        })),
    };
  }
  handle(task, name, args) {
    this.company.checkProjectLock(task.projectId);
    if (!coworkTools(task.mode).some((t) => t.name === name))
      throw new DomainError("이 업무에 허용되지 않은 도구입니다.", 403);
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new DomainError("도구 입력은 객체여야 합니다.");
    if (name === "otter_team") return this.team(task);
    if (name === "otter_propose_knowledge") {
      const project = this.store.get("projects", task.projectId);
      return this.propose(task, "otter/knowledge", {
        ...knowledgeFields(args),
        companyName: this.store.get("companies", project.companyId).name,
      });
    }
    if (name === "otter_delegate") {
      if (task.integrationConflict)
        throw new DomainError(
          "현재 인계 충돌을 해결한 뒤 새 업무를 배정하세요.",
        );
      const key = required(args.key, "업무 키", 80);
      const prompt = required(args.prompt, "업무 요청", 50000);
      const colleague = this.store.get(
        "assignments",
        required(args.assignmentId, "담당 직원"),
      );
      if (
        colleague.projectId !== task.projectId ||
        colleague.id === task.assignmentId
      )
        throw new DomainError("같은 프로젝트의 다른 직원을 선택해 주세요.");
      if (
        !Array.isArray(args.dependsOn) ||
        args.dependsOn.length > 32 ||
        new Set(args.dependsOn).size !== args.dependsOn.length
      )
        throw new DomainError("선행 업무 목록이 잘못되었습니다.");
      const children = this.store
        .all("tasks", task.projectId)
        .filter((t) => t.parentTaskId === task.id);
      for (const dependency of args.dependsOn)
        if (!children.some((t) => t.id === dependency))
          throw new DomainError(
            "현재 위임 목표에서 먼저 배정한 업무만 선행 업무로 지정할 수 있습니다.",
          );
      const old = children.find((t) => t.delegationKey === key);
      if (old) {
        if (
          old.assignmentId !== colleague.id ||
          old.prompt !== prompt ||
          JSON.stringify(old.dependencies) !== JSON.stringify(args.dependsOn)
        )
          throw new DomainError("같은 업무 키의 내용을 덮어쓸 수 없습니다.");
        return { taskId: old.id, status: old.status, reused: true };
      }
      // 무한 분해/재시도에 의한 사용량 폭주를 막는다. 더 큰 목표는 새 요청으로 나눈다.
      if (children.length >= 32)
        throw new DomainError(
          "이 목표의 업무 배정 한도 32개에 도달했습니다. 진행 상황을 보고하고 사용자에게 범위를 확인하세요.",
        );
      const child = this.company.requestTask(
        {
          projectId: task.projectId,
          assignmentId: colleague.id,
          prompt,
          mode: "direct",
        },
        {
          parentTaskId: task.id,
          delegationKey: key,
          dependencies: args.dependsOn,
          baseCommit: task.worktree.base,
          senderAssignmentId: task.assignmentId,
        },
      );
      return { taskId: child.id, status: child.status };
    }
    if (name === "otter_message") {
      const recipient = required(args.recipientAssignmentId, "수신 직원");
      if (recipient === task.assignmentId)
        throw new DomainError("자기 자신에게 메시지를 보낼 필요는 없습니다.");
      if (
        this.store
          .all("messages", task.projectId)
          .filter(
            (m) =>
              m.taskId === task.id &&
              m.kind === "colleague" &&
              m.generation === (task.generation || 1),
          ).length >= 32
      )
        throw new DomainError(
          "이번 실행의 직원 간 메시지 한도에 도달했습니다. 업무 결과를 보고하세요.",
        );
      if (
        recipient !== "project" &&
        this.store.get("assignments", recipient).projectId !== task.projectId
      )
        throw new DomainError("다른 프로젝트로 대화를 보낼 수 없습니다.", 403);
      return this.store.insert("messages", {
        projectId: task.projectId,
        taskId: task.id,
        assignmentId: task.assignmentId,
        sender: "assistant",
        senderAssignmentId: task.assignmentId,
        recipientAssignmentId: recipient === "project" ? null : recipient,
        text: required(args.text, "메시지", 30000),
        channel: recipient === "project" ? "project" : "team",
        delivery: "next-task",
        kind: "colleague",
        generation: task.generation || 1,
      });
    }
    if (name === "otter_propose_employee") {
      const employee = {};
      for (const [key, limit] of [
        ["name", 80],
        ["role", 120],
        ["instructions", 50000],
      ])
        employee[key] = required(args[key], key, limit);
      for (const key of ["model", "skills"]) {
        if (
          typeof args[key] !== "string" ||
          args[key].length > (key === "model" ? 120 : 50000)
        )
          throw new DomainError("직원 설정이 올바르지 않습니다.");
        employee[key] = args[key];
      }
      return this.propose(task, "otter/hire", {
        ...employee,
        reason: required(args.reason, "채용 이유", 5000),
      });
    }
    if (name === "otter_propose_document") {
      const document = this.store.get(
        "documents",
        required(args.documentId, "문서"),
      );
      if (document.projectId !== task.projectId)
        throw new DomainError(
          "다른 프로젝트의 문서는 수정할 수 없습니다.",
          403,
        );
      if (document.revision !== args.revision)
        throw new DomainError(
          "문서가 변경되었습니다. 최신 내용을 읽은 뒤 다시 제안하세요.",
          409,
        );
      if (typeof args.content !== "string" || args.content.length > 200000)
        throw new DomainError("문서는 200,000자 이하여야 합니다.");
      return this.propose(task, "otter/document", {
        documentId: document.id,
        revision: document.revision,
        title: document.title,
        before: document.content,
        content: args.content,
        reason: required(args.reason, "변경 이유", 5000),
      });
    }
  }
  propose(task, method, params) {
    const duplicate = this.store
      .all("approvals", task.projectId)
      .find(
        (a) =>
          a.taskId === task.id &&
          a.method === method &&
          a.status === "pending" &&
          JSON.stringify(a.params) === JSON.stringify(params),
      );
    if (duplicate) return { proposalId: duplicate.id, status: "pending" };
    const proposal = this.store.insert("approvals", {
      projectId: task.projectId,
      taskId: task.id,
      method,
      params,
      status: "pending",
    });
    return {
      proposalId: proposal.id,
      status: "pending",
      instruction:
        "Finish this turn. Otter will resume with the human decision. Do not pretend approval was granted.",
    };
  }
  resolve(id, input) {
    const approval = this.store.get("approvals", id);
    if (approval.status !== "pending")
      throw new DomainError("이미 처리되었거나 만료된 제안입니다.", 409);
    const decision = choice(input.decision, ["accept", "decline"], "승인");
    return this.store.transaction(() => {
      let result = { decision };
      if (decision === "accept" && approval.method === "otter/knowledge") {
        const item = new Knowledge(this.store).publish(
          approval.projectId,
          { ...approval.params, confirm: input.shareConfirmed === true },
          approval.id,
        );
        result = { ...result, knowledgeId: item.id };
      }
      if (decision === "accept" && approval.method === "otter/hire") {
        const employee = this.company.createEmployee(approval.params);
        const assignment = this.company.assign(approval.projectId, employee.id);
        result = {
          ...result,
          assignmentId: assignment.id,
          name: employee.name,
        };
      } else if (
        decision === "accept" &&
        approval.method === "otter/document"
      ) {
        const doc = this.company.editDocument(
          approval.params.documentId,
          approval.params,
        );
        result = { ...result, documentId: doc.id, revision: doc.revision };
      }
      this.store.update("approvals", id, {
        status: decision,
        result,
        resolvedAt: new Date().toISOString(),
      });
      this.store.insert("messages", {
        projectId: approval.projectId,
        taskId: approval.taskId,
        assignmentId: this.store.get("tasks", approval.taskId).assignmentId,
        sender: "user",
        text: `${approval.method === "otter/hire" ? "신규 직원 채용" : approval.method === "otter/knowledge" ? "회사 공유 지식 등록" : "문서 변경"} ${decision === "accept" ? "승인" : "거절"}${result.name ? ": " + result.name : ""}`,
        channel: "direct",
      });
      return result;
    });
  }
}
