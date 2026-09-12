import { useState } from "react";
import { api, type Environment, type Snapshot } from "./types";

type Readiness = {
  checkedAt: string;
  checks: {
    name: string;
    status: "passed" | "failed" | "unknown";
    message: string;
  }[];
};

type ExecutableSettings = { path: string; revision: string | null };

export function CodexExecutable({
  environment,
  changed,
}: {
  environment: string;
  changed: () => void;
}) {
  const [settings, setSettings] = useState<ExecutableSettings | null>(null);
  const [path, setPath] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = () => {
    setBusy(true);
    setError("");
    setNotice("");
    void api<ExecutableSettings>("codex-settings", undefined, environment)
      .then((value) => {
        setSettings(value);
        setPath(value.path);
        setConfirmed(false);
      })
      .catch((error) => setError(error.message))
      .finally(() => setBusy(false));
  };
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !settings && !busy && !error) load();
      }}
    >
      <summary>Codex 실행 파일 설정</summary>
      <p className="form-note">
        기본은 이 실행 환경의 PATH에서 codex를 찾습니다. 설치 앱에서 찾지 못하면
        실행 파일을 직접 지정하세요. 저장만으로 파일을 실행하거나 로그인 정보를
        옮기지 않습니다.
      </p>
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            void api<ExecutableSettings>(
              "codex-settings",
              { path, revision: settings.revision, confirm: confirmed },
              environment,
            )
              .then((value) => {
                setSettings(value);
                setPath(value.path);
                setConfirmed(false);
                changed();
                setNotice(
                  "저장했습니다. Codex 준비 상태 확인으로 연결을 검사해 주세요.",
                );
              })
              .catch((error) => setError(error.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Codex 실행 파일의 절대 경로
            <input
              value={path}
              disabled={busy}
              placeholder="비우면 기본 codex 사용"
              onChange={(event) => {
                setPath(event.target.value);
                setConfirmed(false);
                setNotice("");
              }}
            />
          </label>
          {environment === "local" && window.otter?.pickCodex && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void window
                  .otter!.pickCodex()
                  .then((value) => {
                    if (value) {
                      setPath(value);
                      setConfirmed(false);
                      setNotice("");
                    }
                  })
                  .catch(() => setError("파일 선택 창을 열지 못했습니다."))
                  .finally(() => setBusy(false));
              }}
            >
              파일에서 선택…
            </button>
          )}
          <p className="form-note">
            인수나 로그인 키는 입력하지 않습니다. SSH/WSL은 해당 환경의 경로를
            입력하세요. Windows는 실제 .exe 파일을 사용합니다. 진행 중인
            실행·진단이 있으면 변경할 수 없습니다.
          </p>
          <label className="codex-executable-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            지정한 실행 파일 또는 기본 codex를 신뢰하며, 대기 업무를 포함한 다음
            실행에 사용하는 데 동의합니다.
          </label>
          <button disabled={busy || !confirmed}>실행 파일 설정 저장</button>
        </form>
      )}
      <button type="button" disabled={busy} onClick={load}>
        {busy ? "설정 처리 중…" : "현재 설정 다시 불러오기"}
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </details>
  );
}

