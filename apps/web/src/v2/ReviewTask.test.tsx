import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewTask } from "./ReviewTask";
import type { Task } from "./types";

const nativeShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeEach(() => {
  // jsdom에는 네이티브 대화상자 동작이 없다. 실제 모달 조작은 브라우저 검사에서 확인한다.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
afterEach(() => {
  cleanup();
  if (nativeShowModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      nativeShowModal,
    );
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
});
const task: Task = {
  id: "t",
  assignmentId: "a",
  title: "로그인 결과",
  status: "review",
  revision: 4,
  generation: 2,
  resultCommit: "abc123",
  verification: { status: "failed", checks: [] },
};

it("확인한 결과와 동의를 전송하고 저장 중 중복 완료를 막으며 실패를 통과로 표시하지 않는다", async () => {
  let resolve!: (value: unknown) => void;
  const action = vi.fn(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<ReviewTask task={task} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "검토 완료" }));
  expect(screen.getByText("별도 검증 · 실패")).toBeVisible();
  expect(screen.getByText(/완료는 검사 통과를 뜻하지 않습니다/)).toBeVisible();
  const submit = screen.getByRole("button", {
    name: "확인한 결과를 완료 처리",
  });
  expect(submit).toBeEnabled();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(submit);
  expect(action).toHaveBeenCalledExactlyOnceWith("tasks/t/accept", {
    revision: 4,
    confirm: true,
  });
  expect(screen.getByRole("button", { name: "완료 확인 중…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "돌아가기" })).toBeDisabled();
  resolve({});
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("새 결과를 자동 승인하지 않고 검토 화면의 버전을 유지하며 서버 충돌도 그대로 알린다", async () => {
  const action = vi
    .fn()
    .mockRejectedValue(new Error("검토 대상이 변경되었습니다."));
  const { rerender } = render(<ReviewTask task={task} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "검토 완료" }));
  rerender(
    <ReviewTask
      task={{ ...task, revision: 9, generation: 3 }}
      action={action}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("검토 대상이 변경");
  expect(screen.getByText("실행 2회차 · 변경 번호 4")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "확인한 결과를 완료 처리" }),
  ).toBeDisabled();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "돌아가기" }));
  fireEvent.click(screen.getByRole("button", { name: "검토 완료" }));
  expect(screen.getByText("실행 3회차 · 변경 번호 9")).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "확인한 결과를 완료 처리" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("검토 대상이 변경"),
  );
  expect(action).toHaveBeenCalledExactlyOnceWith("tasks/t/accept", {
    revision: 9,
    confirm: true,
  });
  expect(screen.getByRole("dialog")).toBeVisible();
});
