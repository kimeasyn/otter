import { useState } from "react";
import { api, type Document } from "./types";

type FilePreview = {
  documentId: string;
  revision: number;
  documentContent: string;
  name: string;
  path: string;
  exists: boolean;
  content: string;
  hash: string | null;
  warning: string | null;
  state: string;
};
export function InstructionFile({
  doc,
  action,
  environment = "local",
  dirty,
}: {
  doc: Document;
  action: (path: string, input: unknown) => Promise<unknown>;
  environment?: string;
  dirty: boolean;
}) {
  const [name, setName] = useState(doc.fileSync?.name || "AGENTS.md");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const compare = () => {
    setBusy(true);
    setError("");
    void api<FilePreview>(
      `documents/${doc.id}/file?name=${encodeURIComponent(name)}`,
      undefined,
      environment,
    )
      .then(setPreview)
      .catch((error) => setError(error.message))
      .finally(() => setBusy(false));
  };
  const sync = (direction: "import" | "export") => {
    if (!preview || dirty) return;
    setBusy(true);
    setError("");
    void action(`documents/${doc.id}/file-${direction}`, {
      name: preview.name,
      revision: preview.revision,
      fileHash: preview.hash,
    })
      .then((result) => {
        const value = result as { backupPath?: string };
        setPreview(null);
        setNotice(
          direction === "import"
            ? "파일 내용을 Otter 문서로 가져왔습니다."
            : `원본 파일에 저장했습니다. Git 커밋은 하지 않았습니다.${value.backupPath ? " 복구 파일: " + value.backupPath : ""}`,
        );
      })
      .catch((error) => {
        setError(error.message);
        setPreview(null);
      })
      .finally(() => setBusy(false));
  };
  return (
    <details className="instruction-files">
      <summary>저장소 지침 파일 · {doc.fileSync?.name || "연결 안 됨"}</summary>
      <p>
        Otter 문서 저장과 원본 파일 저장은 별도입니다. 원본을 바꾸려면 아래
        내용을 비교하고 반영하세요.
      </p>
      <label>
        프로젝트 루트 지침 파일
        <select
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setPreview(null);
            setNotice("");
          }}
        >
          <option>AGENTS.md</option>
          <option>AGENTS.override.md</option>
        </select>
      </label>
      <button type="button" disabled={busy} onClick={compare}>
        {busy ? "확인 중…" : "파일과 비교"}
      </button>
      {dirty && (
        <p role="status">
          작성 중인 문서를 먼저 저장해야 가져오기·파일 반영을 할 수 있습니다.
        </p>
      )}
      {preview && (
        <section className="file-comparison">
          <code>{preview.path}</code>
          <p>
            {preview.state === "same"
              ? "내용이 같습니다."
              : preview.state === "file-changed"
                ? "마지막 동기화 이후 파일이 변경되었습니다."
                : "문서와 파일 내용이 다릅니다."}
          </p>
          {preview.warning && (
            <p role="status" className="form-error">
              {preview.warning}
            </p>
          )}
          <div className="file-columns">
            <div>
              <h3>현재 원본 파일{!preview.exists ? " (없음)" : ""}</h3>
              <pre>{preview.content || "(비어 있음)"}</pre>
            </div>
            <div>
              <h3>저장된 Otter 문서 · 버전 {preview.revision}</h3>
              <pre>{preview.documentContent || "(비어 있음)"}</pre>
            </div>
          </div>
          <div className="button-row">
            <button
              type="button"
              disabled={
                dirty ||
                busy ||
                !preview.exists ||
                preview.revision !== doc.revision
              }
              onClick={() => sync("import")}
            >
              파일 내용을 문서로 가져오기
            </button>
            <button
              type="button"
              className="primary"
              disabled={dirty || busy || preview.revision !== doc.revision}
              onClick={() => sync("export")}
            >
              문서를 원본 파일에 반영
            </button>
          </div>
          <small>
            기존 파일은 Git 내부 복구 폴더에 보존합니다. 비교 후 변경된 파일은
            덮어쓰지 않습니다.
          </small>
        </section>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="file-notice">
          {notice}
        </p>
      )}
      {doc.fileSync && (
        <small>
          연결한 지침은 새 작업 브랜치에도 적용합니다. 작업 브랜치에서 따로
          수정된 지침은 자동 교체하지 않습니다.
        </small>
      )}
    </details>
  );
}
