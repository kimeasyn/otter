import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";
import type { Approval } from "./types";

afterEach(cleanup);

it("요청 목적은 제공된 이유만 보여주고 연결 업무를 구분하며 누락된 설명은 추측하지 않는다", () => {
  const action = vi.fn();
  const { rerender } = render(
    <Approvals
      items={[approval]}
      action={action}
      tasks={[
        {
          id: "task",
          title: "로그인 구현",
          assignmentId: "worker",
          status: "waiting",
        },
      ]}
    />,
  );
  expect(screen.getByText("대상 업무: 로그인 구현")).toBeVisible();
  expect(screen.getByText(approval.params.reason!)).toBeVisible();
  rerender(
    <Approvals
      items={[{ ...approval, params: { command: "git status", reason: " " } }]}
      action={action}
    />,
  );
  expect(screen.getByText(/목적 설명이 제공되지 않았습니다/)).toBeVisible();
  expect(screen.getByText("git status")).toBeVisible();
  expect(action).not.toHaveBeenCalled();
});

it("파일 변경은 목록부터 보여주며 펼쳐도 승인하지 않고 전체 내용을 보존한다", () => {
  const action = vi.fn();
  const diff = "변경 내용\n".repeat(500);
  render(
    <Approvals
      items={[
        {
          id: "files",
          taskId: "task",
          status: "pending",
          method: "item/fileChange/requestApproval",
          params: {
            changes: [{ path: "/work/index.html", diff, kind: "add" }],
          },
        },
      ]}
      action={action}
    />,
  );
  expect(screen.getByText(/파일 변경 1개/)).toBeVisible();
  const details = screen.getByText("/work/index.html").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(details.querySelector("pre")?.textContent).toBe(diff);
  fireEvent.click(screen.getByText("/work/index.html"));
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "이번 요청 승인" })).toBeEnabled();
});

const approval: Approval = {
  id: "permission",
  taskId: "task",
  status: "pending",
  method: "item/permissions/requestApproval",
  params: { reason: "검증 파일과 네트워크가 필요합니다.", cwd: "/tmp/project" },
  review: {
    title: "이번 턴의 추가 접근 권한",
    details: [
      "읽기: /tmp/fixture",
      "네트워크 접근 허용 (특정 호스트로 제한되지 않음)",
    ],
    warning: "현재 턴의 후속 작업에도 적용됩니다.",
    canAccept: true,
    decisions: ["accept", "decline", "cancel"],
    acknowledgement: true,
  },
};

it("권한 범위와 기간을 보여주고 체크박스 없이 명시적 승인 클릭에서만 전송한다", () => {
  const action = vi.fn().mockResolvedValue({});
  render(<Approvals items={[approval]} action={action} />);
  expect(
    screen.getByRole("region", { name: "승인할 접근 범위" }),
  ).toHaveTextContent("읽기: /tmp/fixture");
  expect(screen.getByText("현재 턴의 후속 작업에도 적용됩니다.")).toBeVisible();
  expect(action).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "이번 턴에만 권한 허용" }),
  );
  expect(action).toHaveBeenLastCalledWith("approvals/permission/resolve", {
    decision: "accept",
    scopeConfirmed: true,
  });
  expect(
    screen.getByRole("button", { name: "이번 턴에만 권한 허용" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "이번 턴에만 권한 허용" }),
  );
  expect(action).toHaveBeenCalledTimes(1);
});

it("해석 불가·영구 승인만 제공된 요청은 승인할 수 없고 제공된 중단 선택만 보낸다", () => {
  const action = vi.fn().mockResolvedValue({});
  render(
    <Approvals
      items={[
        {
          ...approval,
          review: {
            ...approval.review!,
            canAccept: false,
            decisions: ["cancel"],
            blockedReason: "범위를 확인할 수 없습니다.",
          },
        },
      ]}
      action={action}
    />,
  );
  expect(
    screen.getByRole("button", { name: "이번 턴에만 권한 허용" }),
  ).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "범위를 확인할 수 없습니다.",
  );
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "거절" }));
  expect(action).toHaveBeenLastCalledWith("approvals/permission/resolve", {
    decision: "cancel",
  });
});
