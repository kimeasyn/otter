import { useState } from "react";
import type { Project, Snapshot } from "./types";

export function Knowledge({
  project,
  data,
  action,
}: {
  project: Project;
  data: Snapshot;
  action: (
    path: string,
    input: unknown,
    environment?: string,
  ) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const items = (data.knowledge || []).filter(
    (k) => k.companyId === project.companyId,
  );
  const perform = async (
    path: string,
    input: unknown,
    environment?: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      await action(path, input, environment);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="knowledge-panel">
      <summary>
        회사 공유 지식 ·{" "}
        {items.filter((item) => item.status === "published").length}개
      </summary>
      <p>
        승인한 노하우만 모아 둡니다. 이 프로젝트에 선택해서 가져오면 문서 사본이
        되고, 새 업무·대화 재개부터 적용됩니다.
      </p>
      <details className="knowledge-publish">
        <summary>공유할 노하우 직접 작성</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const input = Object.fromEntries(new FormData(form));
            void perform(`projects/${project.id}/knowledge-publish`, {
              ...input,
              confirm: input.confirm === "on",
            }).then((saved) => {
              if (saved) form.reset();
            });
          }}
        >
          <label>
            공유 지식 제목
            <input name="title" required maxLength={120} disabled={busy} />
          </label>
          <label>
            공유할 본문
            <textarea
              name="content"
              disabled={busy}
              required
              maxLength={30000}
              placeholder="다른 프로젝트에서도 쓸 수 있는 원칙만 작성하세요. 대화·코드·자격 증명은 붙이지 마세요."
            />
          </label>
          <label>
            재사용할 이유
            <input name="reason" required maxLength={3000} disabled={busy} />
          </label>
          <label className="check-row">
            <input name="confirm" type="checkbox" required disabled={busy} />
            본문에 기밀이 없음을 확인했고 같은 회사의 다른 프로젝트·실행
            환경에서 재사용하도록 승인합니다.
          </label>
          <button className="primary" disabled={busy}>
            확인한 본문 공유
          </button>
        </form>
      </details>
      <label className="check-row">
        <input
          type="checkbox"
          checked={showWithdrawn}
          onChange={(e) => setShowWithdrawn(e.target.checked)}
        />
        공유 중지한 지식도 보기
      </label>
      <div className="knowledge-list">
        {items
          .filter((k) => showWithdrawn || k.status === "published")
          .map((item) => {
            const copy = data.documents?.find(
              (d) => d.knowledgeSource?.id === item.id,
            );
            return (
              <article key={item.id} className="knowledge-card">
                <h3>{item.title}</h3>
                <small>
                  {item.status === "withdrawn"
                    ? "새 적용 중지"
                    : "사용자 승인됨"}{" "}
                  · {new Date(item.approvedAt).toLocaleDateString("ko-KR")}
                </small>
                <p>{item.reason}</p>
                <details>
                  <summary>공유 본문 확인</summary>
                  <pre>{item.content}</pre>
                </details>
                {copy && (
                  <p>
                    이 프로젝트 문서에 사본이 있습니다. 여기에서 수정한 사본은
                    원본 변경이나 재적용으로 덮어쓰지 않습니다.
                  </p>
                )}
                {item.status === "withdrawn" && (
                  <p>
                    이미 가져간 문서·진행 중인 업무의 내용은 자동 삭제하지
                    않습니다. 각 프로젝트에서 확인하고 수정해 주세요.
                  </p>
                )}
                <div className="button-row">
                  <button
                    disabled={busy || !!copy || item.status === "withdrawn"}
                    onClick={() => {
                      if (
                        window.confirm(
                          `“${item.title}”의 승인된 본문을 이 프로젝트 문서로 가져올까요? 새 업무·대화 재개부터 적용됩니다.`,
                        )
                      )
                        void perform(`projects/${project.id}/knowledge-apply`, {
                          knowledgeId: item.id,
                          revision: item.revision,
                          confirm: true,
                        });
                    }}
                  >
                    {copy ? "이 프로젝트에 가져옴" : "이 프로젝트에 가져오기"}
                  </button>
                  {item.status === "published" && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "이 지식의 새로운 적용을 중지할까요? 이미 가져간 문서와 업무 기록은 남습니다.",
                          )
                        )
                          void perform(
                            `knowledge/${item.id}/withdraw`,
                            { revision: item.revision, confirm: true },
                            "local",
                          );
                      }}
                    >
                      공유 중지
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        {!items.some((k) => showWithdrawn || k.status === "published") && (
          <p>
            아직 공유한 지식이 없습니다. 직원에게 노하우를 공유 지식으로 제안해
            달라고 요청할 수도 있습니다.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </details>
  );
}
