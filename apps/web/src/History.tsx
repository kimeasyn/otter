import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type Provider = {
  id: string;
  name: string;
  available: boolean;
  version: string | null;
  synthetic: boolean;
  models: string[];
  note: string;
  capabilities: {
    discovery: boolean;
    one_shot: boolean;
    resume: boolean;
    model_selection: boolean;
    permission_enforcement: boolean;
    interactive: boolean;
  };
};
type Session = {
  id: string;
  provider: string;
  title: string;
  cwd: string | null;
  work_unit_id: string | null;
  status: string;
  last_seen_at: string;
  started_at: string;
  source_path: string | null;
  warning_count: number;
  event_count: number;
};
type Event = {
  id: number;
  kind: string;
  text: string;
  target: string | null;
  timestamp: string;
  detail_json: unknown;
  raw_json?: unknown;
  source_event_type?: string;
  source_sequence?: number;
};
type Page<T> = { items: T[]; total: number };
const tabs = [
  "Overview",
  "Conversation",
  "Actions",
  "Files",
  "Commands",
  "Timeline",
  "Raw",
] as const;

export function Pager({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="pager">
      <span className="muted">
        {total ? offset + 1 : 0}–{Math.min(offset + 100, total)} of {total}
      </span>
      <button
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - 100))}
      >
        Previous
      </button>
      <button
        disabled={offset + 100 >= total}
        onClick={() => onChange(offset + 100)}
      >
        Next
      </button>
    </div>
  );
}
export function Providers() {
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<Provider[]>("/providers"),
    staleTime: 30000,
  });
  return (
    <div className="provider-grid">
      {providers.data?.map((p) => (
        <div key={p.id} className="provider-card">
          <strong>{p.name}</strong>
          <span className={`badge ${p.available ? "" : "warning"}`}>
            {p.synthetic
              ? "Synthetic"
              : p.available
                ? "Detected"
                : "Not installed"}
          </span>
          <p className="muted">{p.version ?? p.note}</p>
        </div>
      ))}
      {providers.error && <p role="alert">{providers.error.message}</p>}
    </div>
  );
}
export function Sessions({ onOpen }: { onOpen: (id: string) => void }) {
  const [offset, setOffset] = useState(0);
  const client = useQueryClient();
  const sessions = useQuery({
    queryKey: ["sessions", offset],
    queryFn: () => api<Page<Session>>(`/sessions?offset=${offset}`),
    refetchInterval: 10000,
  });
  const scan = useMutation({
    mutationFn: () =>
      api<{ inserted?: number; error?: string; path?: string }[]>(
        "/history/scan",
        {},
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sessions"] }),
  });
  const [provider, setProvider] = useState("codex");
  const [path, setPath] = useState("");
  const imported = useMutation({
    mutationFn: () =>
      api<{ session_id: string }>("/history/import", { provider, path }),
    onSuccess: (r) => {
      client.invalidateQueries({ queryKey: ["sessions"] });
      onOpen(r.session_id);
    },
  });
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">PERSISTENT DEVELOPMENT HISTORY</div>
        <h1>Sessions</h1>
        <p className="muted">
          Conversation and execution history, organized across providers.
        </p>
      </div>
      <Providers />
      <section className="panel">
        <div className="section-title">
          <h2>Session history</h2>
          <button onClick={() => scan.mutate()} disabled={scan.isPending}>
            {scan.isPending ? "Importing…" : "Scan provider history"}
          </button>
        </div>
        {scan.data && (
          <p className="muted">
            Imported {scan.data.reduce((sum, r) => sum + (r.inserted ?? 0), 0)}{" "}
            new records. {scan.data.filter((r) => r.error).length} source
            errors.
          </p>
        )}
        {scan.data
          ?.filter((r) => r.error)
          .map((r, i) => (
            <p key={i} role="alert">
              {r.path}: {r.error}
            </p>
          ))}
        {(scan.error || sessions.error) && (
          <p role="alert">{(scan.error || sessions.error)?.message}</p>
        )}
        {!sessions.data?.items.length && (
          <div className="empty">
            <h3>No sessions imported yet</h3>
            <p>
              Scan your provider history or import a JSONL session below.
              FakeProvider sessions will appear here when you run a synthetic
              workflow.
            </p>
          </div>
        )}
        {sessions.data?.items.map((s) => (
          <button className="list-row" key={s.id} onClick={() => onOpen(s.id)}>
            <span>
              <strong>{s.title}</strong>
              <small>{s.cwd ?? "Unassociated session"}</small>
            </span>
            <span className="badge">
              {s.provider === "fake" ? "FakeProvider · Synthetic" : s.provider}
            </span>
            <span className="muted">
              {s.event_count} events · {s.status}
            </span>
          </button>
        ))}
        {sessions.data && (
          <Pager
            offset={offset}
            total={sessions.data.total}
            onChange={setOffset}
          />
        )}
      </section>
      <details className="panel">
        <summary>Import a specific session file</summary>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            imported.mutate();
          }}
        >
          <label>
            Provider
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label className="grow">
            JSONL path on daemon machine
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
            />
          </label>
          <button disabled={imported.isPending}>Import session</button>
        </form>
        {imported.error && <p role="alert">{imported.error.message}</p>}
      </details>
    </>
  );
}

