import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecordBackup } from "./RecordBackup";

const original = window.otter;
afterEach(() => {
  cleanup();
  window.otter = original;
});

it("설치형 연결이 없으면 범위·비암호화·복원 제한을 안내하고 저장 버튼을 제공하지 않는다", () => {
  delete window.otter;
  render(<RecordBackup />);
  expect(
    screen.getByText("로컬 기록 백업").closest("details"),
  ).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("로컬 기록 백업"));
  expect(
    screen.getByText(/선택한 원격 프로젝트의 전체 백업이 아닙니다/),
  ).toBeVisible();
  expect(screen.getByText(/암호화되지 않으므로/)).toBeVisible();
  expect(screen.getByText(/자동 복원과 업무 재개는/)).toBeVisible();
  expect(screen.getByText(/브라우저 개발 화면에서는/)).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("저장 중 중복 요청을 막고 성공·취소·실패 결과를 구분한다", async () => {
  type Result = {
    saved: boolean;
    path: string;
    bytes: number;
    sha256: string;
  };
  let resolve!: (result: Result) => void;
  const pending = new Promise<Result>((done) => {
    resolve = done;
  });
  const backupRecords = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({ saved: false })
    .mockRejectedValueOnce(
      new Error("같은 위치에 파일이 있어 저장하지 않았습니다."),
    );
  window.otter = {
    pickFolder: async () => null,
    pickCodex: async () => null,
    openEditor: async () => ({ launched: false }),
    backupRecords,
  };
  render(<RecordBackup />);
  fireEvent.click(screen.getByText("로컬 기록 백업"));
  const submit = () =>
    screen.getByRole("button", { name: "범위 확인 후 파일로 저장…" });
  fireEvent.click(submit());
  const saving = screen.getByRole("button", {
    name: "기록 사본 저장·검증 중…",
  });
  expect(saving).toBeDisabled();
  fireEvent.click(saving);
  expect(backupRecords).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  resolve({
    saved: true,
    path: "/private/records.sqlite",
    bytes: 1024,
    sha256: "a".repeat(64),
  });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("저장·검증 완료"),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "/private/records.sqlite",
  );
  expect(screen.getByRole("status")).toHaveTextContent("a".repeat(64));
  fireEvent.click(submit());
  await waitFor(() => expect(submit()).toBeEnabled());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(submit());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("파일이 있어"),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
