import { useState } from "react";
import type { Task } from "./types";

export function TaskTitle({
  task,
  action,
}: {
  task: Task;
  action: (path: string, input: unknown) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<{
    title: string;
    revision?: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="task-title-editor">
      {draft ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (saving) return;
            setSaving(true);
            setError("");
            void action(`tasks/${task.id}/edit`, draft)
              .then(() => setDraft(null))
              .catch((error) => setError(error.message))
              .finally(() => setSaving(false));
          }}
        >
          <label>
            업무 제목
            <input
              autoFocus
              required
              maxLength={80}
              value={draft.title}
              disabled={saving}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <small>
            목록에서 구분할 짧은 제목입니다. 원래 요청과 대화는 바뀌지 않습니다.
          </small>
          {error && (
            <p role="alert">
              {error} 입력한 제목은 보존했습니다. 취소 후 최신 상태에서 다시
              변경해 주세요.
            </p>
          )}
          <div className="button-row">
            <button type="submit" disabled={saving}>
              {saving ? "저장 중…" : "제목 저장"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              취소
            </button>
          </div>
        </form>
      ) : (
        <>
          <strong>{task.title}</strong>
          <button
            type="button"
            disabled={!task.revision}
            onClick={() => {
              setDraft({ title: task.title, revision: task.revision });
              setError("");
            }}
          >
            제목 변경
          </button>
        </>
      )}
    </div>
  );
}
