import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Staff } from "./Staff";
import type { Snapshot, Employee, Assignment } from "./types";

const showModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (showModal)
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
});
const employee: Employee = {
  id: "e",
  revision: 2,
  name: "김코딩",
  role: "개발",
  model: "",
  skills: "",
  instructions: "비교한 원본",
  appearance: { color: "#6675cf", avatar: "default" },
};
const assignment: Assignment = {
  id: "a",
  employeeId: employee.id,
  revision: 1,
  employeeRevision: 1,
  settings: { ...employee, instructions: "프로젝트 지침" },
  appearance: employee.appearance,
};
const initial = {
  employees: [employee],
  assignments: [assignment],
} as Snapshot;

it("편집 중 자동 조회가 입력이나 저장 기준 버전을 바꾸지 않고 충돌 뒤 입력을 유지한다", async () => {
  const action = vi.fn().mockRejectedValue(new Error("다른 변경이 있습니다"));
  const props = { action, onChat: vi.fn(), onAdd: vi.fn() };
  const { rerender } = render(<Staff data={initial} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
  fireEvent.change(screen.getByRole("textbox", { name: "지침" }), {
    target: { value: "작성 중인 지침" },
  });
  rerender(
    <Staff
      {...props}
      data={{
        ...initial,
        assignments: [
          {
            ...assignment,
            revision: 2,
            settings: { ...employee, instructions: "다른 곳에서 저장한 지침" },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "지침" })).toHaveValue(
    "작성 중인 지침",
  );
  fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      "assignments/a/edit",
      expect.objectContaining({ revision: 1, instructions: "작성 중인 지침" }),
    ),
  );
  expect(await screen.findByText("다른 변경이 있습니다")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "지침" })).toHaveValue(
    "작성 중인 지침",
  );
});

it("비교 중 원본 변경은 반영을 막고 다시 비교하면 새 버전과 선택을 확인한다", async () => {
  const action = vi.fn().mockResolvedValue({});
  const props = { action, onChat: vi.fn(), onAdd: vi.fn() };
  const { rerender } = render(<Staff data={initial} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "원본과 비교 · 1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /지침 반영/ }));
  rerender(
    <Staff
      {...props}
      data={{
        ...initial,
        employees: [{ ...employee, revision: 3, instructions: "새 원본" }],
      }}
    />,
  );
  expect(screen.getByText("비교한 원본")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "선택한 변경 반영" }),
  ).toBeDisabled();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "최신 설정 다시 비교" }));
  expect(screen.getByText("새 원본")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /지침 반영/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: /지침 반영/ }));
  fireEvent.click(screen.getByRole("button", { name: "선택한 변경 반영" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith("assignments/a/refresh", {
      revision: 1,
      sourceRevision: 3,
      fields: ["instructions"],
    }),
  );
});
