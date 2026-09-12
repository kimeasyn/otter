import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./types";

type PendingRequest = {
  id: string;
  environmentName: string;
  environmentId: string;
  path: string;
  input: unknown;
  status: string;
  observation?: string;
  createdAt: string;
  observedAt?: string;
  responseStatus?: number;
  responseError?: string;
  resultId?: string;
};
type ResultLocation = {
  projectId: string;
  assignmentId?: string;
  taskId?: string;
  environmentId: string;
};
function resultLocation(item: PendingRequest): ResultLocation | undefined {
  if (
    item.status !== "confirmed" ||
    !item.responseStatus ||
    item.responseStatus >= 300 ||
    !item.resultId
  )
    return;
  if (["/api/projects", "/api/projects/idea"].includes(item.path))
    return { projectId: item.resultId, environmentId: item.environmentId };
  if (
    item.path !== "/api/tasks" &&
    !/^\/api\/tasks\/[^/]+\/continue$/.test(item.path)
  )
    return;
  const input = item.input as {
    projectId?: unknown;
    assignmentId?: unknown;
  } | null;
  if (
    typeof input?.projectId === "string" &&
    typeof input.assignmentId === "string"
  )
    return {
      projectId: input.projectId,
      assignmentId: input.assignmentId,
      taskId: item.resultId,
      environmentId: item.environmentId,
    };
}
export function RequestRecovery({
  onEnvironments,
  onOpen,
}: {
  onEnvironments: () => void;
  onOpen: (location: ResultLocation) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["request-recovery"],
    queryFn: () => api<PendingRequest[]>("request-journal"),
    refetchInterval: 2000,
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run = async (id: string, operation: string) => {
    if (
      operation === "retry" &&
      !window.confirm(
        "원래 요청의 대상과 내용을 확인했나요? 원격 처리 기록이 없을 때만 동일한 요청 ID로 다시 전달합니다. 아직 전달되지 않았던 요청은 실제 실행될 수 있습니다.",
      )
    )
      return;
    setBusy(id);
    setError("");
    try {
      await api(`request-journal/${id}/${operation}`, {
        confirm: operation === "retry",
      });
      await Promise.all([
        query.refetch(),
        client.invalidateQueries({ queryKey: ["v2"] }),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!query.data?.length && !query.error) return null;
  return (
    <details className="request-recovery" open>
      <summary>요청 복구 · {query.data?.length || 0}개</summary>
      <p>
        응답 확인이 남은 로컬·원격 요청입니다. 앱을 다시 열어도 유지됩니다. 먼저
        처리 결과만 조회하며 자동으로 재실행하지 않습니다.
      </p>
      {query.data?.some((item) => item.environmentId !== "local") && (
        <button onClick={onEnvironments}>실행 환경 연결 확인</button>
      )}
      {(error || query.error) && (
        <p role="alert">{error || query.error?.message}</p>
      )}
      {query.data?.map((item) => (
        <article key={item.id}>
          <h3>
            {item.environmentName} ·{" "}
            {item.path === "/api/tasks"
              ? "업무 요청"
              : item.path.startsWith("/api/projects")
                ? "프로젝트 변경"
                : item.path.startsWith("/api/approvals")
                  ? "승인 응답"
                  : item.path.startsWith("/api/documents")
                    ? "문서 변경"
                    : "변경 요청"}
          </h3>
          <p>
            {item.status === "confirmed"
              ? item.responseStatus && item.responseStatus < 300
                ? "처리 응답을 확인했습니다. 실제 업무 완료 여부는 업무·보고에서 확인하세요."
                : "실패 응답을 확인했습니다. 부분 변경이 있을 수 있으니 실제 상태를 확인하세요."
              : item.observation === "pending"
                ? "실행부에서 접수했지만 결과가 아직 없습니다. 다시 실행하지 않습니다."
                : item.observation === "missing"
                  ? item.environmentId === "local"
                    ? "로컬 처리 기록을 확인하지 못했습니다. 실제 업무·파일 상태를 확인하세요. 다시 실행하지 않습니다."
                    : "현재 원격에 처리 기록이 없습니다. 원래 요청을 확인한 뒤 동일 ID로 재전달할 수 있습니다."
                  : "처리 여부 미확인"}
          </p>
          <small>{new Date(item.createdAt).toLocaleString()}</small>
          {item.responseError && <p role="alert">{item.responseError}</p>}
          {resultLocation(item) && (
            <button onClick={() => onOpen(resultLocation(item)!)}>
              {resultLocation(item)?.taskId
                ? "업무 대화 열기"
                : "생성한 프로젝트 열기"}
            </button>
          )}
          <details>
            <summary>원래 요청 확인</summary>
            <p>
              요청 ID: <code>{item.id}</code>
            </p>
            {item.resultId && (
              <p>
                결과 항목 ID: <code>{item.resultId}</code>
              </p>
            )}
            <code>{item.path}</code>
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          </details>
          {item.status === "pending" ? (
            <>
              <button
                disabled={!!busy}
                onClick={() => void run(item.id, "check")}
              >
                처리 결과 조회
              </button>
              {item.environmentId !== "local" &&
                item.observation === "missing" && (
                  <button
                    disabled={!!busy}
                    onClick={() => void run(item.id, "retry")}
                  >
                    동일 요청 다시 전달
                  </button>
                )}
            </>
          ) : (
            <button disabled={!!busy} onClick={() => void run(item.id, "ack")}>
              확인했어요 · 복구 목록에서 닫기
            </button>
          )}
        </article>
      ))}
    </details>
  );
}