export function CodexCheck({
  environment,
  connected = true,
}: {
  environment: string;
  connected?: boolean;
}) {
  const [result, setResult] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section aria-label="Codex 준비 상태" className="codex-readiness">
      <button
        disabled={busy || !connected}
        onClick={() => {
          setBusy(true);
          setResult(null);
          setError("");
          void api<Readiness>("codex-check", {}, environment)
            .then(setResult)
            .catch(() =>
              setError(
                "검사 결과를 받지 못했습니다. 해당 실행 환경의 연결과 종료 상태를 확인한 뒤 다시 시도해 주세요.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Codex 확인 중…" : "Codex 준비 상태 확인"}
      </button>
      <p className="form-note">
        모델 호출 없이 연결·계정 설정·고정 샌드박스 명령을 검사합니다. 프로젝트
        파일은 수정하지 않습니다.
      </p>
      {!connected && (
        <p className="form-note">
          먼저 이 실행 환경에 연결해 주세요. 이전 검사 결과는 현재 상태를
          보장하지 않습니다.
        </p>
      )}
      <div role="status" aria-live="polite">
        {busy && (
          <p>
            검사 중입니다. 이 창을 닫아도 시작한 검사는 종료 확인까지
            진행됩니다.
          </p>
        )}
        {result && (
          <>
            <small>
              검사 시각 {new Date(result.checkedAt).toLocaleString()}
            </small>
            <ul>
              {result.checks.map((check) => (
                <li key={check.name} data-status={check.status}>
                  <strong>
                    {check.name} ·{" "}
                    {
                      {
                        passed: "확인됨",
                        failed: "조치 필요",
                        unknown: "미확인",
                      }[check.status]
                    }
                  </strong>
                  <p>{check.message}</p>
                </li>
              ))}
            </ul>
            <p className="form-note">
              이 결과는 해당 시점의 실행 환경 검사입니다. 실제 모델 응답이나
              프로젝트별 작업 성공을 보장하지 않습니다.
            </p>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {connected && (
        <CodexExecutable
          environment={environment}
          changed={() => setResult(null)}
        />
      )}
    </section>
  );
}

export function Environments({
  data,
  action,
}: {
  data: Snapshot;
  action: (
    path: string,
    input: unknown,
    environment?: string,
  ) => Promise<unknown>;
}) {
  const [kind, setKind] = useState("ssh");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Environment | null>(null);
  const run = (path: string, input: unknown) => {
    setBusy(true);
    setError("");
    return action(path, input, "local")
      .catch((error) => {
        setError(error.message);
        throw error;
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="environment-settings">
      <span className="eyebrow">WHERE YOUR TEAM WORKS</span>
      <h2 id="modal-title">실행 환경</h2>
      <p>
        코드와 도구는 선택한 컴퓨터에서 실행됩니다. SSH 연결을 해제해도 서버의
        업무는 계속됩니다.
      </p>
      <div className="environment-card">
        <strong>이 컴퓨터 · 로컬</strong>
        <span>
          실행 가능 {data.localSlots ?? data.settings.concurrency}개 / 전체 한도{" "}
          {data.settings.concurrency}개
        </span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run("settings", {
              concurrency: Number(
                new FormData(event.currentTarget).get("concurrency"),
              ),
            }).catch(() => {});
          }}
        >
          <label>
            전체 동시 실행 한도
            <input
              key={data.settings.concurrency}
              name="concurrency"
              type="number"
              min="1"
              max="16"
              required
              defaultValue={data.settings.concurrency}
            />
          </label>
          <button disabled={busy}>실행 한도 저장</button>
        </form>
        <CodexCheck environment="local" />
      </div>
      {(data.environments || []).map((environment) => (
        <article className="environment-card" key={environment.id}>
          <div>
            <strong>{environment.name}</strong>
            <span>
              {environment.kind.toUpperCase()} ·{" "}
              {environment.host || environment.distribution} ·{" "}
              {environment.slots}개{" "}
              {environment.allocated ? "예약 중" : "시작 시 예약"}
            </span>
          </div>
          <p>
            {environment.connected
              ? "연결됨"
              : environment.error || "연결되지 않음"}
          </p>
          {environment.lastSeen && (
            <small>
              최근 확인 {new Date(environment.lastSeen).toLocaleString()}
            </small>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(
                `environments/${environment.id}/${environment.connected ? "disconnect" : "connect"}`,
                {},
              ).catch(() => {})
            }
          >
            {environment.connected ? "연결만 해제" : "다시 연결"}
          </button>
          <button
            disabled={busy || environment.busy}
            onClick={() => {
              setEditing(environment);
              setKind(environment.kind);
              setError("");
            }}
          >
            연결 설정 수정
          </button>
          {environment.allocated && (
            <button
              className="danger"
              disabled={busy || environment.busy}
              onClick={() => {
                if (
                  window.confirm(
                    `${environment.name}의 실행 중인 업무를 중단하고 실행 자리 예약을 반환할까요? 프로젝트 파일과 기록은 삭제하지 않습니다. 종료가 확인되지 않으면 예약을 유지합니다.`,
                  )
                )
                  void run(`environments/${environment.id}/stop`, {}).catch(
                    () => {},
                  );
              }}
            >
              업무 중단·예약 반환
            </button>
          )}
          <CodexCheck
            key={`${environment.id}:${environment.revision}`}
            environment={environment.id}
            connected={environment.connected}
          />
        </article>
      ))}
      <details
        className="environment-add"
        open={!!editing || !data.environments?.length}
      >
        <summary>
          {editing ? `${editing.name} 연결 설정 수정` : "＋ 실행 환경 등록"}
        </summary>
        <form
          key={editing?.id || "new"}
          onSubmit={(event) => {
            event.preventDefault();
            const input = Object.fromEntries(new FormData(event.currentTarget));
            if (editing) {
              void run(`environments/${editing.id}/edit`, {
                ...input,
                revision: editing.revision,
                slots: Number(input.slots || editing.slots),
                port: Number(input.port || editing.port || 22),
              })
                .then(() => setEditing(null))
                .catch(() => {});
              return;
            }
            void run("environments", {
              ...input,
              kind,
              slots: Number(input.slots),
              port: Number(input.port || 22),
            })
              .then((result) =>
                run(
                  `environments/${(result as { id: string }).id}/connect`,
                  {},
                ),
              )
              .catch(() => {});
          }}
        >
          <label>
            환경 이름
            <input
              name="name"
              required
              defaultValue={editing?.name}
              placeholder="개발 서버 / 회사 WSL"
            />
          </label>
          <label>
            연결 방식
            <select
              value={kind}
              disabled={!!editing}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="ssh">SSH 서버</option>
              <option value="wsl">WSL (Windows 앱)</option>
            </select>
          </label>
          {kind === "ssh" ? (
            <>
              <div className="form-grid">
                <label>
                  호스트 / SSH 별칭
                  <input
                    name="host"
                    required
                    defaultValue={editing?.host}
                    placeholder="dev-server"
                  />
                </label>
                <label>
                  사용자
                  <input
                    name="username"
                    defaultValue={editing?.username}
                    placeholder="SSH 설정의 기본 사용자"
                  />
                </label>
              </div>
              <div className="form-grid">
                <label>
                  포트
                  <input
                    name="port"
                    type="number"
                    min="1"
                    max="65535"
                    defaultValue={editing?.port || 22}
                    required
                  />
                </label>
                <label>
                  SSH 키 파일 경로 (선택)
                  <input
                    name="identityFile"
                    defaultValue={editing?.identityFile}
                    placeholder="이 컴퓨터의 키 파일 경로"
                  />
                </label>
              </div>
              <p className="form-note">
                기존 SSH 키/에이전트를 사용합니다. 먼저 터미널에서 이 호스트의
                키를 확인하고 비밀번호 입력 없이 접속할 수 있어야 합니다. 비밀
                키나 Codex 인증 파일은 복사하지 않습니다.
              </p>
            </>
          ) : (
            <label>
              WSL 배포판 이름
              <input
                name="distribution"
                required
                defaultValue={editing?.distribution}
                disabled={!!editing?.workerId}
                placeholder="Ubuntu-24.04"
              />
            </label>
          )}
          <label>
            예약 실행 수
            <input
              name="slots"
              type="number"
              min="1"
              max="16"
              defaultValue={editing?.slots || 1}
              disabled={!!editing?.allocated}
              required
            />
          </label>
          <p className="form-note">
            등록만으로 예약하지 않습니다. 실행을 시작할 때 예약하며, 연결만
            해제하면 유지됩니다. 예약 수를 변경하려면 먼저 업무 중단·예약 반환을
            선택하세요.
          </p>
          <details>
            <summary>Node 경로와 실행부 저장 위치</summary>
            <label>
              Node.js 실행 파일
              <input
                name="nodeExecutable"
                defaultValue={editing?.nodeExecutable}
                placeholder="node 또는 원격 절대 경로"
              />
            </label>
            <label>
              실행부 전용 폴더
              <input
                name="directory"
                defaultValue={editing?.directory}
                disabled={!!editing?.workerId}
                placeholder="기본: 원격 사용자 폴더/.otter-v2-remote"
              />
            </label>
          </details>
          <p className="form-note">
            등록 후 연결하면 선택한 환경의 개인 폴더에 Otter 실행부를
            설치합니다. Node.js 24 이상과 Git이 필요하며, 업무용 도구는 해당
            환경에 별도로 준비해야 합니다.
          </p>
          <button className="primary wide" disabled={busy}>
            {busy ? "처리 중…" : editing ? "연결 설정 저장" : "등록하고 연결"}
          </button>
          {editing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setKind("ssh");
              }}
            >
              수정 취소
            </button>
          )}
        </form>
      </details>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
