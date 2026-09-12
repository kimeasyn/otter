import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommitGraph, layoutCommits, type Commit } from "./CommitGraph";
vi.mock("./api", () => ({ api: vi.fn() }));
import { api } from "./api";
afterEach(cleanup);
const commit = (hash: string, parents: string[]): Commit => ({
  hash,
  parents,
  refs: "",
  subject: hash,
  author: "Test",
  date: "2026-09-09T00:00:00Z",
});
test("merge lanes reconnect to shared ancestors without negative edges", () => {
  const rows = layoutCommits([
    commit("merge", ["main", "feature"]),
    commit("feature", ["root"]),
    commit("main", ["root"]),
    commit("root", []),
  ]);
  expect(rows[0].edges.map((e) => e.to)).toEqual([0, 1]);
  expect(rows[1].column).toBe(1);
  expect(rows[2].edges.filter((e) => e.node)).toEqual([
    { from: 0, to: 0, node: true },
  ]);
  expect(rows[3].column).toBe(0);
  expect(rows[3].edges).toEqual([]);
  expect(rows.every((row) => row.edges.every((e) => e.to >= 0))).toBe(true);
});
test("handles independent roots and octopus merges", () => {
  const rows = layoutCommits([
    commit("a", ["b", "c", "d"]),
    commit("other", []),
    commit("b", []),
    commit("c", []),
    commit("d", []),
  ]);
  expect(rows[0].edges).toHaveLength(3);
  expect(rows[1].incoming).toBe(false);
  expect(rows[1].column).toBe(3);
  expect(rows.at(-1)?.column).toBe(0);
  expect(layoutCommits([])).toEqual([]);
});
test("commit rows disclose metadata and request more bounded history", async () => {
  vi.mocked(api).mockResolvedValue({
    items: [
      {
        ...commit("abc123456", []),
        subject: "파서 수정",
        refs: "HEAD -> main",
      },
    ],
    has_more: true,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CommitGraph project="p" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /파서 수정/ }));
  expect(screen.getByText("abc123456")).toBeInTheDocument();
  expect(screen.getByText("Parents: Root commit")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show 100 commits" }));
  await screen.findByRole("button", { name: "Show 150 commits" });
  expect(api).toHaveBeenCalledWith("/projects/p/commits?limit=100");
});
