import { useState } from "react";
import type { Project, VerificationResult } from "./types";

export function Completion({
  project,
  action,
  busy,
}: {
  project: Project;
  action: (
    path: string,
    input: unknown,
    environment?: string,
  ) => Promise<unknown>;
  busy: boolean;
}) {
  const [mode, setMode] = useState(project.completion || "manual");
  const [checks, setChecks] = useState(project.checks || []);
  const [revision, setRevision] = useState(project.revision);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const changed = revision !== project.revision;
  return (
    <section className="completion-settings">
      <h2>이 프로젝트의 완료 방식</h2>
      <p>
        새 업무·사용자 추가 요청부터 적용됩니다. 이미 받은 업무는 기존 설정을
        유지합니다.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action(
            `projects/${project.id}/completion`,
            { revision, completion: mode, checks, confirm: confirmed },
            project.environmentId,
          )
            .then((value) => {
              setRevision((value as Project).revision);
              setConfirmed(false);
              setNotice("완료 방식을 저장했습니다.");
            })
            .catch(() => {});
        }}
      >
        <fieldset disabled={busy}>
          <label>
            완료 판단
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as "manual" | "verified");
                setConfirmed(false);
              }}
            >
              <option value="manual">내가 결과를 검토한 후 완료</option>
              <option value="verified">지정한 검증 통과 후 자동 완료</option>
            </select>
          </label>
          <p>
            검증은 별도 작업 공간에서 실행하며 네트워크는 차단합니다. 자동
            완료는 병합·푸시·배포를 허용하지 않습니다.
          </p>
          {checks.map((check, index) => {
            const change = (patch: Partial<typeof check>) => {
              setChecks(
                checks.map((c, i) => (i === index ? { ...c, ...patch } : c)),
              );
              setConfirmed(false);
            };
            return (
              <fieldset key={index}>
                <legend>검증 {index + 1}</legend>
                <label>
                  검증 이름
                  <input
                    required
                    maxLength={120}
                    value={check.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <label>
                  실행 파일
                  <input
                    required
                    value={check.command[0]}
                    placeholder="npm"
                    onChange={(e) =>
                      change({
                        command: [e.target.value, ...check.command.slice(1)],
                      })
                    }
                  />
                </label>
                <label>
                  인수 · 한 줄에 하나
                  <textarea
                    rows={3}
                    value={check.command.slice(1).join("\n")}
                    placeholder={"test\n--\n--run"}
                    onChange={(e) =>
                      change({
                        command: [
                          check.command[0],
                          ...(e.target.value ? e.target.value.split("\n") : []),
                        ],
                      })
                    }
                  />
                </label>
                <label>
                  제한 시간 · 초
                  <input
                    type="number"
                    min="1"
                    max="600"
                    required
                    value={check.timeoutSeconds}
                    onChange={(e) =>
                      change({ timeoutSeconds: Number(e.target.value) })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setChecks(checks.filter((_, i) => i !== index));
                    setConfirmed(false);
                  }}
                >
                  검증 {index + 1} 제거
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            disabled={checks.length >= 8}
            onClick={() => {
              setChecks([
                ...checks,
                {
                  name: "프로젝트 테스트",
                  command: ["npm", "test"],
                  timeoutSeconds: 120,
                },
              ]);
              setConfirmed(false);
            }}
          >
            검증 명령 추가
          </button>
          {!!checks.length && (
            <label className="completion-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              이 명령과 실행되는 프로젝트 스크립트를 확인했으며 결과 검증 시
              자동 실행에 동의합니다.
            </label>
          )}
          <p>
            새 검증 공간에는 커밋된 파일만 있습니다. 필요한 도구·의존성이 없으면
            실패로 보고합니다. 통과는 지정한 검사 범위에 한하며, 전체 요구사항
            충족을 보증하지 않습니다.
          </p>
          {changed && (
            <p role="alert">
              프로젝트 설정이 변경됐습니다. 입력을 보존했습니다. 최신 설정을
              불러온 뒤 다시 편집해 주세요.
            </p>
          )}
          {changed && (
            <button
              type="button"
              onClick={() => {
                setMode(project.completion || "manual");
                setChecks(project.checks || []);
                setRevision(project.revision);
                setConfirmed(false);
              }}
            >
              최신 설정 불러오기 · 현재 입력 버리기
            </button>
          )}
          <button
            type="submit"
            disabled={
              changed ||
              (checks.length > 0 && !confirmed) ||
              (mode === "verified" && !checks.length)
            }
          >
            완료 방식 저장
          </button>
          {notice && <p role="status">{notice}</p>}
        </fieldset>
      </form>
    </section>
  );
}

export function Verification({
  result,
}: {
  result?: VerificationResult | null;
}) {
  if (!result) return null;
  return (
    <details className="verification-result" open={result.status !== "passed"}>
      <summary>
        별도 검증 ·{" "}
        {(
          {
            running: "실행 중",
            passed: "지정 검사 통과",
            failed: "실패",
            interrupted: "중단",
            unconfirmed: "종료 미확인",
          } as Record<string, string>
        )[result.status] || "미확인"}
      </summary>
      {result.commit && (
        <p>
          검증 커밋: <code>{result.commit.slice(0, 12)}</code>
        </p>
      )}
      {result.error && <p role="alert">{result.error}</p>}
      <ul>
        {result.checks.map((check, index) => (
          <li key={index}>
            {check.name} ·{" "}
            {check.status === "running"
              ? "실행 중"
              : check.status === "pending"
                ? "미실행"
                : check.status === "passed"
                  ? "통과"
                  : "실패/미확인"}
            {check.exitCode !== undefined
              ? ` · 종료 코드 ${check.exitCode}`
              : ""}
            <pre>{JSON.stringify(check.command)}</pre>
          </li>
        ))}
      </ul>
      <p>
        Otter가 지정한 명령을 별도로 실행한 기록입니다. 직원의 자기 보고와
        구분됩니다. 자격 증명 노출을 줄이기 위해 명령 출력은 자동 저장하지
        않습니다.
      </p>
    </details>
  );
}
