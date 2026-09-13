import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const catalog = {
  models: [{ model: "available", displayName: "조회 모델", isDefault: true }],
};

it("자동 조회와 선택을 하나의 필수 드롭다운으로 제공하며 목록 밖 기존 값은 저장하지 못한다", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(catalog)));
  vi.stubGlobal("fetch", fetcher);
  render(
    <form>
      <ModelPicker environment="ssh-a" defaultValue="old-model" />
    </form>,
  );
  const picker = screen.getByRole("combobox", {
    name: "Codex 모델",
  }) as HTMLSelectElement;
  expect(picker.checkValidity()).toBe(false);
  await screen.findByRole("option", { name: /조회 모델/ });
  expect(fetcher).toHaveBeenCalledWith("/api/codex-models", {
    headers: { "X-Otter-Environment": "ssh-a" },
  });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(picker).toHaveValue("");
  expect(picker.checkValidity()).toBe(false);
  fireEvent.change(picker, { target: { value: "available" } });
  expect(picker.checkValidity()).toBe(true);
  expect(new FormData(picker.form!).get("model")).toBe("available");
});

it("목록에 있는 기존 모델을 유지하며 조회 실패·빈 목록에서는 선택과 저장을 막는다", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(catalog)))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "failed" }), { status: 503 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] })));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(
    <ModelPicker environment="first" defaultValue="available" />,
  );
  const picker = screen.getByRole("combobox") as HTMLSelectElement;
  await waitFor(() => expect(picker).toHaveValue("available"));
  rerender(<ModelPicker environment="second" defaultValue="available" />);
  await screen.findByRole("alert");
  expect(picker.checkValidity()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await screen.findByRole("option", { name: "선택 가능한 모델이 없습니다" });
  expect(picker.checkValidity()).toBe(false);
});

it("환경 변경 뒤 도착한 이전 목록을 무시한다", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog))),
  );
  const { rerender } = render(<ModelPicker environment="old" />);
  rerender(<ModelPicker environment="new" />);
  await screen.findByRole("option", { name: /조회 모델/ });
  resolve(
    new Response(
      JSON.stringify({
        models: [{ model: "wrong", displayName: "이전 환경" }],
      }),
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /이전 환경/ }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("option", { name: /조회 모델/ })).toBeInTheDocument();
});
