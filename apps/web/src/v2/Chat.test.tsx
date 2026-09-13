import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chat } from "./App";
import type { Assignment, Snapshot } from "./types";

const scroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() =>
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  }),
);
afterEach(() => {
  cleanup();
  if (scroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const team: Assignment[] = ["김설계", "김코딩"].map((name, index) => ({
  id: `a${index}`,
  employeeId: `e${index}`,
  employeeRevision: 1,
  revision: 1,
  appearance: { color: "#6675cf", avatar: "default" },
  settings: {
    id: `e${index}`,
    name,
    role: "개발",
    model: "",
    skills: "",
    instructions: "검사",
    revision: 1,
    appearance: { color: "#6675cf", avatar: "default" },
  },
}));
it("reports conversation selection for restoration and supports the shared expanded view control", () => {
  const onSelectionChange = vi.fn();
  const onExpandedChange = vi.fn();
  render(
    <Chat
      member={team[0]}
      data={snapshot()}
      action={vi.fn()}
      projectId="p"
      busy={false}
      initialTaskId="private"
      onReports={vi.fn()}
      onTask={vi.fn()}
      expanded
      onExpandedChange={onExpandedChange}
      onSelectionChange={onSelectionChange}
    />,
  );
  expect(onSelectionChange).toHaveBeenLastCalledWith({
    taskId: "private",
    channel: "direct",
  });
  fireEvent.change(screen.getByRole("combobox", { name: "업무 대화 선택" }), {
    target: { value: "" },
  });
  expect(onSelectionChange).toHaveBeenLastCalledWith({
    taskId: "",
    channel: "direct",
  });
  fireEvent.click(screen.getByRole("button", { name: "사무실 함께 보기" }));
  expect(onExpandedChange).toHaveBeenCalledWith(false);
});
function snapshot(): Snapshot {
  return {
    companies: [],
    employees: [],
    assignments: team,
    settings: { concurrency: 2, retries: 2 },
    projects: [
      {
        id: "p",
        revision: 1,
        name: "프로젝트",
        root: "/fixture",
        companyId: "c",
        environment: "local",
        archived: false,
      },
    ],
    tasks: [
      {
        id: "shared",
        assignmentId: "a1",
        title: "단체방 업무",
        status: "review",
        channel: "project",
      },
      {
        id: "private",
        assignmentId: "a1",
        title: "개인 업무",
        status: "review",
        channel: "direct",
      },
    ],
    messages: [
      {
        id: "m1",
        taskId: "shared",
        assignmentId: "a1",
        sender: "user",
        channel: "project",
        text: "프로젝트 요청 본문",
        createdAt: "2026-09-11T00:00:00Z",
      },
      {
        id: "m2",
        taskId: "private",
        assignmentId: "a1",
        sender: "user",
        channel: "direct",
        text: "개인 대화 본문",
        createdAt: "2026-09-11T00:00:00Z",
      },
    ],
  };
}
it("새 업무 진입과 넓은 대화 보기는 실행 없이 전환하며 기존 업무 초안은 보존한다", () => {
  const action = vi.fn();
  render(
    <Chat
      member={team[1]}
      data={snapshot()}
      action={action}
      projectId="p"
      busy={false}
      initialTaskId="private"
      onReports={vi.fn()}
      onTask={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "직원에게 업무 요청" });
  fireEvent.change(input, { target: { value: "이전 업무 초안" } });
  fireEvent.click(screen.getByRole("button", { name: "＋ 새 업무 요청" }));
  expect(screen.getByLabelText("업무 대화 선택")).toHaveValue("");
  expect(input).toHaveValue("");
  fireEvent.change(screen.getByLabelText("업무 대화 선택"), {
    target: { value: "private" },
  });
  expect(input).toHaveValue("이전 업무 초안");
  fireEvent.click(screen.getByRole("button", { name: "대화 크게 보기" }));
  expect(screen.getByRole("complementary", { name: "팀 대화" })).toHaveClass(
    "expanded",
  );
  fireEvent.click(screen.getByRole("button", { name: "사무실 함께 보기" }));
  expect(
    screen.getByRole("complementary", { name: "팀 대화" }),
  ).not.toHaveClass("expanded");
  expect(action).not.toHaveBeenCalled();
});

it("Enter는 기존 전송 흐름을 사용하고 줄바꿈·한글 조합·반복 키·전송 불가 상태는 보내지 않는다", async () => {
  const data = snapshot();
  const action = vi.fn().mockResolvedValue({ id: "private" });
  const props = {
    member: team[1],
    data,
    action,
    projectId: "p",
    busy: false,
    initialTaskId: "private",
    initialChannel: "direct" as const,
    onReports: vi.fn(),
    onTask: vi.fn(),
  };
  const { rerender } = render(<Chat {...props} />);
  const input = screen.getByRole("textbox", { name: "직원에게 업무 요청" });
  fireEvent.change(input, { target: { value: "한글 입력" } });
  for (const options of [
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ])
    fireEvent.keyDown(input, { key: "Enter", ...options });
  expect(action).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  rerender(<Chat {...props} busy />);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).not.toHaveBeenCalled();
  rerender(<Chat {...props} />);
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "한글 입력\n다음 줄" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).toHaveBeenCalledExactlyOnceWith(
    "tasks/private/continue",
    expect.objectContaining({
      prompt: "한글 입력\n다음 줄",
      assignmentId: "a1",
      channel: "direct",
    }),
  );
  await waitFor(() => expect(input).toHaveValue(""));
  rerender(
    <Chat
      {...props}
      data={{
        ...data,
        tasks: data.tasks!.map((task) => ({ ...task, status: "waiting" })),
      }}
    />,
  );
  fireEvent.change(input, { target: { value: "승인 대기 중 입력" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).toHaveBeenCalledTimes(1);
});

it("진행 업무 추가 지시는 같은 실행 ID로 보내고 전달 미확인·승인 대기는 새 업무로 우회하지 않는다", async () => {
  const data = snapshot();
  data.tasks![0] = {
    ...data.tasks![0],
    status: "running",
    generation: 3,
    providerTurnId: "turn-3",
  };
  const action = vi
    .fn()
    .mockResolvedValue({ id: "message-id", delivery: "delivered" });
  const props = {
    member: team[0],
    data,
    action,
    projectId: "p",
    busy: false,
    initialTaskId: "shared",
    initialChannel: "project" as const,
    onReports: vi.fn(),
    onTask: vi.fn(),
  };
  const { rerender } = render(<Chat {...props} />);
  const input = screen.getByRole("textbox", { name: "직원에게 업무 요청" });
  fireEvent.change(input, { target: { value: "테스트부터 해줘" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).toHaveBeenCalledExactlyOnceWith(
    "tasks/shared/steer",
    expect.objectContaining({
      assignmentId: "a1",
      projectId: "p",
      generation: 3,
      turnId: "turn-3",
      prompt: "테스트부터 해줘",
      channel: "project",
    }),
  );
  await waitFor(() => expect(input).toHaveValue(""));
  expect(screen.getByRole("combobox", { name: "업무 대화 선택" })).toHaveValue(
    "shared",
  );
  const uncertain = {
    ...data,
    messages: [
      ...data.messages!,
      {
        id: "unknown",
        taskId: "shared",
        assignmentId: "a1",
        sender: "user",
        text: "미확인 추가 지시",
        channel: "project",
        kind: "steering",
        generation: 3,
        delivery: "unconfirmed",
        createdAt: "2026-09-11T00:00:00Z",
      },
    ],
  };
  rerender(<Chat {...props} data={uncertain} />);
  fireEvent.change(input, { target: { value: "다시 보내지 않음" } });
  expect(
    screen.getByRole("button", { name: "업무 요청 보내기" }),
  ).toBeDisabled();
  expect(
    screen.getByText(/전달 여부 미확인 · 자동 재전송 안 함/),
  ).toBeVisible();
  rerender(
    <Chat
      {...props}
      data={{ ...data, tasks: [{ ...data.tasks![0], status: "waiting" }] }}
    />,
  );
  expect(
    screen.getByRole("button", { name: "업무 요청 보내기" }),
  ).toBeDisabled();
  expect(action).toHaveBeenCalledTimes(1);
});

it("중단 업무는 체크박스 없이 표시된 최신 버전으로 재개하고 종료 미확인 실행은 막는다", async () => {
  const data = snapshot();
  data.tasks![0] = {
    ...data.tasks![0],
    status: "interrupted",
    interruptionConfirmed: true,
    revision: 7,
    generation: 1,
  };
  const action = vi.fn().mockResolvedValue({});
  const props = {
    member: team[1],
    data,
    action,
    projectId: "p",
    busy: false,
    initialTaskId: "shared",
    initialChannel: "project" as const,
    onReports: vi.fn(),
    onTask: vi.fn(),
  };
  const { rerender } = render(<Chat {...props} />);
  const input = screen.getByRole("textbox", { name: "직원에게 업무 요청" });
  fireEvent.change(input, { target: { value: "남은 작업 확인 후 재개" } });
  const send = screen.getByRole("button", {
    name: "이어서 진행",
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(action).not.toHaveBeenCalled();
  expect(send).toBeEnabled();
  const changed = {
    ...data,
    tasks: [{ ...data.tasks![0], revision: 8 }, data.tasks![1]],
  };
  rerender(<Chat {...props} data={changed} />);
  expect(send).toBeEnabled();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(send);
  expect(action).toHaveBeenCalledExactlyOnceWith("tasks/shared/continue", {
    projectId: "p",
    assignmentId: "a1",
    prompt: "남은 작업 확인 후 재개",
    mode: "direct",
    channel: "project",
    confirmResume: true,
    revision: 8,
  });
  await waitFor(() => expect(input).toHaveValue(""));
  rerender(
    <Chat
      {...props}
      data={{
        ...changed,
        tasks: [{ ...changed.tasks[0], interruptionConfirmed: false }],
      }}
    />,
  );
  expect(input).toBeDisabled();
  expect(screen.getByText(/종료 확인 기록이 없어/)).toBeVisible();
});

it("단체방의 업무 담당자를 표시하고 같은 업무·대화방에 이어 보내며 다른 채널을 섞지 않는다", async () => {
  const action = vi.fn().mockResolvedValue({});
  render(
    <Chat
      member={team[0]}
      data={snapshot()}
      action={action}
      projectId="p"
      busy={false}
      initialTaskId="shared"
      initialChannel="project"
      onReports={vi.fn()}
      onTask={vi.fn()}
    />,
  );
  expect(screen.getByRole("heading", { name: "김코딩" })).toBeVisible();
  expect(screen.getByText("프로젝트 요청 본문")).toBeVisible();
  expect(screen.queryByText("개인 대화 본문")).not.toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "선택한 업무 상태" }),
  ).toHaveTextContent("검토 요청");
  const input = screen.getByRole("textbox", { name: "직원에게 업무 요청" });
  fireEvent.change(input, { target: { value: "단체방 후속 요청" } });
  fireEvent.click(screen.getByRole("button", { name: "업무 요청 보내기" }));
  expect(action).toHaveBeenCalledExactlyOnceWith("tasks/shared/continue", {
    projectId: "p",
    assignmentId: "a1",
    prompt: "단체방 후속 요청",
    mode: "direct",
    channel: "project",
  });
  await waitFor(() => expect(input).toHaveValue(""));
});

it("다른 대화방 업무는 원래 대화로 안내하고 담당자 유실·직원 간 보기에서 잘못 전송하지 않는다", () => {
  const action = vi.fn(),
    onTask = vi.fn(),
    data = snapshot();
  const props = {
    member: team[0],
    data,
    action,
    projectId: "p",
    busy: false,
    initialTaskId: "private",
    initialChannel: "project" as const,
    onReports: vi.fn(),
    onTask,
  };
  const { rerender } = render(<Chat {...props} />);
  expect(
    screen.getByRole("textbox", { name: "직원에게 업무 요청" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "원래 업무 대화 열기 →" }),
  );
  expect(onTask).toHaveBeenCalledExactlyOnceWith(data.tasks![1]);
  expect(action).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "업무 대화 선택" }), {
    target: { value: "shared" },
  });
  expect(
    screen.getByRole("textbox", { name: "직원에게 업무 요청" }),
  ).toBeEnabled();
  rerender(<Chat {...props} data={{ ...data, assignments: [team[0]] }} />);
  expect(
    screen.getByRole("textbox", { name: "직원에게 업무 요청" }),
  ).toBeDisabled();
  expect(screen.getByText("담당 직원을 확인할 수 없습니다")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "직원 간" }));
  expect(screen.getByRole("heading", { name: "직원 간 대화" })).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "직원에게 업무 요청" }),
  ).not.toBeInTheDocument();
  expect(action).not.toHaveBeenCalled();
});
