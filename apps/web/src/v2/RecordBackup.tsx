import { useState } from "react";

export function RecordBackup() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    path?: string;
    bytes?: number;
    sha256?: string;
  } | null>(null);
  const [error, setError] = useState("");
  return (
    <section className="record-backup" aria-label="로컬 기록 백업">
      <details>
        <summary>로컬 기록 백업</summary>
        <p>
          이 PC에 저장된 모든 회사·직원·지침·대화·보고와 원격 조회 캐시의
          사본입니다. 선택한 원격 프로젝트의 전체 백업이 아닙니다.
        </p>
        <p>
          프로젝트/직원 작업 파일·원격 원본 DB·인증 파일·미저장 입력은
          제외합니다. 대화·지침에 입력한 비밀 정보는 포함될 수 있습니다.
          암호화되지 않으므로 안전한 위치에 보관하세요. 자동 복원과 업무 재개는
          아직 지원하지 않습니다.
        </p>
        {window.otter?.backupRecords ? (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              setResult(null);
              void window.otter!.backupRecords!()
                .then((value) => {
                  if (value.saved) setResult(value);
                })
                .catch((error) => setError(error.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "기록 사본 저장·검증 중…" : "범위 확인 후 파일로 저장…"}
          </button>
        ) : (
          <p>
            설치형 앱의 Otter 메뉴 또는 이 화면에서 저장할 수 있습니다. 브라우저
            개발 화면에서는 네이티브 저장 기능을 사용할 수 없습니다.
          </p>
        )}
        {result && (
          <div role="status">
            <p>
              로컬 기록 사본 저장·검증 완료 · {result.bytes?.toLocaleString()}{" "}
              바이트
            </p>
            <code>{result.path}</code>
            <p>
              SHA-256: <code>{result.sha256}</code>
            </p>
            <p>
              현재 원본 DB에 덮어쓰지 마세요. 이 사본만으로 프로젝트 파일이나
              실행 환경을 복구할 수는 없습니다.
            </p>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    </section>
  );
}
