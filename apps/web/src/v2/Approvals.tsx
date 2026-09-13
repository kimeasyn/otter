import { useState } from "react";
import type { Approval, Task } from "./types";

export function Approvals({
  items,
  action,
  tasks = [],
}: {
  items: Approval[];
  action: (path: string, data: unknown) => Promise<unknown>;
  tasks?: Task[];
}) {
  const [pending, setPending] = useState(false);
  const respond = (id: string, input: unknown) => {
    if (pending) return;
    setPending(true);
    void action(`approvals/${id}/resolve`, input)
      .catch(() => {})
      .finally(() => setPending(false));
  };
  return (
    <>
      {items.map((a) => (
        <form
          className="approval-card"
          key={a.id}
          onSubmit={(e) => {
            e.preventDefault();
            if (!a.params.questions) return;
            respond(a.id, {
              answers: Object.fromEntries(new FormData(e.currentTarget)),
            });
          }}
        >
          <strong>
            {a.method === "otter/hire"
              ? "새 동료 채용 제안"
              : a.method === "otter/document"
                ? "문서 변경 제안"
                : a.method === "otter/knowledge"
                  ? "회사 공유 지식 제안"
                  : a.review?.title || "확인이 필요해요"}
          </strong>
          {tasks.some((task) => task.id === a.taskId) && (
            <p className="approval-task">
              대상 업무: {tasks.find((task) => task.id === a.taskId)?.title}
            </p>
          )}
          <small>직원이 설명한 요청 목적</small>
          <p>
            {a.params.reason?.trim() ||
              "목적 설명이 제공되지 않았습니다. 아래 실행 내용과 허용 범위를 확인해 주세요."}
          </p>
          {a.method === "otter/knowledge" && (
            <>
              <h3>{a.params.title}</h3>
              <pre>{a.params.content}</pre>
              <p>
                공유 범위: {a.params.companyName} 회사의 프로젝트. 승인한 본문만
                라이브러리에 등록합니다. 다른 프로젝트·실행 환경에서 사용자가
                선택해 가져갈 수 있습니다.
              </p>
              <small>
                비밀번호·토큰·고객 정보·비공개 소스가 없는지 확인하세요. 원래
                대화와 파일을 자동 첨부하지 않으며 다른 프로젝트에 자동 적용하지
                않습니다.
              </small>
            </>
          )}
          {a.method === "otter/hire" && (
            <>
              <h3>
                {a.params.name} · {a.params.role}
              </h3>
              <p>모델: {a.params.model || "Codex 기본 모델"}</p>
              <details>
                <summary>지침·스킬 확인</summary>
                <pre>{a.params.instructions}</pre>
                <pre>{a.params.skills}</pre>
              </details>
              <small>승인하면 이 프로젝트에 새 직원을 배정합니다.</small>
            </>
          )}
          {a.method === "otter/document" && (
            <>
              <h3>{a.params.title}</h3>
              <details>
                <summary>현재 내용</summary>
                <pre>{a.params.before || "(비어 있음)"}</pre>
              </details>
              <details open>
                <summary>변경 제안</summary>
                <pre>{a.params.content || "(비어 있음)"}</pre>
              </details>
              <small>
                현재 문서가 달라졌다면 덮어쓰지 않고 승인을 중단합니다.
              </small>
            </>
          )}
          {a.params.command && (
            <>
              <small>실행 명령 · 아래 내용이 승인 대상입니다</small>
              <pre>{a.params.command}</pre>
            </>
          )}
          {a.params.grantRoot && (
            <p>추가 파일 접근 범위: {a.params.grantRoot}</p>
          )}
          {!!a.params.changes?.length && (
            <section className="approval-files" aria-label="변경할 파일">
              <p>
                파일 변경 {a.params.changes.length}개 · 파일을 펼쳐 변경 내용을
                확인하세요.
              </p>
              {a.params.changes.map((change) => (
                <details key={change.path}>
                  <summary>{change.path}</summary>
                  <pre tabIndex={0} aria-label={`${change.path} 변경 내용`}>
                    {change.diff}
                  </pre>
                </details>
              ))}
            </section>
          )}
          {a.params.cwd && <small>{a.params.cwd}</small>}
          {a.review && (
            <section aria-label="승인할 접근 범위">
              {a.review.details.length > 0 && (
                <ul>
                  {a.review.details.map((detail, index) => (
                    <li key={index}>{detail}</li>
                  ))}
                </ul>
              )}
              <p>{a.review.warning}</p>
              {a.review.blockedReason && (
                <p role="alert">{a.review.blockedReason}</p>
              )}
            </section>
          )}
          {a.params.questions?.map((q) => (
            <label key={q.id}>
              {q.question}
              <textarea required name={q.id} />
            </label>
          ))}
          <div className="button-row">
            {a.params.questions ? (
              <button type="submit" className="primary" disabled={pending}>
                답변 보내기
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={
                    pending ||
                    (!!a.review &&
                      !a.review.decisions.some(
                        (d) => d === "decline" || d === "cancel",
                      ))
                  }
                  onClick={() => {
                    respond(a.id, {
                      decision:
                        a.review && !a.review.decisions.includes("decline")
                          ? "cancel"
                          : "decline",
                    });
                  }}
                >
                  거절
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={pending || a.review?.canAccept === false}
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (!form?.reportValidity()) return;
                    if (
                      a.method === "otter/knowledge" &&
                      !window.confirm(
                        "이 본문에 기밀이 없음을 확인했으며 같은 회사의 다른 프로젝트·실행 환경에서 재사용하도록 공유할까요?",
                      )
                    )
                      return;
                    respond(a.id, {
                      decision: "accept",
                      ...(a.review?.acknowledgement
                        ? {
                            scopeConfirmed: true,
                          }
                        : {}),
                      ...(a.method === "otter/knowledge"
                        ? { shareConfirmed: true }
                        : {}),
                    });
                  }}
                >
                  {a.method === "otter/hire"
                    ? "채용 승인"
                    : a.method === "otter/document"
                      ? "변경 반영"
                      : a.method === "otter/knowledge"
                        ? "본문 확인·공유 승인"
                        : a.method === "item/permissions/requestApproval"
                          ? "이번 턴에만 권한 허용"
                          : "이번 요청 승인"}
                </button>
              </>
            )}
          </div>
        </form>
      ))}
    </>
  );
}
