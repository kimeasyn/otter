import { useEffect, useState } from "react";
import { api, type Project } from "./types";

type Preview = Omit<NonNullable<Project["automation"]>, "id"> & {
  revision: number;
  approval: string;
};
export function AutomationSettings({
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
  const [merge, setMerge] = useState(project.automation?.merge || "approval");
  const [push, setPush] = useState(project.automation?.push || "approval");
  const [deploy, setDeploy] = useState(
    project.automation?.deploy || "approval",
  );
  const [deployName, setDeployName] = useState(
    project.automation?.deployment?.name || "프로젝트 배포",
  );
  const [deployExecutable, setDeployExecutable] = useState(
    project.automation?.deployment?.command[0] || "",
  );
  const [deployArgs, setDeployArgs] = useState(
    project.automation?.deployment?.command.slice(1).join("\n") || "",
  );
  const [deployTimeout, setDeployTimeout] = useState(
    project.automation?.deployment?.timeoutSeconds || 300,
  );
  const [remote, setRemote] = useState(
    project.automation?.destination?.remote || "origin",
  );
  const [branch, setBranch] = useState(
    project.automation?.destination?.branch || "main",
  );
  const [remotes, setRemotes] = useState<
    { name: string; url?: string; error?: string }[]
  >([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [remoteConfirmed, setRemoteConfirmed] = useState(false);
  const [deploymentConfirmed, setDeploymentConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = `projects/${project.id}/automation`;
  const environment = project.environmentId || "local";
  const configuredBranch = project.automation?.destination?.branch;
  const input = {
    merge,
    push,
    deploy,
    remote,
    branch,
    deployment:
      deploy === "auto"
        ? {
            name: deployName,
            command: [
              deployExecutable,
              ...(deployArgs ? deployArgs.split("\n") : []),
            ],
            timeoutSeconds: deployTimeout,
          }
        : null,
  };
  const clear = () => {
    setPreview(null);
    setConfirmed(false);
    setRemoteConfirmed(false);
    setDeploymentConfirmed(false);
    setError("");
    setNotice("");
  };
  useEffect(() => {
    let current = true;
    void api<{ branch: string; remotes: typeof remotes }>(
      `projects/${project.id}/push`,
      undefined,
      environment,
    )
      .then((value) => {
        if (current) {
          setRemotes(value.remotes);
          if (!configuredBranch) setBranch(value.branch || "main");
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [project.id, environment, configuredBranch]);
  return (
    <section
      className="completion-settings automation-settings"
      aria-labelledby="automation-title"
    >
      <h2 id="automation-title">완료 후 자동 반영</h2>
      <p>
        현재:{" "}
        {project.automation
          ? `원본 반영 ${project.automation.merge === "auto" ? "자동" : "직접 승인"} · 푸시 ${project.automation.push === "auto" ? "자동" : "직접 승인"} · 배포 ${project.automation.deploy === "auto" ? "자동" : "직접 승인"}`
          : "원본 반영·푸시·배포 모두 직접 승인"}
      </p>
      {project.automation?.destination && (
        <p>
          고정 전송 대상: {project.automation.destination.url} ·{" "}
          {project.automation.destination.branch}
        </p>
      )}
      <p>
        설정 이후 받은 업무가 완료된 뒤 적용합니다. 수동 완료 방식이면 먼저
        결과를 승인해야 합니다. 기존 업무에 소급 적용하지 않으며 다른 업무가
        진행 중이면 기다립니다. 설정 변경·해제는 이전 설정으로 받은 업무의 자동
        반영도 중단합니다.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!preview) return;
          void action(
            path,
            {
              ...input,
              approval: preview.approval,
              confirm: confirmed,
              confirmRemote: remoteConfirmed,
              confirmDeployment: deploymentConfirmed,
            },
            environment,
          )
            .then(() => {
              clear();
              setNotice(
                "자동 반영 설정을 저장했습니다. 새 업무부터 적용됩니다.",
              );
            })
            .catch(() => {
              setPreview(null);
              setConfirmed(false);
              setRemoteConfirmed(false);
              setDeploymentConfirmed(false);
            });
        }}
      >
        <fieldset disabled={busy || loading}>
          <label>
            원본 반영
            <select
              value={merge}
              onChange={(e) => {
                setMerge(e.target.value as typeof merge);
                clear();
              }}
            >
              <option value="approval">직접 확인하고 반영</option>
              <option value="auto">완료된 업무 자동 반영</option>
            </select>
          </label>
          <label>
            원격 푸시
            <select
              value={push}
              onChange={(e) => {
                setPush(e.target.value as typeof push);
                clear();
              }}
            >
              <option value="approval">직접 확인하고 푸시</option>
              <option value="auto">원본 반영 후 자동 푸시</option>
            </select>
          </label>
          {push === "auto" && (
            <>
              <label>
                등록 원격
                <select
                  value={remote}
                  onChange={(e) => {
                    setRemote(e.target.value);
                    clear();
                  }}
                >
                  {!remotes.some((r) => r.name === remote) && (
                    <option value={remote}>원격을 선택해 주세요</option>
                  )}
                  {remotes.map((r) => (
                    <option key={r.name} value={r.name} disabled={!r.url}>
                      {r.name}
                      {r.error ? " · 확인 불가" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                원격 브랜치
                <input
                  value={branch}
                  required
                  maxLength={255}
                  onChange={(e) => {
                    setBranch(e.target.value);
                    clear();
                  }}
                />
              </label>
            </>
          )}
          <label>
            배포 명령
            <select
              value={deploy}
              onChange={(e) => {
                setDeploy(e.target.value as typeof deploy);
                clear();
              }}
            >
              <option value="approval">배포 메뉴에서 매번 승인</option>
              <option value="auto">원본 반영 후 자동 실행</option>
            </select>
          </label>
          {deploy === "auto" && (
            <>
              <label>
                자동 배포 이름
                <input
                  required
                  maxLength={120}
                  value={deployName}
                  onChange={(e) => {
                    setDeployName(e.target.value);
                    clear();
                  }}
                />
              </label>
              <label>
                배포 실행 파일의 절대 경로
                <input
                  required
                  value={deployExecutable}
                  onChange={(e) => {
                    setDeployExecutable(e.target.value);
                    clear();
                  }}
                />
              </label>
              <label>
                자동 배포 인수 · 한 줄에 하나
                <textarea
                  value={deployArgs}
                  onChange={(e) => {
                    setDeployArgs(e.target.value);
                    clear();
                  }}
                />
              </label>
              <label>
                배포 제한 시간 · 초
                <input
                  type="number"
                  required
                  min={1}
                  max={600}
                  value={deployTimeout}
                  onChange={(e) => {
                    setDeployTimeout(Number(e.target.value));
                    clear();
                  }}
                />
              </label>
              <p>
                원본 반영 후 실행하며 자동 푸시를 선택했다면 그 확인 뒤
                실행합니다. 같은 정책·원본 커밋의 정상 종료 기록이 있으면 다시
                실행하지 않습니다. 인수는 기록되므로 비밀번호·토큰을 넣지
                마세요.
              </p>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              clear();
              setLoading(true);
              void api<Preview>(`${path}-preview`, input, environment)
                .then(setPreview)
                .catch((e) => setError(e.message))
                .finally(() => setLoading(false));
            }}
          >
            자동 반영 범위 확인
          </button>
          {preview && (
            <div className="automation-preview">
              <p>
                실행 폴더: {preview.root}
                <br />
                원본 브랜치: {preview.sourceBranch}
              </p>
              {preview.destination && (
                <p>
                  실제 푸시 주소: {preview.destination.url}
                  <br />
                  대상 브랜치: {preview.destination.branch}
                </p>
              )}
              <label className="completion-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                완료된 업무를 이 범위에서 자동 반영하도록 허용합니다.
              </label>
              {push === "auto" && (
                <label className="completion-confirm">
                  <input
                    type="checkbox"
                    checked={remoteConfirmed}
                    onChange={(e) => setRemoteConfirmed(e.target.checked)}
                  />
                  원본 브랜치의 기존 커밋 이력도 전송되며 서버 CI/CD·배포·유료
                  자동화가 실행될 수 있음을 확인했습니다.
                </label>
              )}
              {preview.deployment && (
                <>
                  <p>고정 배포 실행 파일: {preview.deployment.executable}</p>
                  <pre>
                    {JSON.stringify(preview.deployment.command, null, 2)}
                  </pre>
                  <p>
                    향후 원본 커밋과 변경된 스크립트·의존성·환경 설정을
                    실행합니다. 에이전트 샌드박스가 아닌 실행 계정 권한으로
                    파일·네트워크·기존 인증 정보에 접근할 수 있습니다.
                    포그라운드에서 완료를 기다리는 명령만 사용하세요.
                  </p>
                  <p>
                    {preview.deployment.processTracking === "posix-group"
                      ? "같은 프로세스 그룹이 남으면 상위 명령의 종료 코드가 0이어도 미확정 상태로 자동 반영을 멈춥니다. 별도 세션·외부 서비스 작업의 종료까지 보장하지 않습니다."
                      : "상위 명령의 종료만 관찰합니다. 하위 프로세스와 외부 서비스 상태는 별도 확인이 필요합니다."}
                  </p>
                  <label className="completion-confirm">
                    <input
                      type="checkbox"
                      checked={deploymentConfirmed}
                      onChange={(e) => setDeploymentConfirmed(e.target.checked)}
                    />
                    이후 완료 업무의 원본 커밋마다 이 배포 명령을 자동 실행하고,
                    외부 변경·반복 실행·비용이 발생할 수 있음을 승인합니다.
                  </label>
                </>
              )}
              <button
                type="submit"
                disabled={
                  !confirmed ||
                  (push === "auto" && !remoteConfirmed) ||
                  (deploy === "auto" && !deploymentConfirmed)
                }
              >
                자동 반영 설정 저장
              </button>
            </div>
          )}
        </fieldset>
      </form>
      {project.automation && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void action(
              path,
              { disable: true, revision: project.revision },
              environment,
            )
              .then(() => {
                clear();
                setMerge("approval");
                setPush("approval");
                setDeploy("approval");
                setNotice(
                  "자동 반영을 해제했습니다. 이미 시작한 Git/배포 명령은 결과 기록까지 기다립니다.",
                );
              })
              .catch(() => {});
          }}
        >
          자동 반영 해제
        </button>
      )}
      <p>
        충돌·미커밋 변경·주소 변경·실행 실패는 보고하며 자동 재시도하지
        않습니다. 업무에서 Git 결과를 확인하고 수동 반영·푸시로 마무리할 수
        있습니다. 배포 결과는 배포 메뉴에서 확인하세요. 배포 명령 종료와 서비스
        성공은 별개입니다. 임의 에이전트 명령의 자동 승인은 포함하지 않습니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
