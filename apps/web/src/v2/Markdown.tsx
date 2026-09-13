import ReactMarkdown from "react-markdown";
import { useState } from "react";

function FileReference({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState("");
  return (
    <span className="file-reference">
      <code title={path}>{children}</code>
      <button
        type="button"
        title={path}
        aria-label={`파일 경로 복사: ${path}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setCopied("복사됨");
          } catch {
            setCopied(path);
          }
        }}
      >
        경로 복사
      </button>
      {copied && <small role="status">{copied}</small>}
    </span>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        skipHtml
        urlTransform={(url) => {
          if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
          if (/^[a-z]:[\\/]/i.test(url)) return url;
          if (
            !/^[a-z][a-z\d+.-]*:/i.test(url) &&
            !/^[\\/]{2}/.test(url) &&
            !/[\u0000-\u001f]/.test(url)
          )
            return url;
          return "";
        }}
        components={{
          a: ({ href, children }) =>
            !href ? (
              <span>{children}</span>
            ) : /^(https?:\/\/|mailto:)/i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <FileReference path={href}>{children}</FileReference>
            ),
          img: ({ alt }) => (
            <span className="image-placeholder">
              [이미지: {alt || "설명 없음"} · 자동 로드하지 않음]
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
