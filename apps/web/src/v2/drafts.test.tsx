import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  draftKey,
  finishDraft,
  getDraft,
  setDraft,
  useDrafts,
  useDraftStorageError,
} from "./drafts";

it("초안은 화면 수명과 분리되고 대상별로 격리되며 늦은 응답이 새 편집을 지우지 않는다", () => {
  const a = draftKey("document", "local", "a");
  const b = draftKey("document", "remote", "a");
  function Editor({ id }: { id: string }) {
    const draft = useDrafts()[id];
    return (
      <input
        aria-label="초안"
        value={draft?.text || ""}
        onChange={(e) => setDraft(id, { text: e.target.value, revision: 1 })}
      />
    );
  }
  const first = render(<Editor id={a} />);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "저장할 내용" },
  });
  const submitted = getDraft(a)!;
  first.rerender(<Editor id={b} />);
  expect(screen.getByRole("textbox")).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "원격 초안" },
  });
  first.unmount();
  const restored = render(<Editor id={a} />);
  expect(screen.getByRole("textbox")).toHaveValue("저장할 내용");
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "응답 전에 더 쓴 내용" },
  });
  act(() => finishDraft(a, submitted, 2));
  expect(getDraft(a)).toMatchObject({
    text: "응답 전에 더 쓴 내용",
    revision: 2,
  });
  // 더 최신 문서로 사용자가 재조정했으면 오래된 응답으로 기준 버전을 돌리지 않는다.
  act(() => setDraft(a, { text: "직접 충돌 해결", revision: 4 }));
  act(() => finishDraft(a, submitted, 2));
  expect(getDraft(a)?.revision).toBe(4);
  act(() => finishDraft(a, getDraft(a)!, 5));
  expect(getDraft(a)).toBeUndefined();
  expect(getDraft(b)?.text).toBe("원격 초안");
  expect(sessionStorage.getItem("otter.v2.drafts.1")).not.toContain(
    "직접 충돌 해결",
  );
  act(() => setDraft(b, null));
  expect(sessionStorage.getItem("otter.v2.drafts.1")).toBeNull();
  restored.unmount();

  const chat = draftKey(
    "chat",
    "local",
    "p",
    "staff",
    "development",
    "direct",
    "task",
  );
  setDraft(chat, { text: "보낼 메시지", mode: "delegate" });
  const sending = getDraft(chat)!;
  setDraft(chat, { text: "다음 메시지", mode: "direct" });
  finishDraft(chat, sending);
  expect(getDraft(chat)).toMatchObject({ text: "다음 메시지", mode: "direct" });
  finishDraft(chat, getDraft(chat)!);
  expect(getDraft(chat)).toBeUndefined();
});

it("탭 저장소 실패를 알리고 메모리 초안을 유지하며 새로고침 전에 경고한다", () => {
  function Warning() {
    return <p role="alert">{useDraftStorageError()}</p>;
  }
  const view = render(<Warning />);
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  const key = draftKey("document", "local", "quota");
  try {
    act(() => setDraft(key, { text: "유지할 내용", revision: 1 }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "새로고침·종료 전에 내용을 복사",
    );
    expect(getDraft(key)?.text).toBe("유지할 내용");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  } finally {
    write.mockRestore();
    act(() => setDraft(key, null));
    view.unmount();
  }
});
