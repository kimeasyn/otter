import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppV2 } from "./App";

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            projects: [
              {
                id: "p",
                name: "검사 프로젝트",
                root: "/fixture",
                revision: 1,
                companyId: "c",
              },
            ],
            companies: [],
            assignments: [],
            tasks: [],
            employees: [],
            documents: [],
            reports: [],
            approvals: [],
            messages: [],
            environments: [],
            settings: { concurrency: 2, retries: 2 },
          }),
        ),
    ),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppV2 />
    </QueryClientProvider>,
  );
}

it("restores the selected project and menu on reload and exposes workspace/project actions", async () => {
  sessionStorage.setItem(
    "otter:v2:navigation",
    JSON.stringify({ projectId: "p", page: "staff", selected: "", taskId: "" }),
  );
  const view = mount();
  await screen.findByRole("heading", { name: "직원" });
  expect(screen.getByRole("combobox", { name: "프로젝트 선택" })).toHaveValue(
    "p",
  );
  const menu = screen.getByRole("button", { name: "작업공간 메뉴" });
  expect(menu).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(menu);
  expect(menu).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByText("프로젝트 작업").closest("details"),
  ).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: /문서·지침/ }));
  await waitFor(() =>
    expect(
      JSON.parse(sessionStorage.getItem("otter:v2:navigation")!).page,
    ).toBe("documents"),
  );
  view.unmount();
  mount();
  await screen.findByRole("heading", { name: "문서·지침" });
});

it("replaces a stale project reference without getting stuck on an empty workspace", async () => {
  sessionStorage.setItem(
    "otter:v2:navigation",
    JSON.stringify({ projectId: "removed", page: "staff" }),
  );
  mount();
  await screen.findByRole("heading", { name: "직원" });
  expect(screen.getByRole("combobox", { name: "프로젝트 선택" })).toHaveValue(
    "p",
  );
});
