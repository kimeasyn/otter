import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Reports } from "./Reports";
import type { Assignment, Snapshot } from "./types";

afterEach(cleanup);

it("검토 대기 결과 보고에서만 기존 검토 동작을 제공한다", () => {
  const action = vi.fn();
  render(
    <Reports
      data={{
        ...data,
        tasks: data.tasks!.map((task) => ({ ...task, revision: 2 })),
      }}
      action={action}
      onTask={() => {}}
    />,
  );
  expect(screen.getAllByRole("button", { name: "검토 완료" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "검토 완료" })).toBeEnabled();
  expect(action).not.toHaveBeenCalled();
});
const data: Snapshot = {
  companies: [],
  projects: [],
  employees: [],
  settings: { concurrency: 2, retries: 2 },
  assignments: [
    { id: "a", settings: { name: "김코딩" } } as Assignment,
    { id: "b", settings: { name: "박리뷰" } } as Assignment,
  ],
  tasks: [
    { id: "t1", assignmentId: "a", title: "로그인", status: "review" },
    { id: "t2", assignmentId: "b", title: "검색", status: "completed" },
  ],
  reports: [
    {
      id: "r1",
      taskId: "t1",
      title: "예전 연결 실패",
      text: "연결을 확인하지 못했습니다",
      kind: "blocker",
      verification: "pending",
      createdAt: "2026-09-11T10:00:00Z",
    },
    {
      id: "r2",
      taskId: "t2",
      title: "검색 구현 결과",
      text: "미검증인 항목이 있습니다",
      kind: "result",
      verification: "pending",
    },
    {
      id: "r3",
      taskId: "t1",
      title: "로그인 검토 요청",
      text: "직원 보고 본문",
      kind: "result",
      verification: "failed",
      verificationResult: { status: "failed", checks: [] },
    },
    {
      id: "r4",
      title: "운영 명령 종료",
      text: "서비스 상태는 확인 필요",
      kind: "deployment",
      verification: "pending",
    },
  ],
};

it("업무·종류·검색을 함께 적용하고 과거 보고와 현재 상태·별도 검증을 구분한다", () => {
  const action = vi.fn(),
    open = vi.fn();
  render(
    <Reports data={data} initialTaskId="t1" action={action} onTask={open} />,
  );
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual(["로그인 검토 요청", "예전 연결 실패"]);
  expect(
    screen.getByText(/최근 확인한 업무: 로그인 · 검토 요청/),
  ).toBeVisible();
  expect(screen.getByText("별도 검증 · 실패")).toBeVisible();
  expect(
    screen.getAllByText("작성 당시 기록 · 현재 업무: 검토 요청"),
  ).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("보고 종류"), {
    target: { value: "blocker" },
  });
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("보고 검색"), {
    target: { value: "없는 내용" },
  });
  expect(screen.getByText(/선택한 조건에 맞는 보고가 없습니다/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "전체 보고 보기" }));
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4);
  expect(
    screen.getByText("명령 종료와 외부 서비스의 배포 성공은 별개입니다."),
  ).toBeVisible();
  fireEvent.change(screen.getByLabelText("보고 검색"), {
    target: { value: "박리뷰" },
  });
  expect(screen.getByRole("heading", { name: "검색 구현 결과" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "업무 대화 열기 →" }));
  expect(open).toHaveBeenCalledWith(data.tasks![1]);
  expect(action).not.toHaveBeenCalled();
});

it("보고가 없어도 선택 범위의 대기 질문을 유지하며 다른 업무의 승인을 섞지 않는다", () => {
  const action = vi.fn();
  render(
    <Reports
      data={{
        ...data,
        reports: [],
        approvals: [
          {
            id: "q1",
            taskId: "t1",
            status: "pending",
            method: "input",
            params: { reason: "로그인 질문" },
          },
          {
            id: "q2",
            taskId: "t2",
            status: "pending",
            method: "input",
            params: { reason: "검색 질문" },
          },
        ],
      }}
      initialTaskId="t1"
      action={action}
      onTask={() => {}}
    />,
  );
  expect(screen.getByText("로그인 질문")).toBeVisible();
  expect(screen.queryByText("검색 질문")).not.toBeInTheDocument();
  expect(screen.getByText(/아직 보고가 없습니다/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("보고 검색"), {
    target: { value: "아무것도 없음" },
  });
  expect(screen.getByText("로그인 질문")).toBeVisible();
  expect(action).not.toHaveBeenCalled();
});
