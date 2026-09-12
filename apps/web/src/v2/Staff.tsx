import { useState } from "react";
import { Avatar } from "./Office";
import type { Assignment, Employee, Snapshot } from "./types";

const fields = [
  ["name", "이름"],
  ["role", "역할"],
  ["model", "Codex 모델"],
  ["instructions", "지침"],
  ["skills", "스킬·전문 지식"],
] as const;
type Action = (path: string, data: unknown) => Promise<unknown>;
export function Staff({
  data,
  action,
  onChat,
  onAdd,
}: {
  data: Snapshot;
  action: Action;
  onChat: (id: string) => void;
  onAdd: () => void;
}) {
  const [tab, setTab] = useState<"team" | "library">("team");
  const [editor, setEditor] = useState<{
    kind:
      | "assignment"
      | "employee"
      | "derive"
      | "assignment-update"
      | "employee-update";
    id: string;
    assignment?: Assignment;
    employee: Employee;
    source?: Employee;
    sequence: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const open = (kind: NonNullable<typeof editor>["kind"], id: string) => {
    const assignment = kind.startsWith("assignment")
      ? data.assignments?.find((a) => a.id === id)
      : undefined;
    const employee = data.employees.find(
      (e) => e.id === (assignment?.employeeId || id),
    );
    if (!employee) return;
    const source = assignment
      ? employee
      : data.employees.find((e) => e.id === employee.sourceId);
    setError("");
    // 입력과 비교 내용의 기준 버전은 창을 열 때 고정한다. 조회 갱신으로 저장 기준을 올리지 않는다.
    setEditor((current) => ({
      kind,
      id,
      assignment,
      employee,
      source,
      sequence: (current?.sequence || 0) + 1,
    }));
  };
  const { assignment, employee, source } = editor || {};
  const target = assignment?.settings || employee;
  const updating = editor?.kind.endsWith("update");
  const targetChanged =
    editor &&
    (assignment
      ? data.assignments?.find((a) => a.id === assignment.id)?.revision !==
        assignment.revision
      : data.employees.find((e) => e.id === employee?.id)?.revision !==
        employee?.revision);
  const sourceChanged =
    updating &&
    source &&
    data.employees.find((e) => e.id === source.id)?.revision !==
      source.revision;
  const different =
    target && source
      ? fields.filter(([key]) => target[key] !== source[key])
      : [];
  return (
    <>
      <div className="staff-tabs">
        <button
          className={tab === "team" ? "active" : ""}
          onClick={() => setTab("team")}
        >
          프로젝트 팀
        </button>
        <button
          className={tab === "library" ? "active" : ""}
          onClick={() => setTab("library")}
        >
          직원 라이브러리
        </button>
      </div>
      <div className="staff-list">
        {tab === "team"
          ? (data.assignments || []).map((a) => {
              const template = data.employees.find(
                (e) => e.id === a.employeeId,
              );
              const changes = template
                ? fields.filter(([key]) => template[key] !== a.settings[key])
                    .length
                : 0;
              return (
                <article key={a.id} className="staff-card">
                  <Avatar color={a.appearance.color} />
                  <div>
                    <h2>{a.settings.name}</h2>
                    <p>
                      {a.settings.role} ·{" "}
                      {a.settings.model || "Codex 기본 모델"}
                    </p>
                    <p className="instruction-preview">
                      {a.settings.instructions}
                    </p>
                    <div className="staff-actions">
                      <button onClick={() => onChat(a.id)}>대화 →</button>
                      <button onClick={() => open("assignment", a.id)}>
                        프로젝트 설정
                      </button>
                      {!!changes && (
                        <button onClick={() => open("assignment-update", a.id)}>
                          원본과 비교 · {changes}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          : data.employees.map((e) => (
              <article key={e.id} className="staff-card">
                <Avatar color={e.appearance.color} />
                <div>
                  <h2>{e.name}</h2>
                  <p>
                    {e.role} · 버전 {e.revision}
                  </p>
                  {e.sourceId && (
                    <p>
                      기반 직원:{" "}
                      {data.employees.find((s) => s.id === e.sourceId)?.name}
                    </p>
                  )}
                  <p className="instruction-preview">{e.instructions}</p>
                  <div className="staff-actions">
                    <button onClick={() => open("employee", e.id)}>
                      원본 편집
                    </button>
                    <button onClick={() => open("derive", e.id)}>
                      파생 직원 만들기
                    </button>
                    {e.sourceId && (
                      <button onClick={() => open("employee-update", e.id)}>
                        기반 직원과 비교
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
      </div>
      {tab === "team" && !data.assignments?.length && (
        <div className="empty-panel">
          <p>역할과 일하는 방식을 정해 첫 직원을 배정하세요.</p>
          <button onClick={onAdd}>직원 배정</button>
        </div>
      )}
      {editor && target && (
        <dialog
          className="modal-backdrop"
          aria-labelledby="staff-editor-title"
          ref={(el) => {
            if (el && !el.open) el.showModal();
          }}
          onCancel={(e) => {
            if (saving) e.preventDefault();
            else setEditor(null);
          }}
          onClick={(e) => {
            if (!saving && e.target === e.currentTarget) setEditor(null);
          }}
        >
          <section className="modal">
            <button
              className="modal-close"
              aria-label="닫기"
              disabled={saving}
              onClick={() => setEditor(null)}
            >
              ×
            </button>
            <form
              key={editor.kind + editor.id + editor.sequence}
              onSubmit={(e) => {
                e.preventDefault();
                if (saving) return;
                const form = new FormData(e.currentTarget);
                setSaving(true);
                setError("");
                let path;
                let input;
                if (updating) {
                  path = `${assignment ? "assignments" : "employees"}/${editor.id}/refresh`;
                  input = {
                    fields: form.getAll("fields"),
                    revision: assignment?.revision || employee?.revision,
                    sourceRevision: source?.revision,
                  };
                } else if (editor.kind === "derive") {
                  path = "employees";
                  input = {
                    ...Object.fromEntries(form),
                    sourceId: employee?.id,
                    sourceRevision: employee?.revision,
                  };
                } else {
                  path = `${assignment ? "assignments" : "employees"}/${editor.id}/edit`;
                  input = {
                    ...Object.fromEntries(form),
                    revision: assignment?.revision || employee?.revision,
                  };
                }
                void action(path, input)
                  .then(() => setEditor(null))
                  .catch((e) => setError(e.message))
                  .finally(() => setSaving(false));
              }}
            >
              <span className="eyebrow">HOW YOUR TEAM WORKS</span>
              <h2 id="staff-editor-title">
                {updating
                  ? "변경 내용 선택"
                  : editor.kind === "derive"
                    ? "이 직원을 바탕으로 만들기"
                    : assignment
                      ? "이 프로젝트에서 일하는 방식"
                      : "재사용할 직원 설정"}
              </h2>
              <p>
                {updating
                  ? "선택한 항목만 가져옵니다. 이 프로젝트에서 조정한 내용도 선택하면 대체됩니다."
                  : editor.kind === "derive"
                    ? "역할과 지침을 가져와 조정합니다. 다른 프로젝트의 대화나 자료는 가져오지 않습니다."
                    : assignment
                      ? "이 프로젝트의 배정만 바꿉니다. 원본과 다른 프로젝트에는 영향을 주지 않습니다."
                      : "원본을 편집해도 이미 배정된 직원은 자동으로 바뀌지 않습니다."}
              </p>
              {(targetChanged || sourceChanged) && (
                <p role="alert" className="form-error">
                  창을 연 뒤 설정이 변경되었습니다. 입력과 비교 내용은 그대로
                  보존했습니다.
                  {updating
                    ? " 최신 설정을 다시 비교하고 반영할 항목을 선택해 주세요."
                    : " 저장하면 충돌로 거절됩니다. 작성한 내용을 복사한 뒤 닫고 다시 열어 최신 설정을 확인해 주세요."}
                </p>
              )}
              {updating ? (
                <div className="setting-comparison">
                  <p>
                    현재 버전 {assignment?.revision || employee?.revision} ·
                    가져올 원본 버전 {source?.revision ?? "미확인"}
                  </p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => open(editor.kind, editor.id)}
                  >
                    최신 설정 다시 비교
                  </button>
                  {different.map(([key, label]) => (
                    <label key={key}>
                      <span>
                        <input type="checkbox" name="fields" value={key} />
                        {label} 반영
                      </span>
                      <div>
                        <small>현재 설정</small>
                        <pre>{target[key] || "(비어 있음)"}</pre>
                        <small>가져올 설정</small>
                        <pre>{source?.[key] || "(비어 있음)"}</pre>
                      </div>
                    </label>
                  ))}
                  {!different.length && <p>다른 설정이 없습니다.</p>}
                </div>
              ) : (
                fields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    {key === "instructions" || key === "skills" ? (
                      <textarea
                        name={key}
                        required={key === "instructions"}
                        defaultValue={target[key]}
                      />
                    ) : (
                      <input
                        name={key}
                        required={key !== "model"}
                        defaultValue={
                          key === "name" && editor.kind === "derive"
                            ? target.name + " (파생)"
                            : target[key]
                        }
                        placeholder={
                          key === "model" ? "비워두면 Codex 기본 모델" : ""
                        }
                      />
                    )}
                  </label>
                ))
              )}
              <p className="form-note">
                진행 중인 실행에는 시작 시점의 지침을 유지합니다. 변경은 다음
                실행부터 반영됩니다.
              </p>
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              <button
                className="primary wide"
                disabled={
                  saving ||
                  (updating &&
                    (!different.length || !!targetChanged || !!sourceChanged))
                }
              >
                {saving
                  ? "저장 중…"
                  : updating
                    ? "선택한 변경 반영"
                    : editor.kind === "derive"
                      ? "파생 직원 만들기"
                      : "설정 저장"}
              </button>
            </form>
          </section>
        </dialog>
      )}
    </>
  );
}
