import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readLocation, useNavigation } from "./navigation";
beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "");
});
afterEach(cleanup);
test("invalid persisted locations fall back to Projects", () => {
  expect(readLocation({ view: "missing" }).view).toBe("projects");
  expect(readLocation({ view: "projects", project: 123 }).project).toBe("");
});
test("navigation restores on remount and browser back restores context", () => {
  const first = renderHook(useNavigation);
  act(() => first.result.current.navigate({ view: "projects", project: "p" }));
  const previous = history.state;
  act(() => first.result.current.navigate({ view: "unit", unit: "u" }));
  first.unmount();
  const restored = renderHook(useNavigation);
  expect(restored.result.current.location).toMatchObject({
    view: "unit",
    project: "p",
    unit: "u",
  });
  act(() =>
    window.dispatchEvent(new PopStateEvent("popstate", { state: previous })),
  );
  expect(restored.result.current.location).toMatchObject({
    view: "projects",
    project: "p",
    unit: "",
  });
});
