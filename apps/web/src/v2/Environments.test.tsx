import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexCheck, CodexExecutable } from "./Environments";

afterEach(cleanup);

it("원격 연결 전 검사를 막고 선택 환경의 단계별 결과와 미검증 범위를 표시한다", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          checkedAt: new Date().toISOString(),
          checks: [
            {
              name: "Codex 연결",
              status: "passed",
              message: "원격 실행부 연결",
            },
            { name: "계정 설정", status: "unknown", message: "계정 미검증" },
            {
              name: "샌드박스 실행",
              status: "failed",
              message: "호스트 격리 지원 확인 필요",
            },
          ],
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const { rerender } = render(
      <CodexCheck environment="ssh-a" connected={false} />,
    );
    expect(
      screen.getByRole("button", { name: "Codex 준비 상태 확인" }),
    ).toBeDisabled();
    rerender(<CodexCheck environment="ssh-a" connected />);
    fireEvent.click(
      screen.getByRole("button", { name: "Codex 준비 상태 확인" }),
    );
    expect(await screen.findByText("샌드박스 실행 · 조치 필요")).toBeVisible();
    expect(screen.getByText("계정 설정 · 미확인")).toBeVisible();
    expect(
      screen.getByText(/실제 모델 응답이나 프로젝트별 작업 성공/),
    ).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/codex-check",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Otter-Environment": "ssh-a" }),
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("실행 파일 선택은 동의 후 저장하며 선택 환경을 유지하고 진단은 자동 실행하지 않는다", async () => {
  const changed = vi.fn();
  const picker = vi.fn(async () => "/tools/codex");
  const original = window.otter;
  window.otter = {
    pickCodex: picker,
    pickFolder: async () => {
      throw new Error("이 검사에서 폴더 선택은 호출하지 않는다");
    },
    openEditor: async () => {
      throw new Error("이 검사에서 IDE는 실행하지 않는다");
    },
  };
  const fetcher = vi.fn(
    async (_path: string, input?: RequestInit) =>
      new Response(
        JSON.stringify(
          input?.method === "POST"
            ? { path: "/tools/codex", revision: "next" }
            : { path: "", revision: null },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<CodexExecutable environment="local" changed={changed} />);
    fireEvent.click(screen.getByText("Codex 실행 파일 설정", { exact: true }));
    fireEvent.click(
      screen.getByRole("button", { name: "현재 설정 다시 불러오기" }),
    );
    const save = await screen.findByRole("button", {
      name: "실행 파일 설정 저장",
    });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "파일에서 선택…" }));
    expect(await screen.findByDisplayValue("/tools/codex")).toBeVisible();
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    expect(await screen.findByText(/저장했습니다/)).toBeVisible();
    expect(changed).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/codex-settings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Otter-Environment": "local" }),
      }),
    );
    expect(
      fetcher.mock.calls.every(([path]) => path === "/api/codex-settings"),
    ).toBe(true);
  } finally {
    window.otter = original;
    vi.unstubAllGlobals();
  }
});
