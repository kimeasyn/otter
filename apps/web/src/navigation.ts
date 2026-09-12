import { useEffect, useState } from "react";

export type Location = {
  view: string;
  project: string;
  unit: string;
  session: string;
  focus?: string;
};
const home: Location = { view: "projects", project: "", unit: "", session: "" };
const views = ["projects", "units", "unit", "sessions", "session", "search"];
export function readLocation(value: unknown): Location {
  if (!value || typeof value !== "object") return home;
  const candidate = value as Partial<Location>;
  if (!views.includes(candidate.view ?? "")) return home;
  return {
    view: candidate.view!,
    project: typeof candidate.project === "string" ? candidate.project : "",
    unit: typeof candidate.unit === "string" ? candidate.unit : "",
    session: typeof candidate.session === "string" ? candidate.session : "",
    focus: typeof candidate.focus === "string" ? candidate.focus : undefined,
  };
}
export function useNavigation() {
  const [location, setLocation] = useState<Location>(() => {
    try {
      return readLocation(
        history.state?.otter ??
          JSON.parse(sessionStorage.getItem("otter-location") || "null"),
      );
    } catch {
      return home;
    }
  });
  useEffect(() => {
    history.replaceState({ ...history.state, otter: location }, "");
    sessionStorage.setItem("otter-location", JSON.stringify(location));
  }, [location]);
  useEffect(() => {
    const restore = (event: PopStateEvent) =>
      setLocation(readLocation(event.state?.otter));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const navigate = (patch: Partial<Location>) => {
    const next = { ...location, focus: undefined, ...patch };
    if (JSON.stringify(next) === JSON.stringify(location)) return;
    history.pushState({ otter: next }, "");
    setLocation(next);
  };
  return { location, navigate };
}
