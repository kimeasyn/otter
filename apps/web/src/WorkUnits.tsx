import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Provider } from "./History";
import type { Tree } from "./App";
import type { TerminalTarget } from "./Terminal";

export type Project = {
  id: string;
  name: string;
  root_path: string;
  base_branch: string;
};
export type Unit = {
  id: string;
  project_id: string;
  project_name?: string;
  title: string;
  description: string;
  status: string;
  base_branch: string;
  base_commit: string;
  branch: string;
  worktree_path: string;
  environment_json: unknown;
  created_at: string;
};
type Profile = {
  id?: string;
  name: string;
  provider: string;
  model: string | null;
  role: string;
  instructions: string;
};
type Agent = Profile & {
  id: string;
  status: string;
  provider_session_id: string | null;
  permissions: string;
  result: string | null;
  error: string | null;
};
type Detail = {
  work_unit: Unit;
  agents: Agent[];
  git: Tree | null;
  git_error: string | null;
  merge: {
    readiness: string;
    test: { status: string; scope: string; command?: string };
    review: { status: string; synthetic: boolean };
    overlaps: { branch: string; files: string[]; label: string }[];
    note: string;
  };
  artifacts: { id: string; kind: string; body: string; session_id: string }[];
  handoffs: { id: string; payload_json: unknown; created_at: string }[];
  timeline: {
    id: number;
    kind: string;
    text: string;
    created_at: string;
    detail_json: unknown;
  }[];
  sessions: { id: string; title: string; provider: string; status: string }[];
  commits: { hash: string; subject: string; provenance: string }[];
};
export function branchSlug(title: string) {
  return `otter/${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "task"
  }`;
}
const defaultTeam = (): Profile[] =>
  ["planner", "builder", "reviewer"].map((role) => ({
    name: role[0].toUpperCase() + role.slice(1),
    provider: "fake",
    model: "deterministic",
    role,
    instructions:
      role === "builder"
        ? "Implement the task, run relevant tests, and report results."
        : "Inspect the repository and report your findings. Do not modify files.",
  }));

