import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useAuth } from "./api";
import { Sessions, SessionView, Search } from "./History";

type Project = {
  id: string;
  name: string;
  root_path: string;
  base_branch: string;
};
export type Tree = {
  id: string;
  path: string;
  branch: string | null;
  head: string;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  missing: boolean;
  warning: string | null;
  agents: { name: string; provider: string; status: string }[];
  changed_files: string[];
};
type Detail = {
  project: Project;
  branches: string[];
  worktrees: Tree[];
  work_units: unknown[];
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
        <span className="muted">Live Git observations</span>
      </div>
      <div className="base-line">
        <span className="dot" />
        {base}
        <span className="line" />
      </div>
      <div className="tree-list">
        {trees.map((tree) => (
          <button
            className="tree-row"
            key={tree.id}
            onClick={() => onSelect(tree)}
          >
            <span className="branch">⑂ {tree.branch ?? "Detached HEAD"}</span>
            <code>{tree.head.slice(0, 8)}</code>
            <span>
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
            <span className="muted">
              {tree.agents
                .map((a) => `${a.name} · ${a.provider} · ${a.status}`)
                .join(", ") || "No assigned agent"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const { token, setToken } = useAuth();
  const [inputToken, setInputToken] = useState("");
  const [selected, setSelected] = useState("");
  const [path, setPath] = useState("");
  const [tree, setTree] = useState<Tree | null>(null);
  const [view, setView] = useState("projects");
  const [session, setSession] = useState("");
  const [focus, setFocus] = useState<string | undefined>();
  const openSession = (id: string, event?: string) => {
    setSession(id);
    setFocus(event);
    setView("session");
  };
  const client = useQueryClient();
  const health = useQuery({
    queryKey: ["health", token],
    queryFn: () => api<{ name: string; version: string }>("/health"),
    enabled: !!token,
  });
  const projects = useQuery({
    queryKey: ["projects", token],
    queryFn: () => api<Project[]>("/projects"),
    enabled: health.isSuccess,
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
      setSelected(p.id);
      setPath("");
      client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
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
    <div className="app">
      <header>
        <div className="wordmark">
          ◉ Otter <span className="badge">BETA</span>
        </div>
        <span className="muted">AI Development Control Center</span>
        <span className="connection">● Local daemon connected</span>
      </header>
      <aside>
        <div className="eyebrow">WORKSPACE</div>
        <button
          className={`nav ${view === "projects" ? "active" : ""}`}
          onClick={() => {
            setSelected("");
            setTree(null);
            setView("projects");
          }}
        >
          ▦ Projects
        </button>
        <button
          className={`nav ${view === "sessions" || view === "session" ? "active" : ""}`}
          onClick={() => setView("sessions")}
        >
          ◷ Sessions
        </button>
        <button
          className={`nav ${view === "search" ? "active" : ""}`}
          onClick={() => setView("search")}
        >
          ⌕ Search
        </button>
        <div className="eyebrow">YOUR PROJECTS</div>
        {projects.data?.map((p) => (
          <button
            key={p.id}
            className={`nav ${p.id === selected && view === "projects" ? "active" : ""}`}
            onClick={() => {
              setSelected(p.id);
              setTree(null);
              setView("projects");
            }}
          >
            ⑂ {p.name}
          </button>
        ))}
        <div className="sidebar-footer">
          Otter {health.data.version}
          <br />
          Local-first · No telemetry
        </div>
      </aside>
      <main>
        {view === "sessions" ? (
          <Sessions onOpen={openSession} />
        ) : view === "session" ? (
          <SessionView key={`${session}-${focus}`} id={session} focus={focus} />
        ) : view === "search" ? (
          <Search
            onSession={openSession}
            onWorkUnit={() => setView("projects")}
          />
        ) : (
          <>
            <div className="page-title">
              <div className="eyebrow">DEVELOPMENT WORKSPACE</div>
              <h1>{detail.data?.project.name ?? "Projects"}</h1>
              <p className="muted">
                {detail.data?.project.root_path ??
                  "Bring your repositories, worktrees, and AI-assisted work into one place."}
              </p>
            </div>
            {(projects.error || detail.error) && (
              <p className="error" role="alert">
                {(projects.error || detail.error)?.message}
              </p>
            )}
            {!selected && (
              <section className="panel">
                <h2>Add a Git repository</h2>
                <p className="muted">
                  Enter an existing repository path on the machine running
                  otterd.
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
                  <button className="primary" disabled={add.isPending}>
                    Add project
                  </button>
                </form>
                {add.error && (
                  <p className="error" role="alert">
                    {add.error.message}
                  </p>
                )}
              </section>
            )}
            {detail.data && (
              <>
                <WorkspaceMap
                  trees={detail.data.worktrees}
                  base={detail.data.project.base_branch}
                  onSelect={setTree}
                />
                {tree && (
                  <section className="panel">
                    <h2>{tree.branch ?? "Detached worktree"}</h2>
                    <code>{tree.path}</code>
                    <p>
                      HEAD <code>{tree.head}</code>
                    </p>
                    {tree.warning && <p className="warning">{tree.warning}</p>}
                    <h3>Changed files</h3>
                    {tree.changed_files.length ? (
                      tree.changed_files.map((f) => (
                        <div key={f}>
                          <code>{f}</code>
                        </div>
                      ))
                    ) : (
                      <p className="muted">
                        No changes relative to the base branch.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
