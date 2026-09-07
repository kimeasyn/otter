import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { test, expect, vi } from "vitest";
import { NewWorkUnit, WorkUnits, branchSlug } from "./WorkUnits";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
const providers = [
  {
    id: "fake",
    name: "FakeProvider",
    available: true,
    synthetic: true,
    capabilities: { model_selection: false },
  },
  {
    id: "claude",
    name: "Claude Code",
    available: false,
    synthetic: false,
    capabilities: { model_selection: false },
  },
];
const project = {
  id: "p",
  name: "Repo",
  root_path: "/repo",
  base_branch: "main",
};
function wrapper(children: React.ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}
test("wizard generates branch and truthfully disables unavailable providers/models", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/providers"
      ? providers
      : path === "/profiles"
        ? []
        : { branches: ["main"], worktrees: [] },
  );
  render(
    wrapper(
      <NewWorkUnit
        projects={[project]}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    ),
  );
  fireEvent.change(screen.getByLabelText("Task title"), {
    target: { value: "Fix parser!" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByLabelText("Feature branch")).toHaveValue(
    "otter/fix-parser",
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const selectors = await screen.findAllByLabelText("Provider");
  expect(
    await within(selectors[0]).findByRole("option", {
      name: "Claude Code · Not installed",
    }),
  ).toBeDisabled();
  expect(screen.getAllByLabelText("Model")[0]).toBeDisabled();
  expect(branchSlug("한글 작업")).toBe("otter/task");
});
test("Work Units navigate using persisted identifiers", async () => {
  vi.mocked(api).mockResolvedValue([
    {
      id: "persisted-unit",
      title: "Fix recovery",
      project_name: "Repo",
      branch: "otter/recovery",
      status: "review",
    },
  ]);
  const open = vi.fn();
  render(wrapper(<WorkUnits onOpen={open} onNew={() => {}} />));
  fireEvent.click(await screen.findByRole("button", { name: /Fix recovery/ }));
  expect(open).toHaveBeenCalledWith("persisted-unit");
});
