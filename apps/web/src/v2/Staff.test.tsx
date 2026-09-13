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
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ model: "fixture-model", displayName: "검사 모델" }],
          }),
        ),
    ),
  );
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
  vi.unstubAllGlobals();
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
  await screen.findByRole("option", { name: /검사 모델/ });
  fireEvent.click(screen.getByRole("button", { name: "이전 아바타" }));
  expect(screen.getByRole("status")).toHaveTextContent("헤드셋");
  fireEvent.change(screen.getByLabelText("Codex 모델"), {
    target: { value: "fixture-model" },
  });
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
      expect.objectContaining({
        revision: 1,
        instructions: "작성 중인 지침",
        avatar: "headset",
      }),
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

it("닫기·Esc·배경 클릭 뒤 초안과 기준 버전을 복원하고 명시적으로 최신 설정을 다시 연다", async () => {
  const action = vi.fn().mockRejectedValue(new Error("버전 충돌"));
  const props = {
    action,
    onChat: vi.fn(),
    onAdd: vi.fn(),
    projectId: "draft-close",
  };
  const { rerender } = render(<Staff data={initial} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
  await screen.findByRole("option", { name: /검사 모델/ });
  fireEvent.change(screen.getByRole("textbox", { name: "이름" }), {
    target: { value: "작성 중 이름" },
  });
  fireEvent.change(screen.getByLabelText("Codex 모델"), {
    target: { value: "fixture-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "이전 아바타" }));
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  const changed = {
    ...initial,
    assignments: [
      {
        ...assignment,
        revision: 3,
        settings: { ...assignment.settings, name: "새 이름" },
      },
    ],
  };
  rerender(<Staff data={changed} {...props} />);
  for (const method of ["cancel", "backdrop"] as const) {
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
    expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue(
      "작성 중 이름",
    );
    expect(screen.getByRole("status")).toHaveTextContent("헤드셋");
    await waitFor(() =>
      expect(screen.getByLabelText("Codex 모델")).toHaveValue("fixture-model"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "창을 연 뒤 설정이 변경",
    );
    if (method === "cancel")
      fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", { bubbles: true }),
      );
    else fireEvent.click(screen.getByRole("dialog"));
  }
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Codex 모델")).toHaveValue("fixture-model"),
  );
  fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      "assignments/a/edit",
      expect.objectContaining({
        revision: 1,
        name: "작성 중 이름",
        avatar: "headset",
      }),
    ),
  );
  await screen.findByText("버전 충돌");
  fireEvent.click(
    screen.getByRole("button", { name: "임시 입력 버리고 최신 설정 열기" }),
  );
  expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue("새 이름");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("메뉴 이동 뒤 초안을 복원하되 프로젝트·실행 환경과 구분하고 성공하면 비운다", async () => {
  const action = vi.fn().mockResolvedValue({});
  const props = {
    action,
    onChat: vi.fn(),
    onAdd: vi.fn(),
    projectId: "draft-navigation",
    environment: "local",
  };
  const first = render(<Staff data={initial} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
  await screen.findByRole("option", { name: /검사 모델/ });
  fireEvent.change(screen.getByRole("textbox", { name: "이름" }), {
    target: { value: "메뉴 이동 중 초안" },
  });
  fireEvent.change(screen.getByLabelText("Codex 모델"), {
    target: { value: "fixture-model" },
  });
  first.unmount();
  for (const scope of [
    { projectId: "another-project", environment: "local" },
    { projectId: props.projectId, environment: "remote" },
  ]) {
    const other = render(<Staff data={initial} {...props} {...scope} />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
    expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue(
      employee.name,
    );
    other.unmount();
  }
  render(<Staff data={initial} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
  expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue(
    "메뉴 이동 중 초안",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Codex 모델")).toHaveValue("fixture-model"),
  );
  fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
  expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue(
    employee.name,
  );
});

it("모델 설정 바로가기는 해당 직원의 프로젝트 설정을 직접 연다", async () => {
  const props = {
    action: vi.fn(),
    onChat: vi.fn(),
    onAdd: vi.fn(),
    projectId: "direct-model",
  };
  const second = {
    ...assignment,
    id: "b",
    settings: { ...assignment.settings, name: "다른 직원" },
  };
  render(
    <Staff
      {...props}
      data={{ ...initial, assignments: [assignment, second] }}
      editorRequest={{ assignmentId: "b", sequence: 1 }}
    />,
  );
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue(
    "다른 직원",
  );
});
