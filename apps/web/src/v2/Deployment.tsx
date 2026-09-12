import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Project } from "./types";

type Preview = {
  name: string;
  command: string[];
  timeoutSeconds: number;
  path: string;
  branch: string;
  commit: string;
  executable: string;
  approval: string;
  previous: string | null;
  processTracking: "posix-group" | "parent-only";
};
export function DeployProject({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  if (project.stage === "idea") return null;
  return (
    <>
      <button onClick={() => setOpen(true)}>배포…</button>
      {open && (
        <DeploymentDialog
          key={project.id}
          project={project}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function DeploymentDialog({
  project,
  close,
}: {
  project: Project;
  close: () => void;
}) {
  const client = useQueryClient();
  const last = project.deployment;
  const [name, setName] = useState(last?.name || "프로젝트 배포");
  const [executable, setExecutable] = useState(last?.command[0] || "");
  const [args, setArgs] = useState(last?.command.slice(1).join("\n") || "");
  const [timeout, setTimeoutSeconds] = useState(last?.timeoutSeconds || 300);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [access, setAccess] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const environment = project.environmentId || "local";
  const prefix = `projects/${project.id}/`;
  const pending = last && ["running", "unconfirmed"].includes(last.status);
  const clear = () => {
    setPreview(null);
    setConfirmed(false);
    setAccess(false);
    setRepeat(false);
    setError("");
    setNotice("");
  };
  const call = async (path: string, input: unknown) => {
    setBusy(true);
    setError("");
    try {
      return await api<Preview>(prefix + path, input, environment);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["v2"] });
    }
  };
  return (
    <dialog
      className="modal-backdrop"
      aria-labelledby="deployment-title"
      ref={(element) => {
        if (element && !element.open) element.showModal();
      }}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else close();
      }}
    >
      <section className="modal editor-dialog deployment-dialog">
        <button
          className="modal-close"
          aria-label="닫기"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
        <h2 id="deployment-title">배포 명령 실행</h2>
        <p>
          {project.environmentLabel || "로컬"} · {project.name}
        </p>
        <p>
          이 화면에서는 원본에 반영한 커밋에서 명령을 한 번 승인해 실행합니다.
          완료 후 자동 배포는 프로젝트 설정에서 별도로 선택합니다.
        </p>
        {last && (
          <section aria-label="마지막 배포 기록">
            <h3>마지막 실행</h3>
            <p role={last.status === "unconfirmed" ? "alert" : "status"}>
              {{
                running: "배포 명령 실행 중",
                succeeded: "명령 종료 · 서비스 확인 필요",
                unconfirmed: "결과 확인 필요 · 재실행 안 함",
                acknowledged: "사용자가 외부 결과 확인",
              }[last.status] || last.status}
            </p>
            <p>{last.status === "acknowledged" ? last.note : last.message}</p>
            {last.process && (
              <p>
                상위 명령: {last.process.closed ? "종료 확인" : "종료 미확인"}
                {last.process.groupId != null && (
                  <>
                    {" "}
                    · 프로세스 그룹 {last.process.groupId}:{" "}
                    {last.process.groupState === "absent"
                      ? "부재 확인"
                      : "종료 확인 필요"}
                  </>
                )}
              </p>
            )}
            <code>{last.commit}</code>
            {last.status === "unconfirmed" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void call("deployment-acknowledge", {
                    id: last.id,
                    revision: project.revision,
                    note,
                    confirm: ack,
                  })
                    .then(() =>
                      setNotice(
                        "사용자 확인을 기록했습니다. 재배포하지 않았습니다.",
                      ),
                    )
                    .catch(() => {});
                }}
              >
                <label>
                  외부 서비스에서 확인한 결과
                  <textarea
                    required
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  명령과 후속 프로세스가 끝났고, 외부 서비스의 변경·비용·중복
                  실행 여부를 확인했습니다.
                </label>
                <button disabled={busy || !ack || !note.trim()}>
                  확인 결과 기록
                </button>
              </form>
            )}
          </section>
        )}
        {!pending && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              clear();
              void call("deployment-preview", {
                name,
                command: [executable, ...(args ? args.split("\n") : [])],
                timeoutSeconds: timeout,
              })
                .then(setPreview)
                .catch(() => {});
            }}
          >
            <fieldset disabled={busy}>
              <label>
                배포 이름
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    clear();
                  }}
                />
              </label>
              <label>
                실행 파일의 절대 경로
                <input
                  required
                  value={executable}
                  onChange={(e) => {
                    setExecutable(e.target.value);
                    clear();
                  }}
                  placeholder="실행 환경에 설치된 배포 도구 경로"
                />
              </label>
              <label>
                배포 인수 · 한 줄에 하나
                <textarea
                  value={args}
                  onChange={(e) => {
                    setArgs(e.target.value);
                    clear();
                  }}
                />
              </label>
              <label>
                제한 시간 · 초
                <input
                  type="number"
                  required
                  min={1}
                  max={600}
                  value={timeout}
                  onChange={(e) => {
                    setTimeoutSeconds(Number(e.target.value));
                    clear();
                  }}
                />
              </label>
              <p>
                명령 인수는 실행 기록에 저장됩니다. 비밀번호·토큰을 입력하지
                말고 실행 환경의 기존 CLI 로그인을 사용하세요.
              </p>
              <button>배포 범위 확인</button>
            </fieldset>
          </form>
        )}
        {preview && !pending && (
          <section className="automation-preview" aria-label="승인할 배포 범위">
            <p>
              실행 폴더: {preview.path}
              <br />
              브랜치: {preview.branch}
              <br />
              커밋: {preview.commit}
            </p>
            <pre>
              {JSON.stringify(
                [preview.executable, ...preview.command.slice(1)],
                null,
                2,
              )}
            </pre>
            <p>
              이 명령은 에이전트 샌드박스가 아닌 실행 계정 권한으로 동작합니다.
              참조하는 스크립트·의존성·환경 설정에 따라 파일 접근, 외부
              전송·변경, 배포 및 비용이 발생할 수 있습니다.
            </p>
            <p>
              백그라운드로 분리되는 명령은 사용하지 마세요. 제한 시간에는 원
              명령에 종료를 요청하지만 외부 처리 취소를 보장하지 않습니다. 배포
              중에는 외부 IDE에서 원본을 수정하지 마세요.
            </p>
            <p>
              {preview.processTracking === "posix-group"
                ? "같은 프로세스 그룹이 남아 있으면 상위 명령의 종료 코드가 0이어도 미확정으로 유지하고 재실행·완전 종료를 막습니다. 별도 세션이나 외부 서비스로 분리된 작업까지 추적하지는 않습니다."
                : "이 실행 환경에서는 상위 명령의 종료만 관찰합니다. 하위 프로세스와 외부 서비스의 종료는 별도로 확인해야 합니다."}
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              위 명령·폴더·커밋으로 이번 배포 실행을 승인합니다.
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={access}
                disabled={busy}
                onChange={(e) => setAccess(e.target.checked)}
              />
              실행 계정의 파일·네트워크·인증 정보 접근 및 외부 변경·비용 영향을
              확인했습니다.
            </label>
            {preview.previous && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={repeat}
                  disabled={busy}
                  onChange={(e) => setRepeat(e.target.checked)}
                />
                이전 배포 결과를 확인했고 다시 실행할 때의 중복 효과를
                승인합니다.
              </label>
            )}
            <button
              className="primary"
              disabled={
                busy || !confirmed || !access || (!!preview.previous && !repeat)
              }
              onClick={() => {
                void call("deploy", {
                  ...preview,
                  confirm: confirmed,
                  confirmAccess: access,
                  confirmRepeat: repeat,
                })
                  .then(() => {
                    clear();
                    setNotice(
                      "배포 명령을 접수했습니다. 창을 닫아도 결과는 배포 기록과 보고에서 확인할 수 있습니다.",
                    );
                  })
                  .catch(() => {
                    setPreview(null);
                    setConfirmed(false);
                    setAccess(false);
                  });
              }}
            >
              승인하고 배포 명령 실행
            </button>
          </section>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    </dialog>
  );
}
