import { useEffect, useState } from "react";
import { api, type Environment, type Project, type Task } from "./types";

type Target = {
  path: string;
  branch: string;
  expectedBranch?: string;
  active: boolean;
  environmentName: string;
  args: string[];
};
export function EditorLink({
  project,
  task,
  environments = [],
}: {
  project: Project;
  task?: Task;
  environments?: Environment[];
}) {
  const [open, setOpen] = useState(false);
  if (
    project.stage === "idea" ||
    (task && (!task.worktree || task.mode === "interview"))
  )
    return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {task ? "작업 폴더 IDE로 열기" : "외부 IDE에서 열기"}
      </button>
      {open && (
        <EditorDialog
          key={project.id + (task?.id || "")}
          project={project}
          task={task}
          environment={environments.find((e) => e.id === project.environmentId)}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function EditorDialog({
  project,
  task,
  environment,
  close,
}: {
  project: Project;
  task?: Task;
  environment?: Environment;
  close: () => void;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [sshHost, setSSHHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [chooseExecutable, setChooseExecutable] = useState(false);
  const environmentId = project.environmentId || "local";
  const path =
    "editor?projectId=" +
    encodeURIComponent(project.id) +
    (task ? "&taskId=" + encodeURIComponent(task.id) : "");
  useEffect(() => {
    if (environment?.kind === "ssh") return;
    let current = true;
    void api<Target>(path, undefined, environmentId)
      .then((value) => {
        if (current) setTarget(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [path, environmentId, environment?.kind]);
  return (
    <dialog
      className="modal-backdrop"
      aria-labelledby="editor-title"
      ref={(element) => {
        if (element && !element.open) element.showModal();
      }}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="modal editor-dialog">
        <button className="modal-close" aria-label="닫기" onClick={close}>
          ×
        </button>
        <h2 id="editor-title">
          {task ? "직원 작업 폴더 열기" : "프로젝트 원본 열기"}
        </h2>
        <p>
          {project.environmentLabel || "로컬"} · {project.name}
          {task ? ` · ${task.title}` : ""}
        </p>
        <p>
          직원의 결과는 작업 폴더에 있습니다. 원본 열기만으로 결과를 병합하지
          않습니다.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setTarget(null);
            setNotice("");
            void api<Target>(
              path + "&sshHost=" + encodeURIComponent(sshHost),
              undefined,
              environmentId,
            )
              .then(setTarget)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {environment?.kind === "ssh" && (
            <>
              <label>
                VS Code에 등록한 SSH Host 별칭
                <input
                  required
                  value={sshHost}
                  onChange={(e) => {
                    setSSHHost(e.target.value);
                    setTarget(null);
                  }}
                  placeholder="예: company-dev"
                  maxLength={253}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]*"
                />
              </label>
              <p>
                Otter 대상:{" "}
                {environment.username ? environment.username + "@" : ""}
                {environment.host} · 포트 {environment.port || 22}. VS Code의
                Remote - SSH에 같은 대상·사용자·포트·키를 등록한 별칭을
                입력하세요. Otter는 개인 SSH 설정이나 인증 파일을 복사·변경하지
                않습니다.
              </p>
            </>
          )}
          {environment?.kind === "wsl" && (
            <p>
              Windows VS Code의 WSL 확장과 {environment.distribution} 배포판이
              필요합니다.
            </p>
          )}
          <button disabled={busy}>
            {busy ? "확인 중…" : "작업 경로 확인"}
          </button>
        </form>
        {target && (
          <>
            <label>
              실제로 열 폴더
              <input
                readOnly
                value={target.path}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p>현재 브랜치: {target.branch || "분리된 HEAD"}</p>
            {target.expectedBranch &&
              target.expectedBranch !== target.branch && (
                <p role="status">
                  기록한 작업 브랜치({target.expectedBranch})와 현재 브랜치가
                  다릅니다. 외부 변경을 확인하세요.
                </p>
              )}
            {target.active && (
              <p role="status">
                실행 중이거나 종료가 확인되지 않은 업무가 있습니다. 같은 파일을
                동시에 수정하면 충돌할 수 있으니 업무 상태를 먼저 확인하세요.
              </p>
            )}
            <p>
              외부 IDE의 편집은 실제 파일에 반영됩니다. Otter는 자동
              중단·병합·커밋·푸시하지 않습니다.
            </p>
            <div className="button-row">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(target.path);
                    setNotice("폴더 경로를 복사했습니다.");
                  } catch {
                    setError(
                      "복사 권한이 없습니다. 위 경로를 선택해 직접 복사해 주세요.",
                    );
                  }
                }}
              >
                폴더 경로 복사
              </button>
              {window.otter?.openEditor && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    setNotice("");
                    void window
                      .otter!.openEditor({
                        projectId: project.id,
                        taskId: task?.id,
                        environmentId,
                        sshHost,
                        chooseExecutable,
                      })
                      .then((result) =>
                        setNotice(
                          result.launched
                            ? "VS Code 실행 요청을 전달했습니다. 열린 IDE에서 대상과 연결 상태를 확인하세요."
                            : "IDE 열기를 취소했습니다.",
                        ),
                      )
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  VS Code 열기
                </button>
              )}
            </div>
            {window.otter?.openEditor ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={chooseExecutable}
                  onChange={(e) => setChooseExecutable(e.target.checked)}
                />
                VS Code 실행 파일 다시 선택
              </label>
            ) : (
              <p>
                브라우저에서는 경로를 복사해 해당 컴퓨터의 IDE에서 여세요.
                설치형 Otter에서는 VS Code로 바로 열 수 있습니다.
              </p>
            )}
            <details>
              <summary>VS Code 실행 인자</summary>
              <pre>{JSON.stringify(target.args, null, 2)}</pre>
              <small>
                인자는 셸 명령문이 아닙니다. SSH/WSL은 IDE의 원격 연결에서 해당
                경로를 여세요.
              </small>
            </details>
          </>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </section>
    </dialog>
  );
}