export function SessionView({
  id,
  focus,
  onWorkUnit,
}: {
  id: string;
  focus?: string;
  onWorkUnit?: (id: string) => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>(
    focus ? "Timeline" : "Overview",
  );
  const [offset, setOffset] = useState(0);
  const metadata = useQuery({
    queryKey: ["session", id],
    queryFn: () =>
      api<{
        session: Session;
        counts: { kind: string; count: number }[];
        repeated_commands: { text: string; count: number }[];
      }>(`/sessions/${id}`),
    refetchInterval: 10000,
  });
  const events = useQuery({
    queryKey: ["events", id, tab, offset, focus],
    queryFn: () =>
      api<Page<Event>>(
        `/sessions/${id}/events?kind=${tab.toLowerCase()}&offset=${offset}${focus && tab === "Timeline" && offset === 0 ? `&focus=${encodeURIComponent(focus)}` : ""}`,
      ),
    enabled: tab !== "Overview",
    refetchInterval: 10000,
  });
  const session = metadata.data?.session;
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">
          SESSION HISTORY ·{" "}
          {session?.provider === "fake" ? "SYNTHETIC" : session?.provider}
        </div>
        <h1>{session?.title ?? "Loading session…"}</h1>
        <p className="muted">{session?.cwd}</p>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => {
              setTab(t);
              setOffset(0);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {(metadata.error || events.error) && (
        <p role="alert">{(metadata.error || events.error)?.message}</p>
      )}
      {tab === "Overview" && session && (
        <section className="panel">
          <h2>Session overview</h2>
          <dl className="facts">
            <dt>Provider</dt>
            <dd>{session.provider}</dd>
            <dt>Status</dt>
            <dd>{session.status}</dd>
            <dt>Started</dt>
            <dd>{session.started_at}</dd>
            <dt>Last observed</dt>
            <dd>{session.last_seen_at}</dd>
            <dt>Source</dt>
            <dd>
              <code>{session.source_path ?? "Managed by Otter"}</code>
            </dd>
            <dt>Unclassified / malformed records</dt>
            <dd>{session.warning_count} (preserved in Raw)</dd>
            <dt>Work Unit</dt>
            <dd>
              {session.work_unit_id && onWorkUnit ? (
                <button onClick={() => onWorkUnit(session.work_unit_id!)}>
                  Open Work Unit
                </button>
              ) : (
                "No confirmed association"
              )}
            </dd>
          </dl>
          <h3>Activity</h3>
          <div className="chips">
            {metadata.data?.counts.map((c) => (
              <span className="badge" key={c.kind}>
                {c.kind} · {c.count}
              </span>
            ))}
          </div>
          {metadata.data?.repeated_commands.map((r) => (
            <p className="warning" key={r.text}>
              Repeated command: <code>{r.text}</code> ({r.count} times). This is
              a heuristic, not proof of a loop.
            </p>
          ))}
        </section>
      )}
      {tab !== "Overview" && (
        <section className="panel">
          <h2>{tab}</h2>
          {events.data?.items.length === 0 && (
            <p className="muted">
              No observable {tab.toLowerCase()} records in this session.
            </p>
          )}
          {events.data?.items.map((event) => (
            <article
              key={event.id}
              className={`event ${focus === String(event.id) ? "focused" : ""}`}
            >
              <div className="event-meta">
                <span className="badge">
                  {event.kind === "assistant.reasoning_summary"
                    ? "Reasoning Summary"
                    : (event.kind ?? event.source_event_type)}
                </span>
                <time>{event.timestamp}</time>
                <code>#{event.id}</code>
              </div>
              {tab === "Raw" ? (
                <details>
                  <summary>Source record {event.source_sequence}</summary>
                  <pre>
                    {typeof event.raw_json === "string"
                      ? event.raw_json
                      : JSON.stringify(event.raw_json, null, 2)}
                  </pre>
                </details>
              ) : (
                <>
                  {event.target && (
                    <code className="file-target">{event.target}</code>
                  )}
                  <pre className="event-text">
                    {event.text.length > 1600
                      ? event.text.slice(0, 1600) + "…"
                      : event.text}
                  </pre>
                  {(event.text.length > 1600 ||
                    Object.keys((event.detail_json as object) ?? {}).length >
                      0) && (
                    <details>
                      <summary>Technical details / full output</summary>
                      <pre>{event.text}</pre>
                      <pre>{JSON.stringify(event.detail_json, null, 2)}</pre>
                    </details>
                  )}
                </>
              )}
            </article>
          ))}
          {events.data && (
            <Pager
              offset={offset}
              total={events.data.total}
              onChange={setOffset}
            />
          )}
        </section>
      )}
    </>
  );
}

type Hit = {
  kind: string;
  source_id: string;
  session_id: string | null;
  work_unit_id: string | null;
  snippet: string;
};
export function Search({
  onSession,
  onWorkUnit,
}: {
  onSession: (id: string, event?: string) => void;
  onWorkUnit: (id: string) => void;
}) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const results = useQuery({
    queryKey: ["search", q, offset],
    queryFn: () =>
      api<Page<Hit>>(`/search?q=${encodeURIComponent(q)}&offset=${offset}`),
    enabled: !!q,
  });
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">LOCAL FULL-TEXT SEARCH</div>
        <h1>Find the work behind the code.</h1>
        <p className="muted">
          Search tasks, conversations, commands, and file paths.
        </p>
      </div>
      <form
        className="inline panel"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input);
          setOffset(0);
        }}
      >
        <label className="grow">
          Search history
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="A problem, phrase, command, or file…"
            required
          />
        </label>
        <button className="primary">Search</button>
      </form>
      {results.error && <p role="alert">{results.error.message}</p>}
      {results.data && (
        <section className="panel">
          <h2>{results.data.total} results</h2>
          {results.data.items.map((r, i) => (
            <button
              className="list-row"
              key={`${r.kind}-${r.source_id}-${i}`}
              onClick={() =>
                r.session_id
                  ? onSession(
                      r.session_id,
                      r.kind === "session" ? undefined : r.source_id,
                    )
                  : r.work_unit_id && onWorkUnit(r.work_unit_id)
              }
            >
              <span>
                <span className="badge">{r.kind}</span>
                <p>{r.snippet}</p>
              </span>
              <span>↗</span>
            </button>
          ))}
          <Pager
            offset={offset}
            total={results.data.total}
            onChange={setOffset}
          />
        </section>
      )}
    </>
  );
}
