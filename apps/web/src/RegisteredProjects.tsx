import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "./api";

export type Project = {
  id: string;
  name: string;
  root_path: string;
  base_branch: string;
};

export function RegisteredProjects({
  projects,
  loading,
  onOpen,
  onRemoved,
}: {
  projects: Project[];
  loading: boolean;
  onOpen: (id: string) => void;
  onRemoved: (id: string) => void;
}) {
  const [pending, setPending] = useState<Project | null>(null);
  const [notice, setNotice] = useState("");
  const remove = useMutation({
    mutationFn: (project: Project) =>
      api(`/projects/${encodeURIComponent(project.id)}`, undefined, "DELETE"),
    onSuccess: (_, project) => {
      setPending(null);
      setNotice(`${project.name} was removed from Otter. Files and history were kept.`);
      onRemoved(project.id);
    },
  });
  return (
    <section className="panel" aria-labelledby="registered-projects-title">
      <h2 id="registered-projects-title">Registered projects ({projects.length})</h2>
      <p className="muted">
        Open an existing project, or remove its registration from Otter only.
      </p>
      {notice && <p role="status">{notice}</p>}
      {loading ? <p className="muted">Loading projects…</p> : projects.length === 0 && (
        <p className="muted">No registered projects. Add a repository below.</p>
      )}
      {projects.map((project) => (
        <div className="registered-project" key={project.id}>
          <div className="registered-project-row">
            <button
              className="registered-project-open"
              aria-label={`Open ${project.name} at ${project.root_path}`}
              onClick={() => onOpen(project.id)}
            >
              <strong>{project.name}</strong>
              <small>{project.root_path}</small>
            </button>
            <span className="badge">{project.base_branch}</span>
            <button
              disabled={remove.isPending}
              aria-label={`Remove ${project.name} from Otter`}
              onClick={() => {
                setPending(project);
                setNotice("");
                remove.reset();
              }}
            >
              Remove from Otter
            </button>
          </div>
          {pending?.id === project.id && (
            <div className="project-remove-confirm" role="group" aria-label={`Confirm removing ${project.name}`}>
              <p>Remove <strong>{project.name}</strong> from Otter?</p>
              <p className="muted">
                Only the registration is removed. Repository files, Git branches,
                worktrees, Work Units and session history are kept. Running tasks
                are not stopped. Add the same folder again to restore it.
              </p>
              {remove.error && <p role="alert">{remove.error.message}</p>}
              <div className="project-actions">
                <button disabled={remove.isPending} onClick={() => { setPending(null); remove.reset(); }}>
                  Cancel
                </button>
                <button disabled={remove.isPending} onClick={() => remove.mutate(project)}>
                  {remove.isPending ? "Removing…" : "Remove registration"}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
