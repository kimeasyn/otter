import { join } from "node:path";
import { configuredCodex } from "./codex.mjs";
import { isolatedWorktree, git, checkpoint, integrate } from "./git.mjs";
import { DomainError, choice, required } from "./store.mjs";
import { Company } from "./company.mjs";
import { Cowork, coworkTools } from "./cowork.mjs";
import { applyTaskInstructions } from "./instructions.mjs";
import { verifyTask, stopVerification } from "./verification.mjs";
import {
  approvalReview,
  localApprovalEnvironment,
} from "./approval-review.mjs";
import { editorTarget } from "./editor.mjs";

const activeStates = ["running", "waiting"];
// 공식 오류 종류만 허용한다. 오류 메시지 문자열로 인증/설정 오류를 추측하지 않는다.
function transientFailure(info) {
  if (typeof info === "string")
    return [
      "rateLimitExceeded",
      "serverOverloaded",
      "internalServerError",
    ].includes(info);
  if (!info || typeof info !== "object" || Object.keys(info).length !== 1)
    return false;
  const [kind, details] = Object.entries(info)[0];
  if (!details || typeof details !== "object" || Array.isArray(details))
    return false;
  if (
    ![
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].includes(kind)
  )
    return false;
  const status = details?.httpStatusCode;
  return (
    status == null ||
    status === 408 ||
    status === 429 ||
    (Number.isInteger(status) && status >= 500 && status <= 599)
  );
}
function mayHaveActed(item) {
  return (
    ![
      "userMessage",
      "agentMessage",
      "reasoning",
      "plan",
      "contextCompaction",
    ].includes(item.type) &&
    !(item.type === "dynamicToolCall" && item.tool === "otter_team")
  );
}
export class Runner {
  constructor(
    store,
    directory,
    makeCodex = (options) => configuredCodex(store, options),
  ) {
    this.store = store;
    this.directory = directory;
    this.makeCodex = makeCodex;
    this.active = new Map();
    this.stopping = false;
    this.capacity = () => this.store.settings().concurrency;
    this.cowork = new Cowork(new Company(store));
    for (const message of store
      .all("messages")
      .filter((m) => m.kind === "steering" && m.delivery === "sending"))
      store.update("messages", message.id, { delivery: "unconfirmed" });
    // 단일 실행부 소유권은 서버의 파일 잠금이 보장한다. 프로세스 유실을 완료로 간주하지 않는다.
    for (const task of store
      .all("tasks")
      .filter(
        (t) => activeStates.includes(t.status) || t.executionUnconfirmed,
      )) {
      store.update("tasks", task.id, {
        status: "interrupted",
        interruptionConfirmed: false,
        error:
          "실행부가 재시작되었습니다. 기존 실행 상태를 확인한 후 새 업무로 요청해 주세요.",
        ...(task.verification
          ? {
              verification: {
                ...task.verification,
                status: "interrupted",
                error: "실행부가 재시작되어 검증 결과를 확정하지 않았습니다.",
              },
            }
          : {}),
      });
    }
    for (const approval of store
      .all("approvals")
      .filter((a) => a.status === "pending" && !a.method.startsWith("otter/")))
      store.update("approvals", approval.id, { status: "expired" });
  }
  pump() {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    const queued = this.store.all("tasks").filter((t) => t.status === "queued");
    const nextRetry = Math.min(
      ...queued.map((t) => Date.parse(t.retryAt)).filter((t) => t > Date.now()),
    );
    if (Number.isFinite(nextRetry)) {
      this.retryTimer = setTimeout(
        () => this.pump(),
        Math.max(1, nextRetry - Date.now()),
      );
      this.retryTimer.unref?.();
    }
    for (const task of this.store
      .all("tasks")
      .filter((t) => t.status === "coordinating"))
      this.wake(task);
    const waitingEmployees = new Set();
    for (const task of this.store
      .all("tasks")
      .filter((t) => t.status === "queued")) {
      if (this.active.size >= this.capacity()) break;
      if (this.store.hasUnconfirmedOperation(task.projectId)) continue;
      if (this.store.projectLocks.has(task.projectId)) continue;
      if (waitingEmployees.has(task.assignmentId)) continue;
      waitingEmployees.add(task.assignmentId);
      if (Date.parse(task.retryAt) > Date.now()) continue;
      const dependencies = (task.dependencies || []).map((id) =>
        this.store.get("tasks", id),
      );
      if (
        dependencies.some((t) =>
          ["failed", "interrupted", "blocked"].includes(t.status),
        )
      ) {
        this.store.update("tasks", task.id, {
          status: "blocked",
          error: "선행 업무에 해결할 문제가 있습니다.",
        });
        queueMicrotask(() => this.pump());
        continue;
      }
      if (
        dependencies.some(
          (t) => !["handoff", "review", "completed"].includes(t.status),
        )
      )
        continue;
      // 같은 직원의 대화 순서를 유지하며, 다른 직원은 병렬 실행한다.
      if (
        [...this.active.values()].some(
          (run) => run.assignmentId === task.assignmentId,
        )
      )
        continue;
      const run = {
        assignmentId: task.assignmentId,
        client: null,
        cancelled: false,
        terminal: false,
        items: new Map(),
        finalizing: false,
      };
      this.active.set(task.id, run);
      this.start(task, run).catch((error) =>
        this.finish(
          task.id,
          run,
          error instanceof DomainError && error.status === 409
            ? "blocked"
            : "failed",
          error.message,
        ),
      );
    }
    this.onIdle?.();
  }
  async start(task, run) {
    this.store.update("tasks", task.id, {
      status: "running",
      attempt: task.attempt + 1,
      retryAt: null,
      error: null,
      verification: null,
    });
    const project = this.store.get("projects", task.projectId);
    const interview = task.mode === "interview";
    const interviewProfile = `otter-interview-${task.id}`;
    if (interview && project.stage !== "idea")
      throw new DomainError("이미 개발 단계로 전환한 인터뷰입니다.", 409);
    const worktree = interview
      ? { path: project.root, branch: "", base: null }
      : task.worktree ||
        (await (run.preparation = isolatedWorktree(
          project.root,
          join(this.directory, "worktrees", task.id),
          task.id,
          task.baseCommit || "HEAD",
        )));
    if (run.terminal) return;
    if (task.worktree && !interview) {
      const target = await (run.preparation = editorTarget(
        this.store,
        this,
        project.id,
        task.id,
      ));
      if (target.branch !== worktree.branch)
        throw new DomainError(
          "직원 작업 브랜치가 바뀌었습니다. 기존 브랜치를 확인한 뒤 다시 요청해 주세요. 자동 전환하지 않습니다.",
          409,
        );
    }
    this.store.update("tasks", task.id, { worktree });
    if (run.cancelled || run.finalizing)
      return this.finish(task.id, run, "interrupted");
    const sources =
      task.mode === "delegate"
        ? this.children(task).filter((t) => t.resultCommit)
        : (task.dependencies || []).map((id) => this.store.get("tasks", id));
    const commits = sources
      .map((t) => t.resultCommit)
      .filter((c) => c && !(task.integratedCommits || []).includes(c));
    if (commits.length && !task.integrationConflict) {
      try {
        await (run.preparation = integrate(worktree, commits));
      } catch (error) {
        this.store.update("tasks", task.id, {
          integrationConflict: { commits },
        });
        return this.finish(task.id, run, "blocked", error.message);
      }
      this.store.update("tasks", task.id, {
        integratedCommits: [...(task.integratedCommits || []), ...commits],
      });
    }
    if (run.terminal) return;
    if (run.cancelled || run.finalizing)
      return this.finish(task.id, run, "interrupted");
    if (!interview)
      await (run.preparation = applyTaskInstructions(
        task,
        worktree,
        this.store,
      ));
    if (run.terminal) return;
    if (run.cancelled) return this.finish(task.id, run, "interrupted");
    const client = this.makeCodex({ cwd: worktree.path });
    run.client = client;
    client.on("disconnected", (error) =>
      this.finish(task.id, run, "interrupted", error.message),
    );
    client.on("request", (message) => this.serverRequest(task, run, message));
    client.on("notification", (message) =>
      this.notification(task, run, message),
    );
    await client.initialize(true);
    if (run.terminal) return;
    if (run.cancelled || run.finalizing)
      return this.finish(task.id, run, "interrupted");
    // 구버전/조회 실패는 환경 증거 없음으로 남긴다. 모델 실행이나 권한 승인이 아니다.
    run.approvalEnvironment = localApprovalEnvironment(
      await client
        .request("environment/info", { environmentId: "local" })
        .catch(() => null),
      worktree.path,
    );
    if (run.terminal) return;
    if (run.cancelled || run.finalizing)
      return this.finish(task.id, run, "interrupted");
    const context = task.documents
      .map((d) => `## ${d.title}\n${d.content}`)
      .join("\n\n");
    const thread = await client.request(
      task.providerThreadId ? "thread/resume" : "thread/start",
      {
        ...(task.providerThreadId
          ? { threadId: task.providerThreadId }
          : { dynamicTools: coworkTools(task.mode) }),
        cwd: worktree.path,
        ...(interview
          ? { permissions: interviewProfile }
          : { sandbox: "workspace-write" }),
        approvalPolicy: interview ? "never" : "untrusted",
        approvalsReviewer: "user",
        config: {
          ...(interview
            ? {
                [`permissions.${interviewProfile}`]: {
                  filesystem: {
                    ":root": "deny",
                    ":minimal": "read",
                    [worktree.path]: "read",
                  },
                  network: { enabled: false },
                },
                web_search: "disabled",
              }
            : {}),
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          "features.memories": false,
        },
        ...(task.settings.model ? { model: task.settings.model } : {}),
        developerInstructions: interview
          ? `You are ${task.settings.name}, the PM interviewing the user about a new idea.\n${task.settings.instructions}\nSkills:\n${task.settings.skills}\nProject documents:\n${context}\nOnly clarify the idea, propose project documents and propose needed employees through Otter tools. Ask concise questions in your reply and end the turn for the user to answer. Do not implement, delegate, run commands, write files or use external services. The user must review the documents and select a development repository in Otter before development. Document edits and new hires require approval. Never invent user decisions or claim development is complete.`
          : `You are ${task.settings.name}, role: ${task.settings.role}.\n${task.settings.instructions}\nSkills:\n${task.settings.skills}\nProject documents:\n${context}\nWork only on the assigned request in this isolated task branch. Never merge into the base branch, push, deploy, start paid services, or create new agents without asking the user. Report actual changes, actual checks and unverified items separately. Do not claim task acceptance; the user reviews it in Otter. Use otter_team for real team/document/task IDs. Use otter_propose_document to propose changes to Otter documents and otter_message for actual colleague messages. Do not fabricate colleague dialogue. ${task.mode === "delegate" ? "You are the PM for this goal. Plan and delegate bounded implementation/test/review tasks to actual assigned staff with otter_delegate, using dependsOn for code handoffs. Propose missing staff with otter_propose_employee; they do not exist until approved. Do not spawn native Codex subagents. After delegation/proposals, end your turn with a brief status: Otter releases your execution slot, waits for results or decisions, and resumes this same thread automatically. Do not poll or sleep waiting for staff. When resumed, inspect integrated results, arrange missing tests/review as needed, and deliver the final report." : "Complete your assigned scope; results will be checkpointed in your task branch and handed to the PM automatically. Do not assign work or hire employees."}`,
      },
    );
    if (run.terminal) return;
    run.threadId = thread.thread.id;
    this.store.update("tasks", task.id, { providerThreadId: run.threadId });
    if (run.cancelled) return this.finish(task.id, run, "interrupted");
    const inbox = this.store
      .all("messages", task.projectId)
      .filter(
        (m) =>
          m.kind !== "steering" &&
          ((m.recipientAssignmentId === task.assignmentId &&
            m.channel === "team" &&
            m.delivery !== "delivered") ||
            m.channel === "project"),
      )
      .slice(-20);
    const coordination = this.coordination(task);
    this.store.update("tasks", task.id, {
      observedCoordination: coordination.version,
    });
    const continuation = task.providerThreadId
      ? `\n\nCurrent Otter team results and decisions (real records):\n${JSON.stringify(coordination.context)}`
      : "";
    const result = await client.request("turn/start", {
      threadId: run.threadId,
      ...(interview
        ? {
            approvalPolicy: "never",
            permissions: interviewProfile,
          }
        : {}),
      input: [
        {
          type: "text",
          text:
            (interview
              ? "IDEA INTERVIEW ONLY. The user has not selected a development repository or authorized implementation. Do not execute commands, write files, delegate implementation, use external services, or claim development is complete. Ask concise necessary questions in your normal reply, then end the turn so the user can answer. Use otter_team and otter_propose_document to propose the goal, requirements (including acceptance criteria and excluded scope), project instructions and development plan. Propose necessary staff with role/model/reason using otter_propose_employee; approval is mandatory. Do not invent user decisions. When the documents are ready, ask the user to review them and select a save location in Otter. Otter, not you, changes the project into development mode.\n\n"
              : "") +
            (task.integrationConflict
              ? "IMPORTANT: this task worktree has a preserved merge conflict. Resolve the conflict, stage the resolved files, and verify the integrated result before reporting completion. Do not discard either colleague result.\n\n"
              : "") +
            (task.nextPrompt || task.prompt) +
            (task.retryAt
              ? "\n\nOtter is retrying after a confirmed provider failure before any action was observed. Continue the same request in this thread; do not repeat completed earlier work. Inspect existing state before making changes."
              : "") +
            continuation +
            (inbox.length
              ? "\n\nColleague messages:\n" +
                JSON.stringify(
                  inbox.map((m) => ({
                    from: m.senderAssignmentId,
                    text: m.text,
                  })),
                )
              : ""),
          text_elements: [],
        },
      ],
    });
    if (!run.terminal) {
      run.turnId = result.turn.id;
      this.store.update("tasks", task.id, { providerTurnId: result.turn.id });
      for (const message of inbox.filter(
        (m) => m.channel === "team" && m.delivery !== "delivered",
      ))
        this.store.update("messages", message.id, { delivery: "delivered" });
    }
  }
  serverRequest(task, run, message) {
    if (run.terminal || run.finalizing) return;
    if (
      !message.params ||
      typeof message.params !== "object" ||
      Array.isArray(message.params)
    ) {
      run.client.refuse(message.id);
      return;
    }
    if (
      message.method !== "item/tool/call" ||
      message.params.tool !== "otter_team"
    )
      run.sideEffects = true;
    if (
      task.mode === "interview" &&
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(message.method)
    ) {
      run.client.reply(
        message.id,
        message.method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" }
          : { decision: "decline" },
      );
      this.store.event(task.projectId, "interview.permissionDeclined", {
        taskId: task.id,
        method: message.method,
      });
      return;
    }
    if (message.method === "item/tool/call") {
      try {
        if (
          message.params.threadId !== run.threadId ||
          (run.turnId && message.params.turnId !== run.turnId)
        )
          throw new DomainError("다른 실행의 도구 요청입니다.", 403);
        const result = this.cowork.handle(
          this.store.get("tasks", task.id),
          message.params.tool,
          message.params.arguments,
        );
        run.client.reply(message.id, {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        });
        if (message.params.tool === "otter_message") void this.deliver(result);
        this.pump();
      } catch (error) {
        run.client.reply(message.id, {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text:
                error instanceof DomainError
                  ? error.message
                  : "도구 요청을 처리하지 못했습니다. 사용자에게 보고하세요.",
            },
          ],
        });
      }
      return;
    }
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/requestUserInput",
      ].includes(message.method)
    ) {
      run.client.refuse(message.id);
      this.store.insert("reports", {
        projectId: task.projectId,
        taskId: task.id,
        title: "지원하지 않는 권한 요청",
        text: "자동 승인하지 않았습니다. 요청 종류: " + message.method,
        kind: "blocker",
      });
      return;
    }
    if (
      !run.threadId ||
      message.params?.threadId !== run.threadId ||
      typeof message.params?.turnId !== "string" ||
      !message.params.turnId ||
      (run.turnId && message.params.turnId !== run.turnId)
    ) {
      run.client.refuse(message.id);
      this.store.event(task.projectId, "approval.wrongExecution", {
        taskId: task.id,
        method: message.method,
      });
      return;
    }
    const params = {
      ...message.params,
      ...(message.method === "item/fileChange/requestApproval"
        ? { changes: run.items.get(message.params.itemId)?.changes }
        : {}),
    };
    const previous = this.store
      .all("approvals", task.projectId)
      .find(
        (a) =>
          a.taskId === task.id &&
          a.requestId === message.id &&
          a.params.threadId === params.threadId &&
          a.params.turnId === params.turnId,
      );
    if (previous) {
      if (
        previous.status === "pending" &&
        previous.method === message.method &&
        JSON.stringify(previous.params) === JSON.stringify(params)
      )
        return;
      if (previous.status === "pending")
        this.store.update("approvals", previous.id, { status: "expired" });
      run.client.refuse(message.id);
      if (
        !this.store
          .all("approvals", task.projectId)
          .some((a) => a.taskId === task.id && a.status === "pending")
      )
        this.store.update("tasks", task.id, { status: "running" });
      return;
    }
    this.store.insert("approvals", {
      projectId: task.projectId,
      taskId: task.id,
      requestId: message.id,
      method: message.method,
      params,
      review: approvalReview(message.method, params, run.approvalEnvironment),
      status: "pending",
    });
    this.store.update("tasks", task.id, { status: "waiting" });
  }
  async steer(id, input) {
    const task = this.store.get("tasks", id);
    const run = this.active.get(id);
    const company = new Company(this.store);
    company.checkProjectLock(task.projectId);
    if (
      this.store.get("projects", task.projectId).archived ||
      this.stopping ||
      task.status !== "running" ||
      task.executionUnconfirmed ||
      !run ||
      run.cancelled ||
      run.terminal ||
      run.finalizing ||
      run.verifier ||
      !run.client ||
      run.client.closed ||
      !run.threadId ||
      !run.turnId
    )
      throw new DomainError(
        "현재 추가 지시를 받을 수 있는 실행이 아닙니다. 업무 상태와 질문·승인을 확인해 주세요.",
        409,
      );
    if (
      !Number.isInteger(input.generation) ||
      input.generation !== task.generation ||
      input.turnId !== task.providerTurnId ||
      input.turnId !== run.turnId
    )
      throw new DomainError(
        "업무 실행이 변경되었습니다. 현재 실행을 확인한 뒤 다시 요청해 주세요.",
        409,
      );
    if (run.steering)
      throw new DomainError(
        "앞선 추가 지시의 전달 결과를 확인하고 있습니다.",
        409,
      );
    if (
      this.store
        .all("messages", task.projectId)
        .some(
          (m) =>
            m.taskId === id &&
            m.kind === "steering" &&
            ["sending", "unconfirmed"].includes(m.delivery) &&
            m.generation === task.generation,
        )
    )
      throw new DomainError(
        "전달 여부가 미확인인 추가 지시가 있습니다. 현재 실행의 응답과 결과를 먼저 확인해 주세요. 자동 재전송하지 않습니다.",
        409,
      );
    const text = required(input.prompt, "추가 지시", 50000);
    const message = this.store.insert("messages", {
      projectId: task.projectId,
      taskId: id,
      assignmentId: task.assignmentId,
      sender: "user",
      text,
      channel: task.channel || "direct",
      kind: "steering",
      generation: task.generation,
      delivery: "sending",
      providerTurnId: run.turnId,
    });
    const turnId = run.turnId;
    run.steering = (async () => {
      let delivery = "unconfirmed";
      try {
        const result = await run.client.request("turn/steer", {
          threadId: run.threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        if (result?.turnId === turnId) delivery = "delivered";
      } catch (error) {
        if (error.rpcRejected === true) delivery = "rejected";
      }
      // 추가 지시를 접수했을 가능성이 있으면 이전 입력만으로 자동 재시도하지 않는다.
      if (delivery !== "rejected") run.sideEffects = true;
      return this.store.update("messages", message.id, { delivery });
    })();
    try {
      return await run.steering;
    } finally {
      run.steering = null;
    }
  }
  async deliver(message) {
    if (!message.recipientAssignmentId) return;
    const run = [...this.active.values()].find(
      (r) =>
        r.assignmentId === message.recipientAssignmentId &&
        !r.finalizing &&
        !r.terminal &&
        r.threadId &&
        r.turnId,
    );
    if (!run) return;
    try {
      await run.client.request("turn/steer", {
        threadId: run.threadId,
        expectedTurnId: run.turnId,
        input: [
          {
            type: "text",
            text: `Colleague message ${message.id} from ${message.senderAssignmentId}:\n${message.text}`,
            text_elements: [],
          },
        ],
      });
      if (!this.stopping)
        this.store.update("messages", message.id, { delivery: "delivered" });
    } catch {
      // 턴이 이미 끝났거나 연결이 불확실하면 다음 실행의 수신함에 남긴다.
    }
  }
  notification(task, run, { method, params }) {
    if (
      run.terminal ||
      run.finalizing ||
      (run.threadId && params?.threadId && params.threadId !== run.threadId) ||
      (run.turnId && params?.turnId && params.turnId !== run.turnId) ||
      (method === "turn/completed" &&
        run.turnId &&
        params.turn.id &&
        params.turn.id !== run.turnId)
    )
      return;
    if (method === "turn/started") run.turnId = params.turn.id;
    if (["hook/started", "hook/completed"].includes(method))
      run.sideEffects = true;
    if (
      ["item/started", "item/completed"].includes(method) &&
      mayHaveActed(params.item)
    )
      run.sideEffects = true;
    if (
      method === "item/started" &&
      ["commandExecution", "fileChange"].includes(params.item.type)
    )
      run.items.set(params.item.id, params.item);
    if (method === "item/completed" && params.item.type === "agentMessage") {
      this.store.insert("messages", {
        projectId: task.projectId,
        taskId: task.id,
        assignmentId: task.assignmentId,
        sender: "assistant",
        text: params.item.text,
        generation: task.generation || 1,
        channel: task.channel || "direct",
      });
    }
    if (
      method === "item/completed" &&
      ["commandExecution", "fileChange"].includes(params.item.type)
    ) {
      const item = params.item;
      this.store.event(task.projectId, "execution.item", {
        taskId: task.id,
        type: item.type,
        status: item.status,
        command: item.command,
        exitCode: item.exitCode,
        changes: item.changes?.map((c) => ({ path: c.path, kind: c.kind })),
      });
    }
    if (method === "serverRequest/resolved") {
      for (const approval of this.store
        .all("approvals", task.projectId)
        .filter(
          (a) =>
            a.taskId === task.id &&
            a.requestId === params.requestId &&
            a.status === "pending",
        ))
        this.store.update("approvals", approval.id, { status: "expired" });
      if (
        !this.store
          .all("approvals", task.projectId)
          .some((a) => a.taskId === task.id && a.status === "pending")
      )
        this.store.update("tasks", task.id, { status: "running" });
    }
    if (method === "turn/completed") {
      const status = params.turn.status;
      if (params.turn.items?.some(mayHaveActed)) run.sideEffects = true;
      run.retryable =
        status === "failed" &&
        transientFailure(params.turn.error?.codexErrorInfo);
      this.finish(
        task.id,
        run,
        status === "completed"
          ? "review"
          : status === "interrupted"
            ? "interrupted"
            : "failed",
        params.turn.error?.message,
      );
    }
  }
  approve(id, input) {
    const approval = this.store.get("approvals", id);
    if (approval.status !== "pending")
      throw new DomainError("이미 처리되었거나 만료된 요청입니다.", 409);
    if (approval.method.startsWith("otter/")) {
      const result = this.cowork.resolve(id, input);
      this.pump();
      return result;
    }
    const run = this.active.get(approval.taskId);
    if (!run?.client || run.terminal || run.finalizing || run.client.closed)
      throw new DomainError("실행 연결이 없어 승인할 수 없습니다.", 409);
    if (
      approval.params.threadId !== run.threadId ||
      !run.turnId ||
      approval.params.turnId !== run.turnId
    )
      throw new DomainError(
        "다른 대화 또는 종료된 턴의 요청은 승인할 수 없습니다.",
        409,
      );
    const review = approvalReview(
      approval.method,
      approval.params,
      run.approvalEnvironment,
    );
    if (review && !review.decisions.includes(input.decision))
      throw new DomainError("이 요청에서 지원하지 않는 승인 선택입니다.");
    if (review && input.decision === "accept") {
      if (!review.canAccept) throw new DomainError(review.blockedReason);
      if (review.acknowledgement && input.scopeConfirmed !== true)
        throw new DomainError("추가 접근 범위와 실행 영향을 확인해 주세요.");
    }
    let reply;
    if (
      input.decision === "accept" &&
      approval.method === "item/fileChange/requestApproval" &&
      !approval.params.changes?.length
    )
      throw new DomainError(
        "변경할 파일 내용을 확인할 수 없어 승인할 수 없습니다. 작업을 중단하고 다시 확인해 주세요.",
      );
    if (approval.method === "item/permissions/requestApproval") {
      if (input.permissions !== undefined || input.scope !== undefined)
        throw new DomainError(
          "요청한 권한이나 적용 기간을 승인 입력으로 바꿀 수 없습니다.",
        );
      reply = {
        permissions:
          input.decision === "accept" ? approval.params.permissions : {},
        scope: "turn",
      };
    } else if (approval.method === "item/tool/requestUserInput") {
      const answers = {};
      for (const question of approval.params.questions) {
        const answer = input.answers?.[question.id];
        if (
          typeof answer !== "string" ||
          !answer.trim() ||
          answer.length > 10000
        )
          throw new DomainError("각 질문에 답변해 주세요.");
        answers[question.id] = { answers: [answer] };
      }
      reply = { answers };
    } else
      reply = {
        decision: choice(
          input.decision,
          ["accept", "decline", "cancel"],
          "승인",
        ),
      };
    // acceptForSession을 사용하지 않는다. 현재 요청의 승인만 전달한다.
    run.client.reply(approval.requestId, reply);
    this.store.update("approvals", id, {
      status: input.decision ?? "answered",
      ...(review
        ? {
            resolvedScope: reply,
            scopeConfirmed: input.scopeConfirmed === true,
          }
        : {}),
      resolvedAt: new Date().toISOString(),
    });
    if (
      !this.store
        .all("approvals", approval.projectId)
        .some((a) => a.taskId === approval.taskId && a.status === "pending")
    )
      this.store.update("tasks", approval.taskId, { status: "running" });
  }
  async cancel(id) {
    const task = this.store.get("tasks", id);
    const run = this.active.get(id);
    if (run) run.cancelled = true;
    else if (["queued", "coordinating", "blocked"].includes(task.status))
      this.store.update("tasks", id, { status: "interrupted" });
    for (const child of this.children(task).filter((t) =>
      ["queued", "running", "waiting", "coordinating"].includes(t.status),
    ))
      await this.cancel(child.id);
    if (["queued", "coordinating", "blocked"].includes(task.status) && !run) {
      this.store.update("tasks", id, {
        status: "interrupted",
        retryAt: null,
        interruptionConfirmed: task.executionUnconfirmed !== true,
        finishedAt: new Date().toISOString(),
      });
      for (const approval of this.store
        .all("approvals", task.projectId)
        .filter((a) => a.taskId === id && a.status === "pending"))
        this.store.update("approvals", approval.id, { status: "expired" });
      queueMicrotask(() => this.pump());
      return;
    }
    if (!run || run.terminal)
      throw new DomainError("실행 중인 업무가 아닙니다.", 409);
    run.cancelled = true;
    if (run.verifier) {
      await stopVerification(run);
      return this.finish(id, run, "interrupted");
    }
    if (run.turnId && !run.client.closed)
      await run.client.request("turn/interrupt", {
        threadId: run.threadId,
        turnId: run.turnId,
      });
    else if (run.client) this.finish(id, run, "interrupted");
  }
  finish(id, run, status, error) {
    if (run.terminal || run.finalizing) return run.finishPromise;
    run.finalizing = true;
    run.finishPromise = this.finalize(id, run, status, error).finally(() => {
      if (!run.terminal) run.finalizing = false;
    });
    return run.finishPromise;
  }
  async finalize(id, run, status, error) {
    // 시작 중 Git/지침 작업도 끝난 뒤 종료를 확정한다. 재개와 이전 준비 작업이 겹치지 않는다.
    await run.preparation?.catch(() => {});
    const task = this.store.get("tasks", id);
    try {
      await run.client?.close();
      await run.steering;
      await stopVerification(run);
    } catch (closeError) {
      this.store.update("tasks", id, {
        status: "blocked",
        error: closeError.message,
        executionUnconfirmed: true,
        interruptionConfirmed: false,
      });
      return;
    }
    if (status === "review" && task.worktree && task.mode !== "interview") {
      try {
        const resultCommit = await checkpoint(task.worktree, task.title);
        for (const commit of task.integrationConflict?.commits || [])
          await git(task.worktree.path, [
            "merge-base",
            "--is-ancestor",
            commit,
            resultCommit,
          ]);
        this.store.update("tasks", id, {
          resultCommit,
          ...(task.integrationConflict
            ? {
                integratedCommits: [
                  ...(task.integratedCommits || []),
                  ...task.integrationConflict.commits,
                ],
                integrationConflict: null,
              }
            : {}),
        });
      } catch {
        status = "blocked";
        error = "결과 커밋을 만들지 못했습니다. 작업 파일은 보존했습니다.";
      }
    }
    if (run.cancelled) {
      status = "interrupted";
      error = "사용자가 실행을 중단했습니다.";
    }
    const latest = this.store.get("tasks", id);
    const retryCount = latest.retryCount || 0;
    const maxRetries = latest.maxRetries ?? this.store.settings().retries;
    const retry =
      status === "failed" &&
      run.retryable &&
      !run.sideEffects &&
      !this.stopping &&
      !run.cancelled &&
      retryCount < maxRetries;
    const retryAt = retry
      ? new Date(
          Date.now() +
            Math.min(60000, 2000 * 2 ** retryCount) * (1 + Math.random() * 0.2),
        ).toISOString()
      : null;
    if (status === "failed")
      error = `${error || "Codex 실행 실패"}\n${
        retry
          ? `자동 재시도 ${retryCount + 1}/${maxRetries}회 대기 중입니다.`
          : run.sideEffects
            ? "명령·도구 실행 또는 승인 요청이 있어 자동 재시도하지 않았습니다. 기존 결과를 확인해 주세요."
            : retryCount >= maxRetries
              ? `자동 재시도 한도 ${maxRetries}회에 도달했습니다.`
              : "자동 복구 대상이 아닌 오류입니다. 실행 환경과 오류를 확인해 주세요."
      }`;
    const coordination = this.coordination(latest);
    if (
      status === "review" &&
      (coordination.pending ||
        coordination.version !== latest.observedCoordination)
    )
      status = "coordinating";
    if (status === "review" && task.parentTaskId) status = "handoff";
    let verification;
    if (
      status === "review" &&
      task.mode !== "interview" &&
      (task.checks?.length || task.completion === "verified")
    ) {
      try {
        verification = await verifyTask(
          this.store.get("tasks", id),
          run,
          this.store,
          this.directory,
          this.makeCodex,
        );
      } catch {
        this.store.update("tasks", id, {
          status: "blocked",
          executionUnconfirmed: true,
          error:
            "검증 프로세스의 종료를 확인하지 못했습니다. 실행 자리를 유지합니다.",
          verification: {
            ...this.store.get("tasks", id).verification,
            status: "unconfirmed",
          },
        });
        return;
      }
      if (task.completion === "verified") {
        status = verification.status === "passed" ? "completed" : "blocked";
        error = verification.error;
      }
    }
    if (run.cancelled) {
      status = "interrupted";
      error = "사용자가 실행을 중단했습니다.";
    }
    run.terminal = true;
    if (status === "interrupted" && this.store.get("tasks", id).verification)
      verification = {
        ...this.store.get("tasks", id).verification,
        status: "interrupted",
        error: "검증을 중단하여 결과를 확정하지 않았습니다.",
      };
    this.store.transaction(() => {
      this.store.update("tasks", id, {
        status: retry ? "queued" : status,
        executionUnconfirmed: false,
        interruptionConfirmed: status === "interrupted" && !retry,
        ...(verification ? { verification } : {}),
        error: error ?? null,
        finishedAt: retry ? null : new Date().toISOString(),
        retryAt,
        retryCount: retry ? retryCount + 1 : retryCount,
        maxRetries,
        ...(status === "completed"
          ? { acceptedAt: new Date().toISOString(), acceptedBy: "verification" }
          : {}),
        ...(retry
          ? { generation: (task.generation || 1) + 1, providerTurnId: null }
          : {}),
      });
      for (const approval of this.store
        .all("approvals", task.projectId)
        .filter(
          (a) =>
            a.taskId === id &&
            a.status === "pending" &&
            (!a.method.startsWith("otter/") ||
              ["interrupted", "failed", "blocked"].includes(status)),
        ))
        this.store.update("approvals", approval.id, { status: "expired" });
      const messages = this.store
        .all("messages", task.projectId)
        .filter(
          (m) =>
            m.taskId === id &&
            m.sender === "assistant" &&
            (m.generation || 1) === (task.generation || 1),
        );
      const summary =
        error ||
        messages.at(-1)?.text ||
        (status === "coordinating"
          ? "팀의 결과나 사용자 결정을 기다리고 있습니다."
          : "직원 응답이 없습니다. 작업 결과를 확인해 주세요.");
      this.store.insert("reports", {
        projectId: task.projectId,
        taskId: id,
        title: task.title,
        kind: retry
          ? "progress"
          : ["review", "handoff", "completed"].includes(status)
            ? "result"
            : status === "coordinating"
              ? "progress"
              : "blocker",
        text: summary,
        generation: task.generation || 1,
        verification: verification?.status || "independent-check-pending",
        ...(verification ? { verificationResult: verification } : {}),
      });
      if (task.parentTaskId && !retry) {
        const parent = this.store.get("tasks", task.parentTaskId);
        this.store.insert("messages", {
          projectId: task.projectId,
          taskId: id,
          assignmentId: task.assignmentId,
          sender: "assistant",
          senderAssignmentId: task.assignmentId,
          recipientAssignmentId: parent.assignmentId,
          channel: "team",
          text: summary,
          kind: "handoff",
          delivery: "next-task",
        });
      }
    });
    this.active.delete(id);
    queueMicrotask(() => this.pump());
  }
  children(task) {
    return this.store
      .all("tasks", task.projectId)
      .filter((t) => t.parentTaskId === task.id);
  }
  coordination(task) {
    const children = this.children(task);
    const approvals = this.store
      .all("approvals", task.projectId)
      .filter((a) => a.taskId === task.id && a.method.startsWith("otter/"));
    const pending =
      children.some((t) =>
        ["queued", "running", "waiting", "coordinating"].includes(t.status),
      ) || approvals.some((a) => a.status === "pending");
    const context = {
      children: children.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        resultCommit: t.resultCommit,
        error: t.error,
      })),
      decisions: approvals
        .filter((a) => a.status !== "pending")
        .map((a) => ({
          id: a.id,
          method: a.method,
          status: a.status,
          result: a.result,
        })),
    };
    return { pending, context, version: JSON.stringify(context) };
  }
  wake(task) {
    if (this.active.has(task.id)) return;
    const coordination = this.coordination(task);
    if (!coordination.pending)
      this.store.update("tasks", task.id, {
        status: "queued",
        nextPrompt:
          "팀의 결과와 사용자 결정을 확인하고 원래 요청을 계속 진행하세요. 필요한 후속 업무만 배정하고, 모두 마쳤다면 결과·검증·미검증 항목을 보고하세요.",
        generation: (task.generation || 1) + 1,
        documents: this.cowork.company.documentSnapshot(task.projectId),
        settings: {
          ...this.store.get("assignments", task.assignmentId).settings,
        },
      });
  }
  accept(id, input = {}) {
    const task = this.store.get("tasks", id);
    if (this.stopping || this.active.has(id) || task.executionUnconfirmed)
      throw new DomainError(
        "실행 또는 종료 확인이 진행 중입니다. 결과가 확정된 뒤 검토해 주세요.",
        409,
      );
    if (task.status !== "review")
      throw new DomainError("검토 요청 상태인 업무만 완료할 수 있습니다.", 409);
    if (
      input.confirm !== true ||
      !Number.isInteger(input.revision) ||
      input.revision < 1
    )
      throw new DomainError(
        "검토한 업무의 변경 번호와 명시적 확인이 필요합니다.",
      );
    if (input.revision !== task.revision)
      throw new DomainError(
        "검토 대상이 변경되었습니다. 최신 보고와 검증 결과를 다시 확인해 주세요.",
        409,
      );
    const result = this.store.update(
      "tasks",
      id,
      {
        status: "completed",
        acceptedAt: new Date().toISOString(),
        acceptedBy: "user",
        acceptedReview: {
          revision: task.revision,
          generation: task.generation || 1,
          resultCommit: task.resultCommit || null,
        },
      },
      input.revision,
    );
    queueMicrotask(() => this.pump());
    return result;
  }
  async diff(id) {
    const task = this.store.get("tasks", id);
    if (task.mode === "interview") return { diff: "", untracked: "" };
    if (!task.worktree) return { diff: "", untracked: "" };
    return {
      diff: await git(task.worktree.path, ["diff", task.worktree.base, "--"]),
      untracked: await git(task.worktree.path, [
        "ls-files",
        "--others",
        "--exclude-standard",
      ]),
    };
  }
  async close() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    await Promise.all(
      [...this.active].map(([id, run]) => {
        run.cancelled = true;
        return stopVerification(run).then(() =>
          this.finish(
            id,
            run,
            "interrupted",
            "사용자가 실행부를 종료했습니다.",
          ),
        );
      }),
    );
    if (this.active.size)
      throw new DomainError(
        "실행 중인 프로세스의 종료를 확인하지 못했습니다. 실행부와 예약을 유지합니다.",
        503,
      );
  }
}
