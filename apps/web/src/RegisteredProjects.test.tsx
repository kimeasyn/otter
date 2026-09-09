import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { RegisteredProjects } from "./RegisteredProjects";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function setup() {
  const onOpen = vi.fn();
  const onRemoved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <RegisteredProjects
        projects={[{ id: "p", name: "Otter", root_path: "/repo/otter", base_branch: "main" }]}
        loading={false}
        onOpen={onOpen}
        onRemoved={onRemoved}
      />
    </QueryClientProvider>,
  );
  return { onOpen, onRemoved };
}

test("lists registered projects and opens them without registering again", () => {
  const { onOpen } = setup();
  expect(screen.getByText("Registered projects (1)")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Otter at /repo/otter" }));
  expect(onOpen).toHaveBeenCalledWith("p");
  expect(api).not.toHaveBeenCalled();
});

test("removal requires confirmation and cancel does not call the API", async () => {
  vi.mocked(api).mockResolvedValue({ removed: true });
  const { onRemoved } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Remove Otter from Otter" }));
  expect(screen.getByText(/Only the registration is removed/)).toBeVisible();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove Otter from Otter" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove registration" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Files and history were kept");
  expect(api).toHaveBeenCalledExactlyOnceWith("/projects/p", undefined, "DELETE");
  expect(onRemoved).toHaveBeenCalledWith("p");
});

test("failed removal keeps the project and allows retry", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Connection lost"));
  const { onRemoved } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Remove Otter from Otter" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove registration" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
  expect(screen.getByRole("button", { name: "Open Otter at /repo/otter" })).toBeVisible();
  expect(onRemoved).not.toHaveBeenCalled();
});
