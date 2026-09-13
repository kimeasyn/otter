import { useEffect, useState } from "react";
import { api } from "./types";

type Catalog = {
  models: { model: string; displayName: string; isDefault: boolean }[];
  checkedAt: string;
};
export function ModelPicker({
  name = "model",
  label = "Codex 모델",
  defaultValue = "",
  environment = "local",
  environmentLabel,
  disabled = false,
}: {
  name?: string;
  label?: string;
  defaultValue?: string;
  environment?: string;
  environmentLabel?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const [result, setResult] = useState<{
    environment: string;
    catalog?: Catalog;
    error?: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setResult(null);
    void api<Catalog>("codex-models", undefined, environment)
      .then((catalog) => {
        if (current) setResult({ environment, catalog });
      })
      .catch((error) => {
        if (current) setResult({ environment, error: error.message });
      });
    return () => {
      current = false;
    };
  }, [environment, retry]);
  const current = result?.environment === environment ? result : null;
  const models = current?.catalog?.models || [];
  const selected = models.some((item) => item.model === value) ? value : "";
  return (
    <div className="model-picker">
      <label>
        {label}
        <select
          name={name}
          aria-label={label}
          value={selected}
          required
          disabled={disabled}
          aria-busy={!current}
          onChange={(event) => {
            if (models.some((item) => item.model === event.target.value))
              setValue(event.target.value);
          }}
        >
          <option value="" disabled>
            {!current
              ? "모델 목록 불러오는 중…"
              : current.error
                ? "모델 목록 조회 실패"
                : !models.length
                  ? "선택 가능한 모델이 없습니다"
                  : "모델을 선택하세요"}
          </option>
          {models.map((item) => (
            <option key={item.model} value={item.model}>
              {item.displayName} · {item.model}
              {item.isDefault ? " · 기본" : ""}
            </option>
          ))}
        </select>
      </label>
      <small>
        실행 환경:{" "}
        {environmentLabel ||
          (environment === "local" ? "로컬 실행부" : environment)}
      </small>
      {current?.catalog && value && !selected && (
        <p>
          기존 모델 ‘{value}’은 이 목록에 없습니다. 저장하려면 목록에서 다시
          선택하세요.
        </p>
      )}
      {current?.error && (
        <p role="alert">
          모델을 불러오지 못했습니다. 실행 환경의 연결·Codex 설치·로그인 상태를
          확인해 주세요.
        </p>
      )}
      {current && !models.length && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setRetry((n) => n + 1)}
        >
          다시 불러오기
        </button>
      )}
      {models.length > 0 && (
        <small>
          선택 후 저장해야 적용됩니다. 목록 조회는 실제 모델 실행 검사가
          아닙니다.
        </small>
      )}
    </div>
  );
}