function ProfileFields({
  profile,
  onChange,
  providers,
  profiles,
}: {
  profile: Profile;
  onChange: (p: Profile) => void;
  providers: Provider[];
  profiles: Profile[];
}) {
  const provider = providers.find((p) => p.id === profile.provider);
  return (
    <div className="profile-fields">
      <label>
        Use a saved profile
        <select
          value=""
          onChange={(e) => {
            const p = profiles.find((p) => p.id === e.target.value);
            if (p) onChange({ ...p, name: profile.name });
          }}
        >
          <option value="">Choose a template…</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.provider} · {p.role}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label>
          Agent name
          <input
            required
            value={profile.name}
            onChange={(e) => onChange({ ...profile, name: e.target.value })}
          />
        </label>
        <label>
          Role
          <select
            value={profile.role}
            onChange={(e) => onChange({ ...profile, role: e.target.value })}
          >
            {["planner", "builder", "reviewer"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            value={profile.provider}
            onChange={(e) =>
              onChange({
                ...profile,
                provider: e.target.value,
                model: e.target.value === "fake" ? "deterministic" : null,
              })
            }
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.name}
                {!p.available ? " · Not installed" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input
            value={profile.model ?? ""}
            disabled={!provider?.capabilities.model_selection}
            placeholder="Provider default"
            onChange={(e) =>
              onChange({ ...profile, model: e.target.value || null })
            }
          />
        </label>
      </div>
      <p className="muted">
        {provider?.synthetic
          ? "Synthetic provider: no actual file changes or paid requests."
          : provider?.capabilities.permission_enforcement
            ? `Provider-native ${profile.role === "builder" ? "workspace-write" : "read-only"} sandbox requested.`
            : "Advisory role policy. No OS sandbox enforcement is claimed."}{" "}
        {provider?.capabilities.model_selection &&
          "Enter a model supported by your provider account, or leave blank for its default."}
      </p>
      {provider && !provider.capabilities.one_shot && (
        <p className="warning">{provider.note}</p>
      )}
      <label>
        Instructions
        <textarea
          rows={3}
          value={profile.instructions}
          onChange={(e) =>
            onChange({ ...profile, instructions: e.target.value })
          }
        />
      </label>
    </div>
  );
}

export function NewWorkUnit({
  projects,
  initialProject,
  onClose,
  onCreated,
}: {
  projects: Project[];
  initialProject?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [projectId, setProjectId] = useState(
    initialProject || projects[0]?.id || "",
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [createTree, setCreateTree] = useState(true);
  const [team, setTeam] = useState(defaultTeam);
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<Provider[]>("/providers"),
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<Profile[]>("/profiles"),
  });
  const project = projects.find((p) => p.id === projectId);
  const git = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      api<{ branches: string[]; worktrees: Tree[] }>(`/projects/${projectId}`),
    enabled: !!projectId,
  });
  const suggested = branchSlug(title);
  const actualBranch = branch || suggested;
  const actualPath =
    path ||
    `${project?.root_path}/../otter-worktrees/${actualBranch.replaceAll("/", "-")}`;
  const mutation = useMutation({
    mutationFn: () =>
      api<Unit>("/work-units", {
        project_id: projectId,
        title,
        description,
        base_branch: base || project?.base_branch,
        branch: actualBranch,
        worktree_path: actualPath,
        create_worktree: createTree,
        team,
      }),
    onSuccess: (r) => onCreated(r.id),
  });
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-work-title"
      >
        <div className="section-title">
          <h2 id="new-work-title">New Work Unit</h2>
          <button aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="wizard-steps">
          {["1 · Task", "2 · Git workspace", "3 · Agent Team"].map((s, i) => (
            <span className={i === step ? "current" : ""} key={s}>
              {s}
            </span>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (step < 2) setStep(step + 1);
            else mutation.mutate();
          }}
        >
          {step === 0 && (
            <div className="form-stack">
              <label>
                Project
                <select
                  required
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setBase("");
                    setPath("");
                  }}
                >
                  <option value="" disabled>
                    Select a project
                  </option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task title
                <input
                  autoFocus
                  required
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What needs to be done?"
                />
              </label>
              <label>
                Description
                <textarea
                  rows={5}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Requirements, constraints, and expected outcome"
                />
              </label>
            </div>
          )}
          {step === 1 && (
            <div className="form-stack">
              <label>
                Base branch
                <select
                  value={base || project?.base_branch}
                  onChange={(e) => setBase(e.target.value)}
                >
                  {git.data?.branches.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={createTree}
                  onChange={(e) => {
                    setCreateTree(e.target.checked);
                    setPath("");
                    setBranch("");
                  }}
                />
                Create a new branch and worktree
              </label>
              {createTree ? (
                <>
                  <label>
                    Feature branch
                    <input
                      required
                      value={actualBranch}
                      onChange={(e) => setBranch(e.target.value)}
                    />
                  </label>
                  <label>
                    Worktree path
                    <input
                      required
                      value={actualPath}
                      onChange={(e) => setPath(e.target.value)}
                    />
                  </label>
                  <p className="muted">
                    Creates an isolated working directory. Your current checkout
                    stays available.
                  </p>
                </>
              ) : (
                <label>
                  Existing worktree
                  <select
                    required
                    value={path}
                    onChange={(e) => {
                      const t = git.data?.worktrees.find(
                        (t) => t.path === e.target.value,
                      );
                      setPath(e.target.value);
                      setBranch(t?.branch ?? "");
                    }}
                  >
                    <option value="">Select an existing worktree</option>
                    {git.data?.worktrees
                      .filter((t) => t.branch && !t.missing)
                      .map((t) => (
                        <option key={t.id} value={t.path}>
                          {t.branch} · {t.path}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {git.error && <p role="alert">{git.error.message}</p>}
            </div>
          )}
          {step === 2 && (
            <div className="form-stack">
              <p className="muted">
                Each agent gets its own saved profile and session history.
                FakeProvider is selected initially so you can test the full
                workflow without using paid tokens.
              </p>
              {team.map((p, index) => (
                <details key={index} open>
                  <summary>
                    {p.name} · {p.provider}
                  </summary>
                  <ProfileFields
                    profile={p}
                    onChange={(p) =>
                      setTeam(team.map((old, i) => (i === index ? p : old)))
                    }
                    providers={providers.data ?? []}
                    profiles={profiles.data ?? []}
                  />
                </details>
              ))}
            </div>
          )}
          {mutation.error && <p role="alert">{mutation.error.message}</p>}
          <div className="modal-actions">
            <button
              type="button"
              onClick={() => (step ? setStep(step - 1) : onClose())}
            >
              {step ? "Back" : "Cancel"}
            </button>
            <button
              className="primary"
              disabled={mutation.isPending || !projectId}
            >
              {step < 2
                ? "Continue"
                : mutation.isPending
                  ? "Creating…"
                  : "Create Work Unit"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function WorkUnits({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const units = useQuery({
    queryKey: ["work-units"],
    queryFn: () => api<Unit[]>("/work-units"),
    refetchInterval: 10000,
  });
  return (
    <>
      <div className="section-title page-title">
        <div>
          <div className="eyebrow">TASKS ACROSS YOUR REPOSITORIES</div>
          <h1>Work Units</h1>
        </div>
        <button className="primary" onClick={onNew}>
          + New Work Unit
        </button>
      </div>
      <section className="panel">
        {units.error && <p role="alert">{units.error.message}</p>}
        {!units.data?.length && (
          <div className="empty">
            <h2>Make the next task a Work Unit.</h2>
            <p>
              Keep its branch, agents, sessions, handoffs and review in one
              place.
            </p>
          </div>
        )}
        {units.data?.map((u) => (
          <button className="list-row" key={u.id} onClick={() => onOpen(u.id)}>
            <span>
              <strong>{u.title}</strong>
              <small>
                {u.project_name} · {u.branch}
              </small>
            </span>
            <span className="badge">{u.status}</span>
          </button>
        ))}
      </section>
    </>
  );
}

export function WorkUnitView({
  id,
  onSession,
  onTerminal,
}: {
  id: string;
  onSession: (id: string) => void;
  onTerminal: (target: TerminalTarget) => void;
}) {
  const client = useQueryClient();
  const [message, setMessage] = useState(
    () => sessionStorage.getItem(`otter-draft:${id}`) ?? "",
  );
  const [sent, setSent] = useState(false);
  const [recipient, setRecipient] = useState(
    () => sessionStorage.getItem(`otter-recipient:${id}`) ?? "",
  );
  const [section, setSection] = useState("Work");
  const [editing, setEditing] = useState<Profile | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["work-unit", id],
    queryFn: () => api<Detail>(`/work-units/${id}`),
    refetchInterval: 1500,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<Provider[]>("/providers"),
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<Profile[]>("/profiles"),
  });
  const refresh = () => {
    client.invalidateQueries({ queryKey: ["work-unit", id] });
    client.invalidateQueries({ queryKey: ["work-units"] });
    client.invalidateQueries({ queryKey: ["project"] });
    client.invalidateQueries({ queryKey: ["profiles"] });
  };
  const action = useMutation({
    mutationFn: ({
      path,
      body = {},
      method,
    }: {
      path: string;
      body?: unknown;
      method?: string;
    }) => api(path, body, method),
    onSuccess: (_, request) => {
      refresh();
      if (request.path.endsWith("/message")) {
        setMessage("");
        setSent(true);
      }
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api(
        editId ? `/agents/${editId}` : `/work-units/${id}/agents`,
        editing,
        editId ? "PUT" : "POST",
      ),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const d = detail.data;
  const u = d?.work_unit;
  const running = d?.agents.some((a) => a.status === "running");
  const next = ["planner", "builder", "reviewer"].find(
    (role) =>
      d?.agents.some((a) => a.role === role) &&
      !d?.agents.some((a) => a.role === role && a.status === "completed"),
  );
  useEffect(() => {
    if (message) sessionStorage.setItem(`otter-draft:${id}`, message);
    else sessionStorage.removeItem(`otter-draft:${id}`);
  }, [id, message]);
  useEffect(() => {
    if (recipient) sessionStorage.setItem(`otter-recipient:${id}`, recipient);
    else sessionStorage.removeItem(`otter-recipient:${id}`);
  }, [id, recipient]);
  if (!u || !d)
    return (
      <p role={detail.error ? "alert" : undefined}>
        {detail.error?.message ?? "Loading Work Unit…"}
      </p>
    );
  const selectedRecipient =
    recipient ||
    d.agents.find((a) => a.role === "builder")?.name ||
    d.agents[0]?.name ||
    "";
  const recipientMissing =
    !!selectedRecipient && !d.agents.some((a) => a.name === selectedRecipient);
  const states: Record<string, string[]> = {
    draft: ["active", "archived"],
    active: ["waiting", "review", "failed"],
    waiting: ["active", "review", "failed", "archived"],
    review: ["active", "completed", "failed"],
    completed: ["active", "archived"],
    failed: ["active", "archived"],
    archived: ["draft"],
  };
  return (
    <>
      <div className="page-title work-unit-heading">
        <div className="eyebrow">WORK UNIT · {u.status}</div>
        <h1>{u.title}</h1>
        <button
          onClick={() =>
            onTerminal({
              projectId: u.project_id,
              workUnitId: id,
              label: u.branch,
            })
          }
        >
          Open worktree terminal
        </button>
        <p className="task-description">{u.description}</p>
        <div className="chips">
          <code>
            {u.branch} → {u.base_branch}
          </code>
          <span className="muted">{u.worktree_path}</span>
        </div>
      </div>
      {action.error && <p role="alert">{action.error.message}</p>}
      <div className="tabs" role="tablist" aria-label="Work Unit sections">
        {["Work", "History", "Review"].map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={section === name}
            className={section === name ? "selected" : ""}
            onClick={() => setSection(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="unit-columns">
        <div className="unit-primary">
          <section className="panel workflow-panel" hidden={section !== "Work"}>
            <div className="section-title">
              <h2>Planner → Builder → Reviewer</h2>
              <button
                className="primary"
                disabled={
                  running ||
                  action.isPending ||
                  !next ||
                  u.status === "archived"
                }
                onClick={() =>
                  action.mutate({ path: `/work-units/${id}/next` })
                }
              >
                {running
                  ? "Agent running…"
                  : next
                    ? `Start ${next[0].toUpperCase() + next.slice(1)}`
                    : "Workflow complete"}
              </button>
            </div>
            <p className="muted">
              Continue each stage after inspecting the previous result. Otter
              includes the task, plan, Git summary and prior result in a
              persisted handoff.
            </p>
            {d.artifacts.map((a) => (
              <details className="artifact" key={a.id}>
                <summary>{a.kind} result</summary>
                <pre>{a.body}</pre>
                <button onClick={() => onSession(a.session_id)}>
                  Open source session
                </button>
              </details>
            ))}
            {d.handoffs.map((h) => (
              <details key={h.id}>
                <summary>
                  Structured handoff · {new Date(h.created_at).toLocaleString()}
                </summary>
                <pre>{JSON.stringify(h.payload_json, null, 2)}</pre>
              </details>
            ))}
          </section>
          <section className="panel composer-panel" hidden={section !== "Work"}>
            <h2>Address an agent</h2>
            {sent && (
              <p role="status">
                Request sent. The agent response is available in its Session.
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.mutate({
                  path: `/work-units/${id}/message`,
                  body: {
                    message: message.trimStart().startsWith("@")
                      ? message
                      : `@${selectedRecipient} ${message}`,
                  },
                });
              }}
            >
              <label htmlFor={`recipient-${id}`}>Message recipient</label>
              <select
                id={`recipient-${id}`}
                value={selectedRecipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                {recipientMissing && (
                  <option value={selectedRecipient} disabled>
                    {selectedRecipient} · unavailable — choose an agent
                  </option>
                )}
                {d.agents.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name} · {a.provider} · {a.status}
                  </option>
                ))}
              </select>
              <label htmlFor={`request-${id}`}>Request</label>
              <textarea
                id={`request-${id}`}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe the next step for the selected agent…"
                required
              />
              <div className="modal-actions">
                <span className="muted">
                  Sent to the selected agent. An explicit @name overrides it.
                </span>
                <button
                  disabled={
                    running ||
                    action.isPending ||
                    !message.trim() ||
                    (recipientMissing &&
                      !message.trimStart().startsWith("@")) ||
                    !d.agents.length
                  }
                  className="primary"
                >
                  Send request
                </button>
              </div>
            </form>
          </section>
          <section className="panel" hidden={section !== "History"}>
            <h2>Timeline</h2>
            {d.timeline.map((t) => (
              <article className="event" key={t.id}>
                <div className="event-meta">
                  <span>{new Date(t.created_at).toLocaleString()}</span>
                  <span className="badge">{t.kind}</span>
                </div>
                <p>{t.text}</p>
                <details>
                  <summary>Record detail</summary>
                  <pre>{JSON.stringify(t.detail_json, null, 2)}</pre>
                </details>
              </article>
            ))}
          </section>
          <section className="panel" hidden={section !== "History"}>
            <h2>Linked sessions</h2>
            {d.sessions.map((s) => (
              <button
                className="list-row"
                key={s.id}
                onClick={() => onSession(s.id)}
              >
                <span>{s.title}</span>
                <span className="badge">
                  {s.provider} · {s.status}
                </span>
              </button>
            ))}
          </section>
          <section className="panel" hidden={section !== "Review"}>
            <h2>Merge Status</h2>
            <span className="badge warning">{d.merge.readiness}</span>
            <p>
              <code>
                {u.branch} → {u.base_branch}
              </code>
            </p>
            {d.git_error && <p role="alert">{d.git_error}</p>}
            <dl className="facts compact">
              <dt>Ahead / behind</dt>
              <dd>
                ↑{d.git?.ahead ?? "?"} ↓{d.git?.behind ?? "?"}
              </dd>
              <dt>Working tree</dt>
              <dd>
                {!d.git
                  ? "Unavailable"
                  : d.git.dirty
                    ? "Uncommitted changes"
                    : "Clean"}
              </dd>
              <dt>Observed tests</dt>
              <dd>{d.merge.test.status}</dd>
              <dt>Reviewer</dt>
              <dd>
                {d.merge.review.status}
                {d.merge.review.synthetic ? " (synthetic)" : ""}
              </dd>
            </dl>
            <p className="muted">{d.merge.test.scope}</p>
            <h3>Changed files</h3>
            {d.git?.changed_files.map((f) => (
              <div key={f}>
                <code>{f}</code>
              </div>
            ))}
            {d.merge.overlaps.map((o) => (
              <p className="warning" key={o.branch}>
                Potential overlap with {o.branch}: {o.files.join(", ")}
              </p>
            ))}
            <p className="muted">{d.merge.note}</p>
          </section>
          <details
            className="panel"
            hidden={section !== "Review"}
            open={section === "Review"}
          >
            <summary>Environment fingerprint and observed commits</summary>
            <pre>{JSON.stringify(u.environment_json, null, 2)}</pre>
            {d.commits.map((c) => (
              <p key={c.hash}>
                <code>{c.hash.slice(0, 8)}</code> {c.subject}
                <br />
                <small className="muted">{c.provenance}</small>
              </p>
            ))}
          </details>
        </div>
        <div>
          <section className="panel">
            <div className="section-title">
              <h2>Agent Team</h2>
              <button
                onClick={() => {
                  setEditId(null);
                  setEditing({ ...defaultTeam()[1], name: "Agent" });
                }}
              >
                + Agent
              </button>
            </div>
            {d.agents.map((a) => (
              <article className="agent-card" key={a.id}>
                <div className="section-title">
                  <strong>{a.name}</strong>
                  <span
                    className={`badge ${a.status === "failed" ? "warning" : ""}`}
                  >
                    {a.status}
                  </span>
                </div>
                <p className="muted">
                  {a.role} ·{" "}
                  {a.provider === "fake"
                    ? "FakeProvider (synthetic)"
                    : a.provider}{" "}
                  · {a.model || "provider default"}
                </p>
                <details className="agent-permissions">
                  <summary>Permissions</summary>
                  <small className="muted">{a.permissions}</small>
                </details>
                {a.error && <p role="alert">{a.error}</p>}
                <div className="agent-actions">
                  <button
                    disabled={a.status === "running"}
                    onClick={() => {
                      setEditId(a.id);
                      setEditing(a);
                    }}
                  >
                    Edit
                  </button>
                  {a.status === "running" ? (
                    <button
                      onClick={() =>
                        action.mutate({ path: `/agents/${a.id}/stop` })
                      }
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      disabled={
                        running ||
                        !providers.data?.find((p) => p.id === a.provider)
                          ?.capabilities.one_shot
                      }
                      onClick={() =>
                        action.mutate({
                          path: `/agents/${a.id}/start`,
                          body: {
                            message: `Perform your ${a.role} role for this Work Unit. ${u.description}`,
                          },
                        })
                      }
                    >
                      Start
                    </button>
                  )}
                  {a.provider_session_id && (
                    <button onClick={() => onSession(a.provider_session_id!)}>
                      Session
                    </button>
                  )}
                  {a.status === "idle" && !a.provider_session_id && (
                    <button
                      onClick={() => {
                        if (window.confirm(`Remove unused agent ${a.name}?`))
                          action.mutate({
                            path: `/agents/${a.id}`,
                            method: "DELETE",
                          });
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Needs Attention</h2>
            {running && <p>Agent process is active.</p>}
            {d.agents
              .filter((a) =>
                ["failed", "interrupted", "stopped"].includes(a.status),
              )
              .map((a) => (
                <p className="warning" key={a.id}>
                  {a.name}: {a.error || a.status}
                </p>
              ))}
            {d.git?.behind ? (
              <p className="warning">
                {d.git.behind} commits behind {u.base_branch}.
              </p>
            ) : null}
            {next && !running && (
              <p className="muted">{next} is waiting to start.</p>
            )}
            {!running &&
              !next &&
              !d.git?.behind &&
              !d.agents.some((a) =>
                ["failed", "interrupted", "stopped"].includes(a.status),
              ) && (
                <p className="muted">
                  No current process or workflow alerts. Review merge evidence
                  separately.
                </p>
              )}
          </section>
          <details className="panel">
            <summary>Work Unit status · {u.status}</summary>
            <label>
              Move to
              <select
                value=""
                disabled={running}
                onChange={(e) => {
                  if (e.target.value)
                    action.mutate({
                      path: `/work-units/${id}/status`,
                      body: { status: e.target.value },
                    });
                }}
              >
                <option value="">Current: {u.status}</option>
                {states[u.status]?.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              Archiving preserves branches, worktrees, and history.
            </p>
          </details>
        </div>
      </div>
      {editing && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Agent profile"
          >
            <div className="section-title">
              <h2>{editId ? "Edit agent" : "Add agent"}</h2>
              <button onClick={() => setEditing(null)}>Close</button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <ProfileFields
                profile={editing}
                onChange={setEditing}
                providers={providers.data ?? []}
                profiles={profiles.data ?? []}
              />
              {save.error && <p role="alert">{save.error.message}</p>}
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() =>
                    action.mutate({ path: "/profiles", body: editing })
                  }
                >
                  Save reusable profile
                </button>
                <button className="primary" disabled={save.isPending}>
                  Save agent
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
