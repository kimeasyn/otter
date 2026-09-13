import { DomainError, required, choice } from "./store.mjs";
import { repository, createRepository } from "./git.mjs";
import { initialInstructions } from "./instructions.mjs";
import { completionPolicy } from "./verification.mjs";

const appearance = (
  input,
  fallback = { avatar: "default", color: "#5a7be9" },
) => ({
  avatar: choice(
    input.avatar ?? input.appearance?.avatar ?? fallback.avatar,
    ["default", "glasses", "bob", "curly", "cap", "headset"],
    "아바타",
  ),
  color: /^#[0-9a-f]{6}$/i.test(input.appearance?.color || "")
    ? input.appearance.color
    : fallback.color,
});
const employeeFields = (input) => ({
  name: required(input.name, "직원 이름", 80),
  role: required(input.role, "역할", 120),
  model:
    typeof input.model === "string" ? input.model.trim().slice(0, 120) : "",
  instructions: required(input.instructions, "지침", 50000),
  skills: typeof input.skills === "string" ? input.skills.slice(0, 50000) : "",
});
export class Company {
  constructor(store) {
    this.store = store;
  }
  createCompany(input) {
    return this.store.insert("companies", {
      name: required(input.name, "회사 이름", 80),
      mode: choice(input.mode, ["single", "group"], "회사 구성"),
    });
  }
  importSettings(input, overwrite = false) {
    const result = {};
    for (const [table, value] of [
      ["companies", input.company],
      ["employees", input.employee],
    ]) {
      if (!value) continue;
      if (
        typeof value.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(value.id) ||
        !Number.isInteger(value.revision) ||
        value.revision < 1
      )
        throw new DomainError("설정 식별자/버전이 올바르지 않습니다.");
      const settings =
        table === "companies"
          ? {
              name: required(value.name, "회사 이름", 80),
              mode: choice(value.mode, ["single", "group"], "회사 구성"),
            }
          : {
              ...employeeFields(value),
              appearance: appearance(value),
              sourceId: value.sourceId || null,
              sourceRevision: value.sourceRevision || null,
              sourceSnapshot: value.sourceSnapshot
                ? employeeFields(value.sourceSnapshot)
                : null,
            };
      result[table] = this.store.importSetting(
        table,
        {
          ...settings,
          id: value.id,
          revision: value.revision,
          createdAt: value.createdAt || new Date().toISOString(),
        },
        { overwrite },
      );
    }
    return result;
  }
  async addProject(input, internal = {}) {
    const company = this.store.get(
      "companies",
      required(input.companyId, "회사"),
    );
    if (
      company.mode === "single" &&
      this.store
        .all("projects")
        .some((p) => p.companyId === company.id && !p.archived)
    )
      throw new DomainError(
        "이 회사는 프로젝트 하나를 사용합니다. 다른 회사를 만들거나 프로젝트 묶음 회사를 선택해 주세요.",
        409,
      );
    const repo =
      internal.repo ||
      (input.create
        ? await createRepository(input.parent, input.folder)
        : await repository(input.root));
    const instructions =
      internal.stage === "idea"
        ? { content: "" }
        : await initialInstructions(repo.root).catch((error) => ({
            content: "",
            sourceWarning: error.message,
          }));
    return this.store.transaction(() => {
      if (this.store.all("projects").some((p) => p.root === repo.root))
        throw new DomainError(
          "이미 등록된 저장소입니다. 프로젝트 목록에서 열어 주세요.",
          409,
        );
      // 비동기 파일 검사 중 다른 요청이 들어왔을 때도 단일 프로젝트 제약을 지킨다.
      if (
        company.mode === "single" &&
        this.store
          .all("projects")
          .some((p) => p.companyId === company.id && !p.archived)
      )
        throw new DomainError("이 회사에는 이미 프로젝트가 있습니다.", 409);
      const project = this.store.insert("projects", {
        companyId: company.id,
        ...repo,
        name: input.name
          ? required(input.name, "프로젝트 이름", 120)
          : repo.name,
        environment: "local",
        archived: false,
        stage: internal.stage || "development",
        completion: "manual",
        checks: [],
        policy: { merge: "approval", push: "approval", deploy: "approval" },
      });
      for (const [title, content] of [
        ["목표", input.idea || ""],
        ["요구사항", ""],
        ["프로젝트 지침", ""],
      ])
        this.store.insert("documents", {
          projectId: project.id,
          title,
          content,
          scope: "project",
          ...(title === "프로젝트 지침"
            ? { kind: "instructions", ...instructions }
            : {}),
        });
      if (internal.stage === "idea") {
        this.store.insert("documents", {
          projectId: project.id,
          title: "개발 계획",
          content: "",
          scope: "project",
          kind: "plan",
        });
        const employee = internal.employeeId
          ? this.store.get("employees", internal.employeeId)
          : this.createEmployee(internal.pm);
        const assignment = this.assign(project.id, employee.id);
        return this.store.update("projects", project.id, {
          pmAssignmentId: assignment.id,
        });
      }
      return project;
    });
  }
  archiveProject(id) {
    this.checkProjectLock(id);
    if (
      this.store
        .all("tasks", id)
        .some((task) =>
          ["queued", "running", "waiting", "coordinating"].includes(
            task.status,
          ),
        )
    )
      throw new DomainError(
        "진행 중이거나 대기 중인 업무를 먼저 중단해 주세요.",
        409,
      );
    // 파일, Git worktree, 대화 기록을 삭제하지 않고 연결 목록에서만 보관 처리한다.
    return this.store.update("projects", id, { archived: true });
  }
  configureCompletion(id, input) {
    this.checkProjectLock(id);
    const project = this.store.get("projects", id);
    if (project.archived || project.stage === "idea")
      throw new DomainError(
        "개발 중인 프로젝트에서 완료 방식을 설정해 주세요.",
        409,
      );
    if (!Number.isInteger(input.revision))
      throw new DomainError("설정 기준 버전이 필요합니다.", 409);
    return this.store.update(
      "projects",
      id,
      completionPolicy(input),
      input.revision,
    );
  }
  restoreProject(id) {
    const project = this.store.get("projects", id);
    const company = this.store.get("companies", project.companyId);
    if (
      company.mode === "single" &&
      this.store
        .all("projects")
        .some((p) => p.id !== id && p.companyId === company.id && !p.archived)
    )
      throw new DomainError(
        "단일 프로젝트 회사에 다른 프로젝트가 있습니다. 먼저 현재 프로젝트를 보관해 주세요.",
        409,
      );
    return this.store.update("projects", id, { archived: false });
  }
  createEmployee(input) {
    const source = input.sourceId
      ? this.store.get("employees", input.sourceId)
      : null;
    if (source && input.sourceRevision !== source.revision)
      throw new DomainError(
        "기반 직원이 변경되었습니다. 최신 설정을 다시 확인해 주세요.",
        409,
      );
    return this.store.insert("employees", {
      ...employeeFields(input),
      sourceId: source?.id ?? null,
      sourceRevision: source?.revision ?? null,
      sourceSnapshot: source ? employeeFields(source) : null,
      appearance: appearance(input, source?.appearance),
    });
  }
  editEmployee(id, input) {
    if (!Number.isInteger(input.revision))
      throw new DomainError(
        "편집 기준 버전이 필요합니다. 새로고침해 주세요.",
        409,
      );
    return this.store.update(
      "employees",
      id,
      {
        ...employeeFields(input),
        appearance: appearance(
          input,
          this.store.get("employees", id).appearance,
        ),
      },
      input.revision,
    );
  }
  assign(projectId, employeeId) {
    this.checkProjectLock(projectId);
    const project = this.store.get("projects", projectId);
    if (project.archived) throw new DomainError("보관된 프로젝트입니다.");
    const employee = this.store.get("employees", employeeId);
    const current = this.store
      .all("assignments", projectId)
      .find((a) => a.employeeId === employeeId);
    if (current) return current;
    return this.store.insert("assignments", {
      projectId,
      employeeId,
      employeeRevision: employee.revision,
      settings: employeeFields(employee),
      appearance: employee.appearance,
    });
  }
  refreshAssignment(id, fields, revision, sourceRevision) {
    this.checkProjectLock(this.store.get("assignments", id).projectId);
    if (!Number.isInteger(revision))
      throw new DomainError("편집 기준 버전이 필요합니다.", 409);
    if (
      !Array.isArray(fields) ||
      !fields.length ||
      fields.some(
        (key) =>
          !["name", "role", "model", "instructions", "skills"].includes(key),
      )
    )
      throw new DomainError("반영할 설정 항목을 선택해 주세요.");
    const assignment = this.store.get("assignments", id);
    const employee = this.store.get("employees", assignment.employeeId);
    if (sourceRevision !== employee.revision)
      throw new DomainError(
        "원본 직원이 변경되었습니다. 최신 설정을 다시 비교해 주세요.",
        409,
      );
    const settings = { ...assignment.settings };
    for (const field of fields) settings[field] = employee[field];
    return this.store.update(
      "assignments",
      id,
      { settings, employeeRevision: employee.revision },
      revision,
    );
  }
  editAssignment(id, input) {
    this.checkProjectLock(this.store.get("assignments", id).projectId);
    if (!Number.isInteger(input.revision))
      throw new DomainError("편집 기준 버전이 필요합니다.", 409);
    return this.store.update(
      "assignments",
      id,
      {
        settings: employeeFields(input),
        appearance: appearance(
          input,
          this.store.get("assignments", id).appearance,
        ),
      },
      input.revision,
    );
  }
  refreshEmployee(id, fields, revision, sourceRevision) {
    if (!Number.isInteger(revision))
      throw new DomainError("편집 기준 버전이 필요합니다.", 409);
    const employee = this.store.get("employees", id);
    if (!employee.sourceId)
      throw new DomainError("파생 직원만 원본 변경을 가져올 수 있습니다.");
    if (
      !Array.isArray(fields) ||
      !fields.length ||
      fields.some(
        (key) =>
          !["name", "role", "model", "instructions", "skills"].includes(key),
      )
    )
      throw new DomainError("반영할 설정 항목을 선택해 주세요.");
    const source = this.store.get("employees", employee.sourceId);
    if (sourceRevision !== source.revision)
      throw new DomainError(
        "기반 직원이 변경되었습니다. 최신 설정을 다시 비교해 주세요.",
        409,
      );
    const patch = {
      sourceRevision: source.revision,
      sourceSnapshot: employeeFields(source),
    };
    for (const key of fields) patch[key] = source[key];
    return this.store.update("employees", id, patch, revision);
  }
  editDocument(id, input) {
    this.checkProjectLock(this.store.get("documents", id).projectId);
    if (this.store.documentLocks.has(id))
      throw new DomainError(
        "지침 파일과 동기화하는 중입니다. 완료 후 다시 저장해 주세요.",
        409,
      );
    if (!Number.isInteger(input.revision))
      throw new DomainError(
        "편집 기준 버전이 필요합니다. 새로고침해 주세요.",
        409,
      );
    if (typeof input.content !== "string" || input.content.length > 200000)
      throw new DomainError("문서 내용은 200,000자 이하여야 합니다.");
    return this.store.update(
      "documents",
      id,
      {
        title: required(input.title, "문서 제목", 120),
        content: input.content,
      },
      input.revision,
    );
  }
  editTask(id, input) {
    const task = this.store.get("tasks", id);
    this.checkProjectLock(task.projectId);
    if (!Number.isInteger(input.revision))
      throw new DomainError("최신 업무 버전을 확인해 주세요.", 409);
    return this.store.update(
      "tasks",
      id,
      {
        title: required(input.title, "업무 제목", 80),
      },
      input.revision,
    );
  }
  requestTask(input, internal = {}) {
    const project = this.store.get(
      "projects",
      required(input.projectId, "프로젝트"),
    );
    const assignment = this.store.get(
      "assignments",
      required(input.assignmentId, "담당 직원"),
    );
    this.checkProjectLock(project.id);
    if (project.stage === "idea" && assignment.id !== project.pmAssignmentId)
      throw new DomainError(
        "아이디어 단계에서는 PM과 요구사항을 먼저 정리해 주세요.",
        409,
      );
    if (project.archived || assignment.projectId !== project.id)
      throw new DomainError("프로젝트에 배정된 직원을 선택해 주세요.");
    const prompt = required(input.prompt, "요청", 50000);
    return this.store.transaction(() => {
      const task = this.store.insert("tasks", {
        projectId: project.id,
        assignmentId: assignment.id,
        title: prompt.split("\n")[0].slice(0, 100),
        prompt,
        nextPrompt: prompt,
        mode:
          project.stage === "idea"
            ? "interview"
            : choice(
                input.mode ?? "direct",
                ["direct", "delegate"],
                "요청 방식",
              ),
        channel: choice(
          input.channel ?? "direct",
          ["direct", "project"],
          "대화방",
        ),
        parentTaskId: internal.parentTaskId ?? null,
        delegationKey: internal.delegationKey ?? null,
        dependencies: internal.dependencies ?? [],
        baseCommit: internal.baseCommit ?? null,
        generation: 1,
        status: "queued",
        attempt: 0,
        retryCount: 0,
        maxRetries: this.store.settings().retries,
        settings: { ...assignment.settings },
        documents: this.documentSnapshot(project.id),
        completion: project.completion,
        checks: structuredClone(project.checks || []),
        automationPolicyId: project.automation?.id || null,
        providerThreadId: null,
        providerTurnId: null,
      });
      this.store.insert("messages", {
        projectId: project.id,
        taskId: task.id,
        assignmentId: assignment.id,
        sender: internal.senderAssignmentId ? "assistant" : "user",
        senderAssignmentId: internal.senderAssignmentId ?? null,
        recipientAssignmentId: internal.senderAssignmentId
          ? assignment.id
          : null,
        text: prompt,
        channel: internal.senderAssignmentId
          ? "team"
          : input.channel || "direct",
      });
      return task;
    });
  }
  continueTask(id, input) {
    const task = this.store.get("tasks", id);
    if (task.executionUnconfirmed)
      throw new DomainError(
        "기존 실행의 종료가 확인되지 않아 같은 업무를 재실행하지 않습니다.",
        409,
      );
    if (task.status === "interrupted") {
      if (task.interruptionConfirmed !== true)
        throw new DomainError(
          "종료 확인 기록이 없는 중단 업무입니다. 기존 실행 상태와 작업 파일을 먼저 확인해 주세요.",
          409,
        );
      if (
        input.confirmResume !== true ||
        !Number.isInteger(input.revision) ||
        input.revision !== task.revision
      )
        throw new DomainError(
          "중단 업무의 최신 상태를 확인하고 재개에 동의해 주세요.",
          409,
        );
    }
    if (task.parentTaskId)
      throw new DomainError(
        "PM이 배정한 업무의 추가 요청은 상위 PM 업무에서 이어가 주세요.",
        409,
      );
    if (
      ![
        "review",
        "completed",
        "handoff",
        "blocked",
        "failed",
        "interrupted",
      ].includes(task.status)
    )
      throw new DomainError(
        "진행 중인 업무는 답변/승인 후 계속됩니다. 결과가 도착한 업무를 선택해 주세요.",
        409,
      );
    if (
      this.store
        .all("tasks", task.projectId)
        .some(
          (t) =>
            t.parentTaskId === id &&
            (["queued", "running", "waiting", "coordinating"].includes(
              t.status,
            ) ||
              t.executionUnconfirmed ||
              (t.status === "interrupted" && t.interruptionConfirmed !== true)),
        )
    )
      throw new DomainError(
        "팀의 업무가 진행 중이거나 종료 확인이 필요합니다.",
        409,
      );
    const project = this.store.get("projects", task.projectId);
    this.checkProjectLock(project.id);
    if (task.mode === "interview" && project.stage !== "idea")
      throw new DomainError(
        "인터뷰 기록은 보존됩니다. 개발 요청은 새 업무로 시작해 주세요.",
        409,
      );
    if (project.archived)
      throw new DomainError("보관한 프로젝트를 먼저 복원해 주세요.");
    const prompt = required(input.prompt, "이어갈 요청", 50000);
    const assignment = this.store.get("assignments", task.assignmentId);
    return this.store.transaction(() => {
      this.store.insert("messages", {
        projectId: task.projectId,
        taskId: id,
        assignmentId: task.assignmentId,
        sender: "user",
        text: prompt,
        channel: task.channel || "direct",
      });
      return this.store.update("tasks", id, {
        status: "queued",
        nextPrompt: prompt,
        interruptionConfirmed: false,
        ...(task.status === "interrupted"
          ? {
              resumedFrom: {
                revision: task.revision,
                generation: task.generation || 1,
                at: new Date().toISOString(),
              },
            }
          : {}),
        error: null,
        acceptedAt: null,
        acceptedBy: null,
        acceptedReview: null,
        finishedAt: null,
        retryAt: null,
        retryCount: 0,
        maxRetries: this.store.settings().retries,
        generation: (task.generation || 1) + 1,
        settings: { ...assignment.settings },
        documents: this.documentSnapshot(task.projectId),
        completion: project.completion,
        checks: structuredClone(project.checks || []),
        automationPolicyId: project.automation?.id || null,
        automation: null,
        verification: null,
      });
    });
  }
  snapshot(projectId) {
    const global = {
      companies: this.store.all("companies"),
      projects: this.store.all("projects"),
      employees: this.store.all("employees"),
      knowledge: this.store.all("knowledge"),
      settings: this.store.settings(),
    };
    if (!projectId) return global;
    this.store.get("projects", projectId);
    return {
      ...global,
      ...Object.fromEntries(
        [
          "assignments",
          "documents",
          "tasks",
          "messages",
          "reports",
          "approvals",
        ].map((table) => [table, this.store.all(table, projectId)]),
      ),
    };
  }
  documentSnapshot(projectId) {
    return this.store
      .all("documents", projectId)
      .map(({ id, revision, title, content, kind, fileSync }) => ({
        id,
        revision,
        title,
        content,
        kind,
        fileSync: fileSync
          ? { name: fileSync.name, hash: fileSync.hash }
          : undefined,
      }));
  }
  checkProjectLock(id) {
    if (this.store.hasUnconfirmedOperation(id))
      throw new DomainError(
        "먼저 프로젝트의 미확인 Git/배포 결과를 확인해 주세요.",
        409,
      );
    if (this.store.projectLocks.has(id))
      throw new DomainError(
        "프로젝트를 변경하는 중입니다. 완료 후 다시 시도해 주세요.",
        409,
      );
  }
}
