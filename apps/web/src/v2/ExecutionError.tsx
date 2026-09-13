export type ErrorSettings = (
  target: "staff" | "environment",
  assignmentId?: string,
) => void;

// 표시용 분류만 수행한다. 원문·저장 기록·재시도 정책은 변경하지 않는다.
function describeError(text: string) {
  for (const candidate of [text, text.split("\n")[0]]) {
    try {
      const value = JSON.parse(candidate) as {
        status?: unknown;
        error?: { message?: unknown; code?: unknown; type?: unknown };
      } | null;
      if (!value || typeof value.error?.message !== "string") continue;
      const { message, code, type } = value.error;
      const note = text.slice(candidate.length).trim();
      if (/\bmodel\b.*\bnot supported\b/i.test(message))
        return {
          title: "요청 당시 모델을 사용할 수 없다는 응답입니다.",
          help: "직원 화면에서 담당자의 ‘프로젝트 설정’을 열어 모델명과 실행 계정에서 사용 가능한 모델을 확인하세요. 현재 설정은 오류 발생 당시와 다를 수 있습니다.",
          target: "staff" as const,
          note,
        };
      if (
        value.status === 401 ||
        value.status === 403 ||
        [
          "authentication_error",
          "invalid_api_key",
          "permission_denied",
        ].includes(String(type)) ||
        code === "invalid_api_key"
      )
        return {
          title: "실행 계정의 인증·접근 권한을 확인해야 합니다.",
          help: "이 프로젝트의 실행 환경에서 로그인한 계정과 접근 권한을 확인하세요. 원격 작업이라면 접속 중인 PC가 아니라 해당 실행 서버 기준입니다.",
          target: "environment" as const,
          note,
        };
      if (
        ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(
          String(code),
        )
      )
        return {
          title: "실행 중 연결 오류가 보고되었습니다.",
          help: "실행 환경의 연결 상태와 오류 원문을 확인하세요. 이 메시지만으로 작업 실행 여부나 외부 변경이 없었다고 판단할 수는 없습니다.",
          target: "environment" as const,
          note,
        };
      return {
        title: "실행 오류가 보고되었지만 원인을 자동으로 분류하지 못했습니다.",
        help: message,
        note,
      };
    } catch {
      // 일반 안내문이나 해석할 수 없는 응답은 원문 그대로 보여준다.
    }
  }
  return null;
}

export function ExecutionError({
  text,
  onSettings,
}: {
  text: string;
  onSettings?: ErrorSettings;
}) {
  const explanation = describeError(text);
  if (!explanation) return <p className="execution-error-text">{text}</p>;
  return (
    <section className="execution-error" aria-label="실행 오류 안내">
      <strong>{explanation.title}</strong>
      <p>{explanation.help}</p>
      {explanation.note && <p>{explanation.note}</p>}
      <small>
        설정 확인만으로 업무를 다시 실행하지 않습니다. 기존 업무·보고를 확인한
        뒤 이어갈지 결정하세요.
      </small>
      {explanation.target && onSettings && (
        <button type="button" onClick={() => onSettings(explanation.target!)}>
          {explanation.target === "staff"
            ? "직원 모델 설정 확인 →"
            : "실행 환경 확인 →"}
        </button>
      )}
      <details>
        <summary>오류 원문 보기</summary>
        <pre tabIndex={0}>{text}</pre>
      </details>
    </section>
  );
}
