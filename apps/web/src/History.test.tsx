import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { SessionView } from "./History";
import { api } from "./api";

vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(cleanup);

function renderSession(userText = "Please fix the parser") {
  const items = [
    { id: 1, kind: "user.message", text: userText },
    {
      id: 2,
      kind: "assistant.reasoning_summary",
      text: "Inspect the boundary.",
    },
    { id: 3, kind: "assistant.message", text: "The parser is fixed." },
  ].map((event) => ({
    ...event,
    timestamp: "2026-01-01T10:00:00Z",
    target: null,
    detail_json: {},
  }));
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes("/events?")
      ? { items, total: items.length, offset: 0 }
      : { counts: [], repeated_commands: [] },
  );
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SessionView id="test-session" />
    </QueryClientProvider>,
  );
}

test("Conversation distinguishes user, assistant and reasoning bubbles in source order", async () => {
  renderSession();
  expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
  const messages = await screen.findAllByRole("article");
  expect(messages).toHaveLength(3);
  expect(messages[0]).toHaveClass("conversation-message", "conversation-user");
  expect(within(messages[0]).getByText("User")).toBeVisible();
  expect(messages[1]).toHaveClass(
    "conversation-assistant",
    "conversation-reasoning",
  );
  expect(
    within(messages[1]).getByText("Assistant · Reasoning Summary"),
  ).toBeVisible();
  expect(messages[2]).toHaveClass(
    "conversation-message",
    "conversation-assistant",
  );
  expect(within(messages[2]).getByText("Assistant")).toBeVisible();
});

test("Timeline keeps the original log layout and event labels", async () => {
  renderSession();
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  const messages = await screen.findAllByRole("article");
  for (const message of messages) {
    expect(message).toHaveClass("event");
    expect(message).not.toHaveClass("conversation-message");
  }
  expect(screen.getByText("user.message")).toBeVisible();
  expect(screen.getByText("assistant.message")).toBeVisible();
  expect(screen.getByText("Reasoning Summary")).toBeVisible();
});

test("long conversation messages retain their expandable full text", async () => {
  const fullText = "Long message\n".repeat(150) + "End of message";
  renderSession(fullText);
  fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
  const message = (await screen.findAllByRole("article"))[0];
  expect(message.querySelector(".event-text")?.textContent).toBe(
    fullText.slice(0, 1600) + "…",
  );
  fireEvent.click(within(message).getByText("Technical details / full output"));
  expect(message.querySelector("details")).toHaveAttribute("open");
  expect(message.querySelector("details pre")?.textContent).toBe(fullText);
});
