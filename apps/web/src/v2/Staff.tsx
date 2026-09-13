import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./Office";
import { AvatarPicker } from "./AvatarPicker";
import { ModelPicker } from "./ModelPicker";
import type { Assignment, Employee, Snapshot } from "./types";

const fields = [
  ["name", "이름"],
  ["role", "역할"],
  ["model", "Codex 모델"],
  ["instructions", "지침"],
  ["skills", "스킬·전문 지식"],
] as const;
type Action = (path: string, data: unknown) => Promise<unknown>;
type Editor = {
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
  values?: Record<string, string>;
  selectedFields?: string[];
};
// 문서·지침은 브라우저 저장소에 쓰지 않는다. 닫기/메뉴 이동 동안만 메모리에 보존한다.
const drafts = new Map<string, Editor>();
export function Staff({
  data,
  action,
  onChat,
  onAdd,
  environment,
  environmentLabel,
  projectId = "",
  editorRequest,
}: {
  data: Snapshot;
  action: Action;
  onChat: (id: string) => void;
  onAdd: () => void;
  environment?: string;
  environmentLabel?: string;
  projectId?: string;
  editorRequest?: { assignmentId: string; sequence: number } | null;
}) {
  const [tab, setTab] = useState<"team" | "library">("team");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const currentEditor = useRef(editor);
  currentEditor.current = editor;
  const sequence = useRef(0);
  const scope = JSON.stringify([environment || "local", projectId]);
  const draftKey = (item: Pick<Editor, "kind" | "id">) =>
    `${scope}:${item.kind}:${item.id}`;
  const preserveDraft = () => {
    const item = currentEditor.current;
    if (!item || !formRef.current) return;
    const form = new FormData(formRef.current);
    const values = {
      ...drafts.get(draftKey(item))?.values,
      ...Object.fromEntries(
        [...form].filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
    if (formRef.current.querySelector('[name="model"][aria-busy="true"]'))
      values.model =
        item.values?.model ??
        item.assignment?.settings.model ??
        item.employee.model;
    drafts.set(draftKey(item), {
      ...item,
      values,
      selectedFields: form.getAll("fields").map(String),
    });
  };
  useLayoutEffect(() => () => preserveDraft(), [scope]);
  const close = () => {
    preserveDraft();
    setEditor(null);
  };
  const open = (kind: Editor["kind"], id: string, fresh = false) => {
    const key = draftKey({ kind, id });
    if (fresh) drafts.delete(key);
    const draft = drafts.get(key);
    if (draft) {
      setError("");
      setEditor({ ...draft, sequence: ++sequence.current });
      return;
    }
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
    setEditor({
      kind,
      id,
      assignment,
      employee,
      source,
      sequence: ++sequence.current,
    });
  };
  const handledRequest = useRef<typeof editorRequest>(null);
  useEffect(() => {
    if (
      !editorRequest ||
      handledRequest.current === editorRequest ||
      !data.assignments?.some((item) => item.id === editorRequest.assignmentId)
    )
      return;
    preserveDraft();
    open("assignment", editorRequest.assignmentId);
    handledRequest.current = editorRequest;
  }, [editorRequest, data.assignments]);
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
                  <Avatar {...a.appearance} />
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
                <Avatar {...e.appearance} />
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
          className="modal-backdrop staff-editor-dialog"
          aria-labelledby="staff-editor-title"
          ref={(el) => {
            if (el && !el.open) el.showModal();
          }}
          onCancel={(e) => {
            if (saving) e.preventDefault();
            else close();
          }}
          onClick={(e) => {
            if (!saving && e.target === e.currentTarget) close();
          }}
        >
          <section className="modal">
            <button
              className="modal-close"
              aria-label="닫기"
              disabled={saving}
              onClick={close}
            >
              ×
            </button>
            <form
              ref={formRef}
              key={editor.kind + editor.id + editor.sequence}
              onSubmit={(e) => {
                e.preventDefault();
                if (saving) return;
                const form = new FormData(e.currentTarget);
                preserveDraft();
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
                  .then(() => {
                    drafts.delete(draftKey(editor));
                    setEditor(null);
                  })
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
              {editor.values && (
                <p className="form-note">
                  닫기 전 작성하던 내용을 복원했습니다. 새로고침하면 임시 입력은
                  사라집니다.
                </p>
              )}
              {(targetChanged || sourceChanged) && (
                <p role="alert" className="form-error">
                  창을 연 뒤 설정이 변경되었습니다. 입력과 비교 내용은 그대로
                  보존했습니다.
                  {updating
                    ? " 최신 설정을 다시 비교하고 반영할 항목을 선택해 주세요."
                    : " 저장하면 충돌로 거절됩니다. 필요한 내용을 복사한 뒤 ‘임시 입력 버리고 최신 설정 열기’를 선택해 주세요."}
                </p>
              )}
              {!updating && (
                <AvatarPicker
                  {...(assignment?.appearance || employee?.appearance)}
                  avatar={
                    editor.values?.avatar ||
                    assignment?.appearance?.avatar ||
                    employee?.appearance?.avatar
                  }
                  disabled={saving}
                />
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
                    onClick={() => open(editor.kind, editor.id, true)}
                  >
                    최신 설정 다시 비교
                  </button>
                  {different.map(([key, label]) => (
                    <label key={key}>
                      <span>
                        <input
                          type="checkbox"
                          name="fields"
                          value={key}
                          defaultChecked={editor.selectedFields?.includes(key)}
                        />
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
                fields.map(([key, label]) =>
                  key === "model" ? (
                    <ModelPicker
                      key={key}
                      defaultValue={editor.values?.model ?? target.model}
                      environment={environment}
                      environmentLabel={environmentLabel}
                      disabled={saving}
                    />
                  ) : (
                    <label key={key}>
                      {label}
                      {key === "instructions" || key === "skills" ? (
                        <textarea
                          name={key}
                          required={key === "instructions"}
                          defaultValue={editor.values?.[key] ?? target[key]}
                        />
                      ) : (
                        <input
                          name={key}
                          required
                          defaultValue={
                            editor.values?.[key] ??
                            (key === "name" && editor.kind === "derive"
                              ? target.name + " (파생)"
                              : target[key])
                          }
                        />
                      )}
                    </label>
                  ),
                )
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
              <div className="staff-editor-footer">
                {(editor.values || targetChanged || sourceChanged) && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => open(editor.kind, editor.id, true)}
                  >
                    임시 입력 버리고 최신 설정 열기
                  </button>
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
              </div>
            </form>
          </section>
        </dialog>
      )}
    </>
  );
}
