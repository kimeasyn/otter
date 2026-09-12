import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DomainError, required } from "./store.mjs";
import { createRepository } from "./git.mjs";

export class Ideas {
  constructor(company, runner, directory) {
    this.company = company;
    this.store = company.store;
    this.runner = runner;
    this.directory = directory;
  }
  async create(input) {
    const idea = required(input.idea, "아이디어", 50000);
    const name = required(input.name, "프로젝트 이름", 120);
    if (input.confirmPM !== true)
      throw new DomainError(
        "PM의 역할·모델·필요 이유를 확인하고 배정에 동의해 주세요.",
      );
    if (input.employeeId) this.store.get("employees", input.employeeId);
    else {
      required(input.pm?.name, "PM 이름", 80);
      required(input.pm?.instructions, "PM 지침", 50000);
    }
    this.store.get("companies", required(input.companyId, "회사"));
    const parent = join(this.directory, "ideas");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await realpath(await mkdtemp(join(parent, "interview-")));
    return this.company.addProject(
      { ...input, idea, name },
      {
        repo: { root, name, branch: "" },
        stage: "idea",
        employeeId: input.employeeId,
        pm: { ...input.pm, role: "PM · 요구사항 정리와 팀 조율" },
      },
    );
  }
  async activate(id, input) {
    const project = this.store.get("projects", id);
    this.company.checkProjectLock(id);
    if (
      project.archived ||
      project.stage !== "idea" ||
      project.revision !== input.revision
    )
      throw new DomainError(
        "최신 아이디어 프로젝트에서 저장 위치를 확정해 주세요.",
        409,
      );
    if (input.confirm !== true)
      throw new DomainError("문서와 팀 구성을 확인해 주세요.");
    if (
      this.store
        .all("tasks", id)
        .some(
          (task) =>
            this.runner.active.has(task.id) ||
            ["queued", "running", "waiting", "coordinating"].includes(
              task.status,
            ),
        )
    )
      throw new DomainError(
        "진행 중인 인터뷰를 마치거나 중단한 뒤 확정해 주세요.",
        409,
      );
    if (this.store.all("approvals", id).some((a) => a.status === "pending"))
      throw new DomainError(
        "남아 있는 문서·직원 제안을 먼저 검토해 주세요.",
        409,
      );
    const documents = this.store.all("documents", id);
    if (
      ["목표", "요구사항", "프로젝트 지침", "개발 계획"].some(
        (title) =>
          !documents.some(
            (d) =>
              d.kind !== "knowledge" && d.title === title && d.content.trim(),
          ),
      )
    )
      throw new DomainError(
        "목표·요구사항·프로젝트 지침·개발 계획을 먼저 작성해 주세요.",
      );
    const versions = Object.fromEntries(
      documents.map((d) => [d.id, d.revision]),
    );
    if (
      !input.documents ||
      Object.keys(input.documents).length !== documents.length ||
      Object.entries(versions).some(
        ([key, value]) => input.documents[key] !== value,
      )
    )
      throw new DomainError(
        "문서가 바뀌었습니다. 최신 내용을 확인해 주세요.",
        409,
      );
    const team = this.store.all("assignments", id);
    if (
      !input.team ||
      Object.keys(input.team).length !== team.length ||
      team.some((a) => input.team[a.id] !== a.revision)
    )
      throw new DomainError(
        "팀 구성이 바뀌었습니다. 최신 역할과 설정을 확인해 주세요.",
        409,
      );
    this.store.projectLocks.add(id);
    try {
      const repo = await createRepository(input.parent, input.folder);
      return this.store.transaction(() =>
        this.store.activateProject(id, repo, input.revision),
      );
    } finally {
      this.store.projectLocks.delete(id);
    }
  }
}
