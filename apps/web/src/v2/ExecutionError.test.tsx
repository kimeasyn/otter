import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionError } from "./ExecutionError";

afterEach(cleanup);

it("모델 오류는 과거 기록임을 안내하고 설정 이동만 수행하며 원문과 재시도 경고를 보존한다", () => {
  const text =
    JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message:
          "The 'fixture-model' model is not supported when using Codex with a ChatGPT account.",
      },
    }) + "\n명령·도구 실행 또는 승인 요청이 있어 자동 재시도하지 않았습니다.";
  const settings = vi.fn();
  const { container } = render(
    <ExecutionError text={text} onSettings={settings} />,
  );
  expect(
    screen.getByText("요청 당시 모델을 사용할 수 없다는 응답입니다."),
  ).toBeVisible();
  expect(
    screen.getByText(/현재 설정은 오류 발생 당시와 다를 수 있습니다/),
  ).toBeVisible();
  expect(
    screen.getByText(
      "명령·도구 실행 또는 승인 요청이 있어 자동 재시도하지 않았습니다.",
    ),
  ).toBeVisible();
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(container.querySelector("pre")?.textContent).toBe(text);
  expect(settings).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "직원 모델 설정 확인 →" }),
  );
  expect(settings).toHaveBeenCalledExactlyOnceWith("staff");
});

it.each([
  [
    { status: 401, error: { message: "Unauthorized" } },
    "실행 계정의 인증·접근 권한을 확인해야 합니다.",
  ],
  [
    { status: 403, error: { message: "Denied" } },
    "실행 계정의 인증·접근 권한을 확인해야 합니다.",
  ],
  [
    { error: { code: "ETIMEDOUT", message: "Connection timed out" } },
    "실행 중 연결 오류가 보고되었습니다.",
  ],
])(
  "인증/연결 증거가 있는 응답은 실행 환경으로 안내한다: %j",
  (value, title) => {
    const settings = vi.fn();
    render(
      <ExecutionError
        text={JSON.stringify(value, null, 2)}
        onSettings={settings}
      />,
    );
    expect(screen.getByText(title)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "실행 환경 확인 →" }));
    expect(settings).toHaveBeenCalledExactlyOnceWith("environment");
  },
);

it("알 수 없는 구조와 일반 안내는 인증/모델 문제로 추측하지 않는다", () => {
  const { rerender, container } = render(
    <ExecutionError text='{"error":{"message":"Unfamiliar error"}}' />,
  );
  expect(screen.getByText(/원인을 자동으로 분류하지 못했습니다/)).toBeVisible();
  for (const text of [
    "기존 실행의 종료를 먼저 확인하세요.",
    "{잘못된 JSON",
    "null",
    '{"error":null}',
    "The model is not supported라는 예시를 확인했습니다.",
  ]) {
    rerender(<ExecutionError text={text} onSettings={vi.fn()} />);
    expect(container.textContent).toBe(text);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  }
});
