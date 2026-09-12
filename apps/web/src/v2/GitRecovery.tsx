import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./types";

type Observation = {
  outcome: string;
  execution: string;
  message: string;
  actual: string;
  approval: string;
};
export function GitRecovery({
  path,
  environment,
}: {
  path: string;
  environment?: string;
}) {
  const client = useQueryClient();
  const [observation, setObservation] = useState<Observation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  return (
    <section className="git-recovery" aria-label="Git 결과 복구">
      <p>
        원래 대상의 이력을 대조합니다. 필요하면 Git 이력 객체만 가져오며 작업
        파일 변경·병합·재전송은 하지 않습니다.
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          setNotice("");
          setObservation(null);
          setConfirmed(false);
          void api<Observation>(path, undefined, environment)
            .then(setObservation)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "확인 중…" : "실제 Git 결과 대조"}
      </button>
      {observation && (
        <>
          <p role="status">{observation.message}</p>
          <details>
            <summary>관측한 상태</summary>
            <p>
              Git 실행:{" "}
              {observation.execution === "closed"
                ? "종료 확인"
                : observation.execution === "running"
                  ? "프로세스 존재"
                  : "종료 미확인"}
            </p>
            <code>{observation.actual || "원격 브랜치 없음"}</code>
          </details>
          {observation.outcome !== "unknown" && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Git 상태를 기록에만 반영합니다. Git 재실행은 별도 승인하며 기존
                대기 업무는 재개될 수 있습니다.
              </label>
              <button
                disabled={busy || !confirmed}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void api(
                    path,
                    { confirm: true, approval: observation.approval },
                    environment,
                  )
                    .then(() => {
                      setNotice(
                        "파일이나 원격을 변경하지 않고 기록을 반영했습니다.",
                      );
                      setObservation(null);
                    })
                    .catch((e) => {
                      setError(e.message);
                      setObservation(null);
                      setConfirmed(false);
                    })
                    .finally(() => {
                      setBusy(false);
                      void client.invalidateQueries({ queryKey: ["v2"] });
                    });
                }}
              >
                {observation.outcome === "applied"
                  ? "반영 기록 복원"
                  : "미반영으로 기록"}
              </button>
            </>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
