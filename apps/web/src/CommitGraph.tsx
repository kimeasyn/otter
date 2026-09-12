import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type Commit = {
  hash: string;
  parents: string[];
  refs: string;
  author: string;
  date: string;
  subject: string;
};
export function layoutCommits(commits: Commit[]) {
  const lanes: string[] = [];
  return commits.map((commit) => {
    const incoming = lanes.includes(commit.hash);
    if (!incoming) lanes.push(commit.hash);
    const before = [...lanes];
    const column = lanes.indexOf(commit.hash);
    lanes.splice(column, 1);
    let insert = column;
    for (const parent of commit.parents) {
      if (!lanes.includes(parent)) lanes.splice(insert++, 0, parent);
    }
    const edges = before.flatMap((hash, from) =>
      hash === commit.hash
        ? commit.parents.map((parent) => ({
            from,
            to: lanes.indexOf(parent),
            node: true,
          }))
        : [{ from, to: lanes.indexOf(hash), node: false }],
    );
    return {
      commit,
      column,
      incoming,
      edges,
      width: Math.max(before.length, lanes.length, 1),
    };
  });
}
const colors = ["#9bd9bb", "#8db9ef", "#d3a5ec", "#edc38a", "#ea9eaa"];
export function CommitGraph({ project }: { project: string }) {
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState("");
  const history = useQuery({
    queryKey: ["commits", project, limit],
    queryFn: () =>
      api<{ items: Commit[]; has_more: boolean }>(
        `/projects/${project}/commits?limit=${limit}`,
      ),
    refetchInterval: 15000,
  });
  const rows = layoutCommits(history.data?.items ?? []);
  const width = Math.max(2, ...rows.map((row) => row.width)) * 18 + 12;
  const detail = history.data?.items.find((commit) => commit.hash === selected);
  return (
    <section className="panel commit-panel" aria-label="Git commit history">
      <div className="section-title">
        <h2>Commit tree</h2>
        <button
          disabled={history.isFetching}
          onClick={() => history.refetch()}
          aria-label="Refresh commit tree"
        >
          {history.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="muted commit-caption">
        Local branches & remote-tracking refs · no automatic fetch
      </p>
      {history.error && <p role="alert">{history.error.message}</p>}
      {!history.isLoading && !history.error && !rows.length && (
        <p className="muted">No commits available.</p>
      )}
      <div
        className="commit-scroll"
        tabIndex={0}
        aria-label="Commit graph and messages"
      >
        {rows.map(({ commit, column, incoming, edges }) => (
          <button
            key={commit.hash}
            className={`commit-row ${selected === commit.hash ? "selected" : ""}`}
            aria-expanded={selected === commit.hash}
            onClick={() =>
              setSelected(selected === commit.hash ? "" : commit.hash)
            }
            style={{
              gridTemplateColumns: `${width}px minmax(180px, 1fr) 72px 86px`,
            }}
          >
            <svg width={width} height="34" aria-hidden="true">
              {incoming && (
                <path
                  d={`M ${column * 18 + 12} 0 V 17`}
                  stroke={colors[column % colors.length]}
                />
              )}
              {edges.map((edge, index) => (
                <path
                  key={index}
                  d={`M ${edge.from * 18 + 12} ${edge.node ? 17 : 0} L ${edge.from * 18 + 12} 17 L ${edge.to * 18 + 12} 34`}
                  fill="none"
                  stroke={colors[edge.to % colors.length]}
                  strokeWidth="1.5"
                />
              ))}
              <circle
                cx={column * 18 + 12}
                cy="17"
                r="4"
                fill={colors[column % colors.length]}
              />
            </svg>
            <span className="commit-subject" title={commit.subject}>
              {commit.refs && (
                <span className="commit-refs" title={commit.refs}>
                  {commit.refs}
                </span>
              )}
              {commit.subject}
            </span>
            <code>{commit.hash.slice(0, 7)}</code>
            <time dateTime={commit.date}>{commit.date.slice(0, 10)}</time>
          </button>
        ))}
      </div>
      {detail && (
        <div className="commit-detail">
          <strong>{detail.subject}</strong>
          <span>
            {detail.author} · {new Date(detail.date).toLocaleString()}
          </span>
          <code>{detail.hash}</code>
          <span className="muted">
            Parents:{" "}
            {detail.parents.map((hash) => hash.slice(0, 8)).join(", ") ||
              "Root commit"}
          </span>
          {detail.refs && <span>{detail.refs}</span>}
        </div>
      )}
      {history.data?.has_more && (
        <div className="commit-footer">
          {limit < 200 ? (
            <button onClick={() => setLimit(Math.min(200, limit + 50))}>
              Show {limit + 50} commits
            </button>
          ) : (
            <span className="muted">
              Showing 200 commits. Older history continues in Git.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
