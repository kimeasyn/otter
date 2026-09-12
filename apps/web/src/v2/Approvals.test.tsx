import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";
import type { Approval } from "./types";

afterEach(cleanup);

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
