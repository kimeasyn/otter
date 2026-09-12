import { randomUUID } from "node:crypto";
import { DomainError, required, choice } from "./store.mjs";

export function knowledgeFields(input) {
  const fields = {
    title: required(input.title, "공유 지식 제목", 120),
    content: required(input.content, "공유할 본문", 30000),
    reason: required(input.reason, "재사용할 이유", 3000),
  };
  // Known credential formats only; human review remains necessary for secrets/customer data.
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i.test(
      Object.values(fields).join("\n"),
    )
  )
    throw new DomainError(
      "자격 증명으로 보이는 내용은 공유할 수 없습니다. 제거한 뒤 다시 작성해 주세요.",
    );
  return fields;
}
const immutable = [
  "companyId",
  "title",
  "content",
  "reason",
  "sourceProjectId",
  "sourceApprovalId",
  "originWorkerId",
  "approvedAt",
];
export class Knowledge {
  constructor(store) {
    this.store = store;
  }
  project(id) {
    const project = this.store.get("projects", id);
    if (project.archived || this.store.projectLocks.has(id))
      throw new DomainError(
        "보관 중이거나 저장 위치를 변경 중인 프로젝트입니다.",
        409,
      );
    return project;
  }
  publish(projectId, input, sourceApprovalId = null) {
    const project = this.project(projectId);
    if (input.confirm !== true)
      throw new DomainError(
        "공유 범위와 본문에 기밀이 없는지 확인하고 승인해 주세요.",
      );
    const fields = knowledgeFields(input);
    const workerId = this.store.metadata("workerId") || randomUUID();
    this.store.metadata("workerId", workerId);
    return this.store.insert("knowledge", {
      ...fields,
      companyId: project.companyId,
      sourceProjectId: projectId,
      sourceApprovalId,
      originWorkerId: workerId,
      approvedAt: new Date().toISOString(),
      status: "published",
    });
  }
  // Only user-approved, immutable excerpts cross environments, never whole project records.
  importApproved(input) {
    for (const key of ["id", "companyId", "sourceProjectId", "originWorkerId"])
      if (typeof input[key] !== "string" || !/^[a-f0-9-]{36}$/.test(input[key]))
        throw new DomainError("공유 지식 식별자가 올바르지 않습니다.");
    if (
      input.sourceApprovalId !== null &&
      !/^[a-f0-9-]{36}$/.test(input.sourceApprovalId || "")
    )
      throw new DomainError("공유 승인 식별자가 올바르지 않습니다.");
    if (
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !Number.isFinite(Date.parse(input.approvedAt)) ||
      !Number.isFinite(Date.parse(input.createdAt))
    )
      throw new DomainError("공유 지식의 승인 기록/버전이 올바르지 않습니다.");
    this.store.get("companies", input.companyId);
    const item = {
      ...knowledgeFields(input),
      id: input.id,
      companyId: input.companyId,
      sourceProjectId: input.sourceProjectId,
      sourceApprovalId: input.sourceApprovalId,
      originWorkerId: input.originWorkerId,
      approvedAt: input.approvedAt,
      createdAt: input.createdAt,
      revision: input.revision,
      status: choice(input.status, ["published", "withdrawn"], "공유 상태"),
    };
    const row = this.store.db
      .prepare("SELECT data FROM knowledge WHERE id=?")
      .get(item.id);
    const existing = row ? JSON.parse(row.data) : null;
    if (existing) {
      if (immutable.some((key) => item[key] !== existing[key]))
        throw new DomainError(
          "이미 승인한 공유 지식의 본문/출처를 덮어쓸 수 없습니다.",
          409,
        );
      if (existing.status === "withdrawn" || existing.revision >= item.revision)
        return existing;
      if (item.status !== "withdrawn") return existing;
    }
    this.store.db
      .prepare(
        "INSERT INTO knowledge(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(item.id, JSON.stringify(item));
    this.store.event(null, "knowledge.imported", { id: item.id });
    return item;
  }
  withdraw(id, input) {
    const item = this.store.get("knowledge", id);
    if (input.confirm !== true || input.revision !== item.revision)
      throw new DomainError(
        "현재 공유 지식을 확인하고 사용 중지를 승인해 주세요.",
        409,
      );
    if (item.status === "withdrawn") return item;
    return this.store.update(
      "knowledge",
      id,
      { status: "withdrawn" },
      input.revision,
    );
  }
  select(companyId, input) {
    const item = this.store.get(
      "knowledge",
      required(input.knowledgeId, "공유 지식"),
    );
    if (item.companyId !== companyId)
      throw new DomainError(
        "같은 회사에서 승인한 지식만 가져올 수 있습니다.",
        403,
      );
    if (
      item.status !== "published" ||
      item.revision !== input.revision ||
      input.confirm !== true
    )
      throw new DomainError(
        "공유 상태와 현재 본문을 확인한 뒤 가져와 주세요.",
        409,
      );
    return item;
  }
  apply(projectId, input) {
    const project = this.project(projectId);
    const item = this.select(project.companyId, input);
    const existing = this.store
      .all("documents", projectId)
      .find((d) => d.knowledgeSource?.id === item.id);
    // A selected copy becomes a project document, never a live global instruction.
    if (existing) return existing;
    return this.store.insert("documents", {
      projectId,
      title: item.title,
      content: item.content,
      kind: "knowledge",
      scope: "project",
      knowledgeSource: { id: item.id, revision: item.revision },
    });
  }
}
