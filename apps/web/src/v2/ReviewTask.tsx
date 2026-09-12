import { useState } from "react";
import { Verification } from "./Completion";
import type { Task } from "./types";

export function ReviewTask({
  task,
  action,
}: {
  task: Task;
  action: (path: string, input: unknown) => Promise<unknown>;
}) {
  const [review, setReview] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changed =
    review && (review.revision !== task.revision || task.status !== "review");
  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={!task.revision || task.status !== "review"}
        onClick={() => {
          setReview(structuredClone(task));
          setError("");
        }}
      >
        검토 완료
      </button>
      {review && (
        <dialog
          className="modal-backdrop"
          aria-label="업무 결과 검토"
          ref={(element) => {
            if (element && !element.open) element.showModal();
          }}
          onCancel={(event) => {
            if (saving) event.preventDefault();
            else setReview(null);
          }}
        >
          <form
            className="modal review-task"
            onSubmit={(event) => {
              event.preventDefault();
              if (changed || saving) return;
              setSaving(true);
              setError("");
              void action(`tasks/${review.id}/accept`, {
                revision: review.revision,
                confirm: true,
              })
                .then(() => setReview(null))
                .catch((error) => setError(error.message))
                .finally(() => setSaving(false));
            }}
          >
            <h2>업무 결과 검토</h2>
            <h3>{review.title}</h3>
            <p>
              실행 {review.generation || 1}회차 · 변경 번호 {review.revision}
            </p>
            <p>
              결과 커밋:{" "}
              <code>
                {review.resultCommit || "없음 · 문서/대화 결과를 확인하세요"}
              </code>
            </p>
            <Verification result={review.verification} />
            {!review.verification && (
              <p>
                별도 검증 기록이 없습니다. 직원의 보고만으로 검사 통과를
                보장하지 않습니다.
              </p>
            )}
            <p>
              완료는 검사 통과를 뜻하지 않습니다. 이 업무에 적용되는 자동 반영
              설정이 있다면 완료 후 병합·푸시·배포가 이어질 수 있습니다.
            </p>
            {changed && (
              <p role="alert">
                검토 대상이 변경되었습니다. 창을 닫고 최신 보고와 검증 결과를
                다시 확인해 주세요.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="button-row">
              <button
                type="button"
                disabled={saving}
                onClick={() => setReview(null)}
              >
                돌아가기
              </button>
              <button
                type="submit"
                className="primary"
                disabled={saving || !!changed}
              >
                {saving ? "완료 확인 중…" : "확인한 결과를 완료 처리"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
