import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Office } from "./Office";
import type { Assignment, Task } from "./types";

afterEach(cleanup);

describe("직원 외형과 실제 업무 상태", () => {
  it("직원 클릭은 배정 ID를 전달하며 색상 변경은 업무 ID에 영향을 주지 않는다", () => {
    const member = {
      id: "assignment-a",
      settings: { name: "김코딩", role: "백엔드" },
      appearance: { color: "#6675cf", avatar: "default" },
    } as Assignment;
    const select = vi.fn();
    const { rerender } = render(
      <Office team={[member]} tasks={[]} selected="" onSelect={select} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "김코딩, 업무 없음, 대화 열기" }),
    );
    expect(select).toHaveBeenLastCalledWith("assignment-a");
    rerender(
      <Office
        team={[
          { ...member, appearance: { ...member.appearance, color: "#34805c" } },
        ]}
        tasks={[
          {
            id: "task-a",
            assignmentId: member.id,
            title: "함수 구현",
            status: "waiting",
          },
        ]}
        selected={member.id}
        onSelect={select}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "김코딩, 답변 필요, 대화 열기" }),
    );
    expect(select).toHaveBeenLastCalledWith("assignment-a");
    expect(screen.getByText("확인이 필요해요!")).toBeVisible();
  });
});

it("말풍선은 대기 중인 승인의 정확한 업무로 연결하고 직원 대화와 분리한다", () => {
  const member = {
    id: "a",
    settings: { name: "김코딩", role: "개발" },
    appearance: { color: "#6675cf" },
  } as Assignment;
  const tasks: Task[] = [
    { id: "old", assignmentId: "a", title: "검토할 설계", status: "review" },
    {
      id: "new",
      assignmentId: "a",
      title: "진행 중인 개발",
      status: "running",
    },
    {
      id: "other",
      assignmentId: "outside",
      title: "다른 팀 업무",
      status: "waiting",
    },
  ];
  const select = vi.fn(),
    open = vi.fn();
  render(
    <Office
      team={[member]}
      tasks={tasks}
      selected="a"
      onSelect={select}
      onTask={open}
      approvals={[
        {
          id: "approval",
          taskId: "old",
          status: "pending",
          method: "otter/document",
          params: {},
        },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: /김코딩 · 확인이 필요해요! · 검토할 설계, 업무 대화 열기/,
    }),
  );
  expect(open).toHaveBeenLastCalledWith(tasks[0]);
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByText("진행·대기 2개")).toBeVisible();
  expect(screen.getByText(/확인할 업무 1개/)).toBeVisible();
  expect(screen.queryByText("다른 팀 업무")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "김코딩, 검토 요청, 대화 열기" }),
  );
  expect(select).toHaveBeenLastCalledWith("a");
  expect(tasks.map((t) => t.id)).toEqual(["old", "new", "other"]);
});

it("최근 실패·중단·완료를 업무 없음으로 숨기지 않고 현재 실행과 과거 결과를 구분한다", () => {
  const member = {
    id: "a",
    settings: { name: "김코딩", role: "개발" },
    appearance: {},
  } as Assignment;
  const renderOffice = (tasks: Task[], stale = false) => (
    <Office
      team={[member]}
      tasks={tasks}
      selected=""
      onSelect={() => {}}
      stale={stale}
    />
  );
  const task = {
    id: "task",
    title: "로그인 개발",
    assignmentId: "a",
    status: "failed",
  };
  const { rerender } = render(renderOffice([task]));
  for (const [status, label] of [
    ["failed", "실패"],
    ["interrupted", "중단됨"],
    ["completed", "완료"],
  ]) {
    rerender(renderOffice([{ ...task, status }]));
    expect(
      screen.getByRole("button", { name: `김코딩, ${label}, 대화 열기` }),
    ).toBeVisible();
    expect(screen.getAllByText(`최근 업무 · ${label}`)).toHaveLength(2);
  }
  rerender(
    renderOffice([task, { ...task, id: "running", status: "running" }], true),
  );
  expect(
    screen.getByRole("button", { name: "김코딩, 작업 중, 대화 열기" }),
  ).toBeVisible();
  expect(screen.getByText("마지막 확인 상태 · 연결 필요")).toBeVisible();
});
