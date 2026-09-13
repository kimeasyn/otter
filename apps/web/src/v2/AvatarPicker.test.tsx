import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AvatarPicker } from "./AvatarPicker";

afterEach(cleanup);

it("화살표로 순환 선택하고 현재 외형만 제출하며 저장 중 이동하지 않는다", () => {
  const submit = vi.fn((event) => event.preventDefault());
  const { container, rerender } = render(
    <form onSubmit={submit}>
      <AvatarPicker avatar="cap" />
    </form>,
  );
  const value = () =>
    new FormData(container.querySelector("form")!).get("avatar");
  expect(value()).toBe("cap");
  const next = screen.getByRole("button", { name: "다음 아바타" });
  fireEvent.click(next);
  expect(value()).toBe("headset");
  expect(screen.getByRole("status")).toHaveTextContent("라벤더 후드 · 6 / 6");
  fireEvent.keyDown(next, { key: "ArrowRight" });
  expect(value()).toBe("default");
  fireEvent.keyDown(next, { key: "ArrowLeft" });
  expect(value()).toBe("headset");
  expect(submit).not.toHaveBeenCalled();
  rerender(
    <form onSubmit={submit}>
      <AvatarPicker avatar="cap" disabled />
    </form>,
  );
  expect(next).toBeDisabled();
  fireEvent.keyDown(next, { key: "ArrowRight" });
  expect(screen.getByRole("status")).toHaveTextContent("헤드셋");
});

it("이전 외형 ID를 알 수 없으면 기본 아바타를 보여준다", () => {
  render(<AvatarPicker avatar="unknown" />);
  expect(screen.getByRole("status")).toHaveTextContent("기본");
});
