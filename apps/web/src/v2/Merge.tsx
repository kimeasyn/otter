import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Project, type Task } from "./types";
import { GitRecovery } from "./GitRecovery";

type Preview = {
  branch: string;
  path: string;
  sourceBranch: string;
  base: string;
  resultCommit: string;
  approval: string;
  summary: string;
  alreadyMerged: boolean;
};
export function MergeResult({
  project,
  task,
}: {
  project: Project;
  task: Task;
}) {
  const [open, setOpen] = useState(false);
  const canMerge =
    !task.parentTaskId &&
    task.mode !== "interview" &&
    !!task.resultCommit &&
    ["review", "completed"].includes(task.status);
  const needsRecovery =
    task.merge && ["applying", "unconfirmed"].includes(task.merge.status);
  if (!canMerge && !needsRecovery) return null;
  return (
    <>
      {task.merge && (
        <details>
          <summary>
            {task.merge.status === "merged"
              ? "원본 반영 기록"
              : task.merge.status === "not-applied"
                ? "원본 미반영 확인"
                : "원본 반영 확인 필요"}
          </summary>
          <p>
            {task.merge.branch} ·{" "}
            {task.merge.status === "merged"
              ? "반영 완료 · 푸시/배포 아님"
              : task.merge.status === "not-applied"
                ? "미반영 확인 · 원인을 해결한 뒤 새로 승인하세요."
                : "자동 재실행하지 않습니다. 외부 IDE에서 원본 HEAD와 아래 커밋을 확인하세요."}
          </p>
          <code>{task.merge.commit}</code>
        </details>
      )}
      {needsRecovery && (
        <GitRecovery
          path={`tasks/${task.id}/merge-recovery`}
          environment={project.environmentId}
        />
      )}
      {canMerge && (
        <button disabled={!!needsRecovery} onClick={() => setOpen(true)}>
          원본에 반영…
        </button>
      )}
      {open && (
        <MergeDialog
          key={task.id}
          project={project}
          task={task}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function MergeDialog({
  project,
  task,
  close,
}: {
  project: Project;
  task: Task;
  close: () => void;
}) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [version, setVersion] = useState(0);
  const path = `tasks/${task.id}/merge`;
  const environment = project.environmentId || "local";
  useEffect(() => {
    let current = true;
    void api<Preview>(path, undefined, environment)
      .then((value) => {
        if (current) setPreview(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [path, environment, version]);
  return (
    <dialog
      className="modal-backdrop"
      aria-labelledby="merge-title"
      ref={(element) => {
        if (element && !element.open) element.showModal();
      }}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else close();
      }}
    >
      <section className="modal editor-dialog">
        <button
          className="modal-close"
          aria-label="닫기"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
        <h2 id="merge-title">직원 결과를 원본에 반영</h2>
        <p>
          {project.environmentLabel || "로컬"} · {project.name} · {task.title}
        </p>
        <p>
          검토 완료와 별개로 원본 파일과 브랜치를 변경합니다. 푸시·배포는 하지
          않습니다.
        </p>
        <p>
          반영 중에는 외부 IDE나 터미널에서 이 저장소를 수정하지 마세요. 원본의
          다른 변경과 합쳐진 결과는 추가 검증이 필요할 수 있습니다.
        </p>
        {preview && !result && (
          <>
            <p>
              반영 대상: <strong>{preview.branch}</strong>
            </p>
            <label>
              원본 폴더
              <input readOnly value={preview.path} />
            </label>
            <p>직원 브랜치: {preview.sourceBranch}</p>
            <pre>{preview.summary || "원본 파일 내용 변경 없음"}</pre>
            <details>
              <summary>확인한 커밋</summary>
              <p>원본: {preview.base}</p>
              <p>결과: {preview.resultCommit}</p>
            </details>
            {preview.alreadyMerged ? (
              <p role="status">
                이 결과는 이미 원본 이력에 포함되어 있습니다. 다시 반영하지
                않습니다.
              </p>
            ) : (
              <>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void api<{ branch: string; commit: string }>(
                      path,
                      { confirm: true, approval: preview.approval },
                      environment,
                    )
                      .then((value) =>
                        setResult(
                          `${value.branch}에 반영했습니다. 푸시·배포는 하지 않았습니다.`,
                        ),
                      )
                      .catch((e) => {
                        setError(e.message);
                        setPreview(null);
                      })
                      .finally(() => {
                        setBusy(false);
                        void client.invalidateQueries({ queryKey: ["v2"] });
                      });
                  }}
                >
                  {busy ? "반영 중…" : "승인하고 원본에 반영"}
                </button>
              </>
            )}
          </>
        )}
        {!preview && !error && (
          <p role="status">변경과 충돌 여부를 확인하는 중…</p>
        )}
        {result && <p role="status">{result}</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!busy && !result && (
          <button
            onClick={() => {
              setPreview(null);
              setError("");
              setVersion((v) => v + 1);
            }}
          >
            최신 상태 다시 확인
          </button>
        )}
      </section>
    </dialog>
  );
}
