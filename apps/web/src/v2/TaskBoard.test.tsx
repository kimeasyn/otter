import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskBoard } from "./App";
import type { Assignment, Project, Task, Approval } from "./types";

afterEach(cleanup);
const team = [
  {
    id: "a",
    settings: { name: "김코딩", role: "개발" },
    appearance: { color: "#6675cf", avatar: "default" },
  },
] as Assignment[];
const project: Project = {
  id: "p",
  name: "프로젝트",
  companyId: "c",
  root: "/fixture",
  environment: "local",
  archived: false,
  revision: 1,
};
const tasks: Task[] = [
  "queued",
  "running",
  "waiting",
  "review",
  "failed",
  "interrupted",
  "completed",
  "handoff",
  "future-state",
  "blocked",
].map((status, index) => ({
  id: `t${index}`,
  title: `업무 ${index}`,
  assignmentId: status === "future-state" ? "missing-owner" : "a",
  status,
  revision: 1,
}));
tasks.push({
  id: "unconfirmed",
  title: "종료 미확인 결과",
  assignmentId: "a",
  status: "completed",
  executionUnconfirmed: true,
});
tasks.push({
  id: "pending",
  title: "권한 승인 대기",
  assignmentId: "a",
  status: "running",
});
const approvals = [
  { id: "approval", taskId: "pending", status: "pending" },
] as Approval[];
const action = vi.fn(),
  onOpen = vi.fn();
function Board({
  members = team,
  entries = tasks,
  stale = false,
}: {
  members?: Assignment[];
  entries?: Task[];
  stale?: boolean;
}) {
  const [filters, onFilters] = useState({ search: "", owner: "", status: "" });
  return (
    <TaskBoard
      tasks={entries}
      team={members}
      project={project}
      approvals={approvals}
      action={action}
      onOpen={onOpen}
      filters={filters}
      onFilters={onFilters}
      stale={stale}
    />
  );
}

it("실패·중단·미확인 상태와 승인 대기를 확인할 업무로 모으며 어떤 업무도 누락하지 않는다", () => {
  const before = structuredClone(tasks);
  render(<Board stale />);
  expect(screen.getAllByRole("article")).toHaveLength(12);
  const attention = within(screen.getByRole("region", { name: "확인할 업무" }));
  expect(attention.getAllByRole("article")).toHaveLength(8);
  for (const title of [
    "업무 4",
    "업무 5",
    "업무 8",
    "종료 미확인 결과",
    "권한 승인 대기",
  ])
    expect(attention.getByRole("heading", { name: title })).toBeVisible();
  expect(attention.getByText("상태 미확인")).toBeVisible();
  expect(attention.getByText("이전 실행 종료 확인 필요")).toBeVisible();
  const unknown = attention
    .getByRole("heading", { name: "업무 8" })
    .closest("article")!;
  expect(
    within(unknown).getByRole("button", { name: "대화 열기 →" }),
  ).toBeDisabled();
  expect(
    within(screen.getByRole("region", { name: "완료·인계" })).getAllByRole(
      "article",
    ),
  ).toHaveLength(2);
  expect(screen.getByText(/마지막으로 확인한 업무/)).toBeVisible();
  expect(tasks).toEqual(before);
  expect(action).not.toHaveBeenCalled();
});

it("검색·담당·상태를 조합하고 빈 결과와 필터 초기화를 안내하며 사라진 담당 필터도 숨기지 않는다", () => {
  const { rerender } = render(<Board />);
  fireEvent.change(screen.getByRole("searchbox", { name: "업무 검색" }), {
    target: { value: " 김코딩 " },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "담당 직원" }), {
    target: { value: "a" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "업무 상태" }), {
    target: { value: "interrupted" },
  });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "대화 열기 →" }));
  expect(onOpen).toHaveBeenLastCalledWith(tasks[5]);
  fireEvent.change(screen.getByRole("searchbox", { name: "업무 검색" }), {
    target: { value: "없는 내용" },
  });
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.getByText(/조건에 맞는 업무가 없습니다/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "확인할 업무 8개" }));
  expect(screen.getAllByRole("article")).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
  expect(screen.getAllByRole("article")).toHaveLength(12);
  fireEvent.change(screen.getByRole("combobox", { name: "담당 직원" }), {
    target: { value: "a" },
  });
  rerender(<Board members={[]} />);
  expect(screen.getByRole("combobox", { name: "담당 직원" })).toHaveValue("a");
  expect(
    screen.getByRole("option", { name: "이전에 선택한 직원 · 현재 미확인" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
  rerender(<Board entries={[]} />);
  expect(screen.getByText(/사무실에서 직원을 선택해 일을 맡겨/)).toBeVisible();
  expect(action).not.toHaveBeenCalled();
});
