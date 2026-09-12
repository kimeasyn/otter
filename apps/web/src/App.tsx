import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useAuth } from "./api";
import { Sessions, SessionView, Search } from "./History";
import { NewWorkUnit, WorkUnits, WorkUnitView, type Unit } from "./WorkUnits";
import type { TerminalTarget } from "./Terminal";
import { RepositoryPicker } from "./RepositoryPicker";
import { RegisteredProjects, type Project } from "./RegisteredProjects";
import { useNavigation } from "./navigation";
import { TerminalDock, terminalKey, type TerminalTab } from "./TerminalDock";
import { CommitGraph } from "./CommitGraph";

export type Tree = {
  id: string;
  path: string;
  branch: string | null;
  head: string;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  base_branch?: string;
  base_commit?: string | null;
  missing: boolean;
  warning: string | null;
  agents: { name: string; provider: string; status: string }[];
  changed_files: string[];
  work_unit_id?: string | null;
};
type Detail = {
  project: Project;
  branches: string[];
  worktrees: Tree[];
  work_units: Unit[];
};

export function WorkspaceMap({
  trees,
  base,
  onSelect,
}: {
  trees: Tree[];
  base: string;
  onSelect: (tree: Tree) => void;
}) {
  return (
    <section className="panel workspace">
      <div className="section-title">
        <h2>Workspace Map</h2>
        <span className="muted">
          {trees.length} worktrees · base {base}
        </span>
      </div>
      <div className="tree-list">
        {trees.map((tree) => (
          <button
            className="tree-row"
            key={tree.id}
            onClick={() => onSelect(tree)}
          >
            <span className="branch">
              ⑂ {tree.branch ?? "Detached HEAD"}
              {tree.base_branch && tree.base_branch !== base && (
                <small className="muted"> → {tree.base_branch}</small>
              )}
              {tree.warning && (
                <span
                  className="warning"
                  title={tree.warning}
                  aria-label={tree.warning}
                >
                  {" "}
                  ⚠
                </span>
              )}
            </span>
            <span className={tree.behind ? "warning" : undefined}>
              ↑{tree.ahead ?? "?"} ↓{tree.behind ?? "?"}
            </span>
            <span
              className={tree.dirty || tree.missing ? "badge warning" : "badge"}
            >
              {tree.missing
                ? "Unavailable"
                : tree.dirty
                  ? "Uncommitted"
                  : "Clean"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const main = useRef<HTMLElement>(null);
  const { token, setToken } = useAuth();
  const [inputToken, setInputToken] = useState("");
  const { location, navigate } = useNavigation();
  const { project: selected, view, session, focus, unit } = location;
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [selected, view, session, unit]);
  const [path, setPath] = useState("");
  const [browseRepository, setBrowseRepository] = useState(false);
  const [selectedTree, setTree] = useState<Tree | null>(null);
  const [newWork, setNewWork] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminal, setActiveTerminal] = useState("");
  const setTerminal = (target: TerminalTarget) => {
    const id = terminalKey(target);
    setTerminalTabs((tabs) =>
      tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, target }],
    );
    setActiveTerminal(id);
  };
  const openUnit = (id: string) => {
    const project =
      allUnits.data?.find((u) => u.id === id)?.project_id ?? selected;
    navigate({ view: "unit", unit: id, project });
  };
  const openSession = (id: string, event?: string) => {
    navigate({ view: "session", session: id, focus: event });
  };
  const client = useQueryClient();
  const health = useQuery({
    queryKey: ["health", token],
    queryFn: () =>
      api<{ name: string; version: string; dev_no_auth?: boolean }>("/health"),
    retry: false,
    refetchInterval: 10000,
  });
  const projects = useQuery({
    queryKey: ["projects", token],
    queryFn: () => api<Project[]>("/projects"),
    enabled: health.isSuccess,
    refetchInterval: 10000,
  });
  const allUnits = useQuery({
    queryKey: ["work-units"],
    queryFn: () => api<Unit[]>("/work-units"),
    enabled: health.isSuccess,
    refetchInterval: 10000,
  });
  const detail = useQuery({
    queryKey: ["project", selected],
    queryFn: () => api<Detail>(`/projects/${selected}`),
    enabled: !!selected && health.isSuccess,
    refetchInterval: 10000,
  });
  const add = useMutation({
    mutationFn: () => api<Project>("/projects", { path }),
    onSuccess: (p) => {
      navigate({ view: "projects", project: p.id });
      setTree(null);
      setPath("");
      client.invalidateQueries({ queryKey: ["projects"] });
      client.invalidateQueries({ queryKey: ["project", p.id] });
    },
  });
  const tree =
    detail.data?.worktrees.find((t) => t.id === selectedTree?.id) ??
    selectedTree;
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const target = (
        {
          "1": "projects",
          "2": "units",
          "3": "sessions",
          "4": "search",
        } as Record<string, string>
      )[event.key];
      if (!target) return;
      event.preventDefault();
      navigate({
        view: target,
        ...(target === "projects" ? { project: "" } : {}),
      });
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [navigate]);
  if (!health.isSuccess)
    return (
      <main className="connect panel">
        <div className="wordmark">◉ Otter</div>
        <h1>Your development, connected.</h1>
        <p className="muted">
          Connect to your local Otter daemon using its current access token.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setToken(inputToken.trim());
          }}
        >
          <label>
            Access token
            <input
              type="password"
              value={inputToken}
              onChange={(e) => setInputToken(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
          <button className="primary">Connect to Otter</button>
        </form>
        {health.error && <p role="alert">{health.error.message}</p>}
        <p className="muted">
          The launcher provides an authenticated URL. All source code and
          session history stays on your machine.
        </p>
      </main>
    );
  return (
    <div className="app workbench">
      <header>
        <div className="wordmark">
          ◉ Otter <span className="badge">BETA</span>
        </div>
        <div className="workspace-location">
          <button
            onClick={() => history.back()}
            aria-label="Go back"
            title="Back to the previous screen"
          >
            ←
          </button>
          <span>
            {projects.data?.find((p) => p.id === selected)?.name ??
              "All projects"}
          </span>
          <span className="muted">
            /{" "}
            {view === "unit"
              ? "Work Unit"
              : view === "session"
                ? "Session"
                : view === "units"
                  ? "Work Units"
                  : view === "projects"
                    ? "Workspace"
                    : view === "sessions"
                      ? "Sessions"
                      : "Search"}
          </span>
        </div>
        <span className="connection">● Local daemon connected</span>
        {health.data.dev_no_auth && (
          <span
            className="badge warning"
            title="Local processes can access Otter. Do not expose this port."
          >
            Dev · no token
          </span>
        )}
      </header>
      <aside>
        <div className="eyebrow">WORKSPACE</div>
        <button
          className={`nav ${view === "projects" ? "active" : ""}`}
          onClick={() => {
            setTree(null);
            navigate({ view: "projects", project: "" });
          }}
        >
          ▦ Projects
        </button>
        <button
          className={`nav ${view === "units" || view === "unit" ? "active" : ""}`}
          onClick={() => navigate({ view: "units" })}
        >
          ▤ Work Units
        </button>
        <button
          className={`nav ${view === "sessions" || view === "session" ? "active" : ""}`}
          onClick={() => navigate({ view: "sessions" })}
        >
          ◷ Sessions
        </button>
        <button
          className={`nav ${view === "search" ? "active" : ""}`}
          onClick={() => navigate({ view: "search" })}
        >
          ⌕ Search
        </button>
        <div className="eyebrow">YOUR PROJECTS</div>
        {projects.data?.map((p) => (
          <button
            key={p.id}
            className={`nav ${p.id === selected && view === "projects" ? "active" : ""}`}
            onClick={() => {
              setTree(null);
              navigate({ view: "projects", project: p.id });
            }}
          >
            ⑂ {p.name}
          </button>
        ))}
        <button
          className="nav open-folder"
          onClick={() => {
            navigate({ view: "projects", project: "" });
            setBrowseRepository(true);
          }}
        >
          + Open folder…
        </button>
        {!!selected && (
          <>
            <div className="eyebrow">PROJECT WORK</div>
            {allUnits.data
              ?.filter((u) => u.project_id === selected)
              .slice(0, 8)
              .map((u) => (
                <button
                  key={u.id}
                  className={`nav task-shortcut ${view === "unit" && unit === u.id ? "active" : ""}`}
                  onClick={() => openUnit(u.id)}
                  title={`${u.title} · ${u.status}`}
                >
                  <span>{u.title}</span>
                  <small>{u.status}</small>
                </button>
              ))}
            <button className="nav" onClick={() => setNewWork(true)}>
              + New task
            </button>
          </>
        )}
        <div className="sidebar-footer">
          Otter {health.data.version}
          <br />
          Local-first · No telemetry
          <details>
            <summary>Keyboard shortcuts</summary>Alt+1 Projects
            <br />
            Alt+2 Work Units
            <br />
            Alt+3 Sessions
            <br />
            Alt+4 Search
          </details>
        </div>
      </aside>
      <main
        ref={main}
        className={view === "session" ? "session-workspace" : ""}
      >
        {(view === "unit" || view === "session") && (
          <nav className="context-toolbar" aria-label="Context navigation">
            {selected && (
              <button onClick={() => navigate({ view: "projects" })}>
                Project overview
              </button>
            )}
            {unit && view !== "unit" && (
              <button onClick={() => openUnit(unit)}>
                Return to last task
              </button>
            )}
            {view === "unit" && (
              <button onClick={() => navigate({ view: "units" })}>
                All Work Units
              </button>
            )}
            {view === "session" && (
              <button onClick={() => navigate({ view: "sessions" })}>
                All sessions
              </button>
            )}
          </nav>
        )}
        {view === "sessions" || view === "session" ? (
          <div className={view === "session" ? "session-split" : ""}>
            <div className="session-list-pane">
              <Sessions
                onOpen={openSession}
                compact={view === "session"}
                selected={view === "session" ? session : undefined}
              />
            </div>
            {view === "session" && (
              <div className="session-detail-pane">
                <SessionView
                  key={`${session}-${focus}`}
                  id={session}
                  focus={focus}
                  onWorkUnit={openUnit}
                />
              </div>
            )}
          </div>
        ) : view === "units" ? (
          <WorkUnits onOpen={openUnit} onNew={() => setNewWork(true)} />
        ) : view === "unit" ? (
          <WorkUnitView
            key={unit}
            id={unit}
            onSession={openSession}
            onTerminal={setTerminal}
          />
        ) : view === "search" ? (
          <Search onSession={openSession} onWorkUnit={openUnit} />
        ) : (
          <>
            <div className={`page-title ${selected ? "project-heading" : ""}`}>
              {!selected && (
                <div className="eyebrow">DEVELOPMENT WORKSPACE</div>
              )}
              <h1>{detail.data?.project.name ?? "Projects"}</h1>
              <p className="muted">
                {detail.data?.project.root_path ??
                  "Bring your repositories, worktrees, and AI-assisted work into one place."}
              </p>
              {!selected && (
                <button
                  className="primary"
                  onClick={() => setBrowseRepository(true)}
                >
                  Open folder…
                </button>
              )}
            </div>
            {(projects.error || detail.error) && (
              <p className="error" role="alert">
                {(projects.error || detail.error)?.message}
              </p>
            )}
            {!selected && (
              <RegisteredProjects
                projects={projects.data ?? []}
                loading={projects.isLoading}
                onOpen={(id) => {
                  navigate({ view: "projects", project: id });
                  setTree(null);
                  add.reset();
                }}
                onRemoved={(id) => {
                  setTree(null);
                  client.removeQueries({ queryKey: ["project", id] });
                  client.invalidateQueries({ queryKey: ["projects"] });
                  add.reset();
                }}
              />
            )}
            {!selected && (
              <section className="panel">
                <h2>Add a Git repository</h2>
                <p className="muted">
                  Choose a folder or enter an existing repository path on the
                  machine running Otter.
                </p>
                <form
                  className="inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    add.mutate();
                  }}
                >
                  <label className="grow">
                    Repository path
                    <input
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="/home/you/projects/my-app"
                      required
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setBrowseRepository(true)}
                  >
                    Browse folders…
                  </button>
                  <button className="primary" disabled={add.isPending}>
                    Add project
                  </button>
                </form>
                {add.error && (
                  <p className="error" role="alert">
                    {add.error.message}
                  </p>
                )}
                {browseRepository && (
                  <RepositoryPicker
                    initialPath={path}
                    onClose={() => setBrowseRepository(false)}
                    onSelect={(selectedPath) => {
                      setPath(selectedPath);
                      setBrowseRepository(false);
                      add.reset();
                    }}
                  />
                )}
              </section>
            )}
            {detail.data && (
              <>
                <div className="project-actions">
                  <button
                    onClick={() =>
                      setTerminal({
                        projectId: selected,
                        label: detail.data!.project.name,
                      })
                    }
                  >
                    Open project terminal
                  </button>
                  <button className="primary" onClick={() => setNewWork(true)}>
                    + New Work Unit
                  </button>
                </div>
                <div className="project-summary">
                  <section className="panel project-tasks">
                    <div className="section-title">
                      <h2>Project Work Units</h2>
                      <span className="muted">
                        {detail.data.work_units.length} tasks
                      </span>
                    </div>
                    <div className="project-task-list">
                      {detail.data.work_units.length ? (
                        detail.data.work_units.map((u) => (
                          <button
                            className="list-row"
                            key={u.id}
                            onClick={() => openUnit(u.id)}
                          >
                            <strong>{u.title}</strong>
                            <span className="badge">{u.status}</span>
                          </button>
                        ))
                      ) : (
                        <p className="muted">
                          No tasks yet. Create a Work Unit to get started.
                        </p>
                      )}
                    </div>
                  </section>
                  <WorkspaceMap
                    trees={detail.data.worktrees}
                    base={detail.data.project.base_branch}
                    onSelect={(next) =>
                      setTree(tree?.id === next.id ? null : next)
                    }
                  />
                </div>
                {tree && (
                  <section className="panel worktree-detail">
                    <div className="section-title">
                      <h2>{tree.branch ?? "Detached worktree"}</h2>
                      <button
                        onClick={() => setTree(null)}
                        aria-label="Close worktree details"
                      >
                        Close
                      </button>
                    </div>
                    <div className="worktree-quick-actions">
                      <button
                        onClick={() =>
                          setTerminal({
                            projectId: selected,
                            worktreeId: tree.id,
                            label: tree.branch ?? tree.path,
                          })
                        }
                      >
                        Open worktree terminal
                      </button>
                      {tree.work_unit_id && (
                        <button onClick={() => openUnit(tree.work_unit_id!)}>
                          Open Work Unit
                        </button>
                      )}
                      <code>{tree.path}</code>
                    </div>
                    {tree.warning && <p className="warning">{tree.warning}</p>}
                    <details>
                      <summary>
                        Changed files ({tree.changed_files.length}) & Git
                        details
                      </summary>
                      <p>
                        HEAD <code>{tree.head}</code> · Base{" "}
                        <code>
                          {tree.base_branch ?? detail.data.project.base_branch}
                        </code>{" "}
                        <code>{tree.base_commit ?? "Unknown"}</code>
                      </p>
                      {tree.agents.length > 0 && (
                        <p>
                          {tree.agents
                            .map((a) => `${a.name} · ${a.status}`)
                            .join(" / ")}
                        </p>
                      )}
                      {tree.changed_files.length ? (
                        tree.changed_files.map((f) => (
                          <div key={f}>
                            <code>{f}</code>
                          </div>
                        ))
                      ) : (
                        <p className="muted">
                          {tree.missing || tree.warning
                            ? "File activity unavailable or incomplete; inspect the warning above."
                            : "No changes relative to the base branch."}
                        </p>
                      )}
                    </details>
                  </section>
                )}
                <CommitGraph key={selected} project={selected} />
              </>
            )}
          </>
        )}
      </main>
      <TerminalDock
        tabs={terminalTabs}
        active={activeTerminal}
        onActive={setActiveTerminal}
        onClose={(id) => {
          setTerminalTabs((tabs) => tabs.filter((t) => t.id !== id));
          if (activeTerminal === id)
            setActiveTerminal(terminalTabs.find((t) => t.id !== id)?.id ?? "");
        }}
      />
      {newWork && (
        <NewWorkUnit
          projects={projects.data ?? []}
          initialProject={selected}
          onClose={() => setNewWork(false)}
          onCreated={(id) => {
            setNewWork(false);
            client.invalidateQueries({ queryKey: ["work-units"] });
            client.invalidateQueries({ queryKey: ["project"] });
            openUnit(id);
          }}
        />
      )}
    </div>
  );
}
