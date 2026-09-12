import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Project } from "./types";
import { GitRecovery } from "./GitRecovery";

type Options = {
  path: string;
  branch: string;
  remotes: { name: string; url?: string; error?: string }[];
};
type Preview = {
  url: string;
  sourceBranch: string;
  branch: string;
  commit: string;
  expected: string;
  count: number;
  summary: string;
  approval: string;
  alreadyPushed: boolean;
};
export function PushProject({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  if (project.stage === "idea") return null;
  return (
    <>
      <button onClick={() => setOpen(true)}>Git 푸시…</button>
      {open && (
        <PushDialog
          key={project.id}
          project={project}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function PushDialog({
  project,
  close,
}: {
  project: Project;
  close: () => void;
}) {
  const client = useQueryClient();
  const [options, setOptions] = useState<Options | null>(null);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const path = `projects/${project.id}/push`;
  const environment = project.environmentId || "local";
  useEffect(() => {
    let current = true;
    void api<Options>(path, undefined, environment)
      .then((value) => {
        if (!current) return;
        setOptions(value);
        setBranch(value.branch);
        setRemote(
          value.remotes.find((r) => r.name === "origin" && r.url)?.name ||
            value.remotes.find((r) => r.url)?.name ||
            "",
        );
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [path, environment]);
  const clear = () => {
    setPreview(null);
    setConfirmed(false);
    setError("");
    setResult("");
  };
  return (
    <dialog
      className="modal-backdrop"
      aria-labelledby="push-title"
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
        <h2 id="push-title">원격 저장소로 전송</h2>
        <p>
          {project.environmentLabel || "로컬"} · {project.name}
        </p>
        <p>
          원본 브랜치의 커밋 이력을 전송합니다. 직원 결과는 먼저 원본에
          반영하세요.
        </p>
        <p>푸시하면 서버의 CI/CD·자동 배포·유료 작업이 시작될 수 있습니다.</p>
        <details>
          <summary>전송 범위와 제한</summary>
          <p>
            커밋하지 않은 파일과 직원의 미병합 결과는 전송하지 않습니다. 원본의
            과거 커밋도 전송에 포함됩니다.
          </p>
          <p>
            로컬 pre-push 훅은 실행하지 않습니다. Git LFS처럼 훅이 필요한
            저장소는 외부 IDE를 사용하세요.
          </p>
          <p>
            확인/전송 중에는 외부 IDE나 터미널에서 원본과 Git 접속 설정을
            변경하지 마세요.
          </p>
        </details>
        {project.push && (
          <details>
            <summary>마지막 푸시 기록</summary>
            <p>
              {project.push.remote} / {project.push.branch} ·{" "}
              {project.push.status === "pushed"
                ? "전송 확인"
                : project.push.status === "not-pushed"
                  ? "미전송 확인 · 새 승인 필요"
                  : "결과 확인 필요 · 재전송하지 않음"}
            </p>
            <code>{project.push.commit}</code>
          </details>
        )}
        {project.push &&
          ["sending", "unconfirmed"].includes(project.push.status) && (
            <GitRecovery path={`${path}-recovery`} environment={environment} />
          )}
        {options && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              clear();
              setBusy(true);
              void api<Preview>(
                `${path}?remote=${encodeURIComponent(remote)}&branch=${encodeURIComponent(branch)}`,
                undefined,
                environment,
              )
                .then(setPreview)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              전송 원본
              <input
                readOnly
                value={`${options.path} (${options.branch || "분리된 HEAD"})`}
              />
            </label>
            {options.remotes.length ? (
              <>
                <label>
                  원격 저장소
                  <select
                    required
                    value={remote}
                    disabled={busy}
                    onChange={(e) => {
                      setRemote(e.target.value);
                      clear();
                    }}
                  >
                    <option value="">선택하세요</option>
                    {options.remotes.map((r) => (
                      <option key={r.name} value={r.name} disabled={!r.url}>
                        {r.name}
                        {r.error ? " · 설정 확인 필요" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <p>{options.remotes.find((r) => r.name === remote)?.url}</p>
                <label>
                  원격 대상 브랜치
                  <input
                    required
                    maxLength={255}
                    value={branch}
                    disabled={busy}
                    onChange={(e) => {
                      setBranch(e.target.value);
                      clear();
                    }}
                  />
                </label>
                <button disabled={busy || !remote}>
                  {busy ? "확인/전송 중…" : "원격 상태와 전송 내용 확인"}
                </button>
              </>
            ) : (
              <p>
                등록된 Git 원격이 없습니다. 외부 IDE에서 원격 저장소를 연결한 뒤
                다시 여세요. GitHub 저장소를 자동 생성하지 않습니다.
              </p>
            )}
            {options.remotes
              .filter((r) => r.error)
              .map((r) => (
                <p key={r.name}>
                  {r.name}: {r.error}
                </p>
              ))}
          </form>
        )}
        {preview && !result && (
          <>
            <p>
              전송 대상:{" "}
              <strong>
                {preview.url} / {preview.branch}
              </strong>
            </p>
            <p>
              {preview.expected ? "기존 브랜치에 추가" : "새 원격 브랜치 생성"}{" "}
              · {preview.count}개 커밋
            </p>
            <pre>{preview.summary || "전송할 새 커밋 없음"}</pre>
            {preview.count > 30 && (
              <small>
                최근 30개만 표시합니다. 나머지 커밋도 전송 범위에 포함됩니다.
              </small>
            )}
            <details>
              <summary>확인한 커밋</summary>
              <p>전송: {preview.commit}</p>
              <p>원격: {preview.expected || "브랜치 없음"}</p>
            </details>
            {preview.alreadyPushed ? (
              <p role="status">
                이 커밋은 이미 원격 브랜치에 있습니다. 다시 전송하지 않습니다.
              </p>
            ) : (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  위 이력의 외부 전송과 원격 CI/CD·자동화가 실행될 수 있음을
                  확인하고 승인합니다.
                </label>
                <button
                  className="primary"
                  disabled={busy || !confirmed}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void api(
                      path,
                      {
                        remote,
                        branch,
                        approval: preview.approval,
                        confirm: true,
                        confirmAutomation: true,
                      },
                      environment,
                    )
                      .then(() =>
                        setResult(
                          "원격 브랜치의 전송 결과를 확인했습니다. 서버 CI/CD 결과는 원격 서비스에서 확인하세요.",
                        ),
                      )
                      .catch((e) => {
                        setError(e.message);
                        setPreview(null);
                        setConfirmed(false);
                      })
                      .finally(() => {
                        setBusy(false);
                        void client.invalidateQueries({ queryKey: ["v2"] });
                      });
                  }}
                >
                  {busy ? "전송 확인 중…" : "승인하고 푸시"}
                </button>
              </>
            )}
          </>
        )}
        {result && <p role="status">{result}</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </section>
    </dialog>
  );
}
