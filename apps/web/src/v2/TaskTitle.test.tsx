import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskTitle } from "./TaskTitle";
const task = {
  id: "t",
  title: "모델 수정했으니 계속 진행해줘",
  revision: 3,
  status: "review",
  assignmentId: "a",
};
afterEach(cleanup);
it("제목만 저장하고 저장 실패 시 입력을 보존한다", async () => {
  const action = vi.fn().mockRejectedValue(new Error("버전 충돌"));
  render(<TaskTitle task={task} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "제목 변경" }));
  fireEvent.change(screen.getByLabelText("업무 제목"), {
    target: { value: "랜딩페이지 제작" },
  });
  fireEvent.click(screen.getByRole("button", { name: "제목 저장" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("버전 충돌"),
  );
  expect(screen.getByLabelText("업무 제목")).toHaveValue("랜딩페이지 제작");
  expect(action).toHaveBeenCalledExactlyOnceWith("tasks/t/edit", {
    title: "랜딩페이지 제작",
    revision: 3,
  });
});
