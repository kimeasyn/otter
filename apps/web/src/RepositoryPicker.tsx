import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

type Directory = {
  path: string;
  parent: string | null;
  home: string;
  cwd: string;
  git_root: string | null;
  entries: { name: string; path: string; is_git: boolean }[];
  total: number;
  truncated: boolean;
};

export function RepositoryPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initialPath);
  const [address, setAddress] = useState(initialPath);
  const [hidden, setHidden] = useState(false);
  const [offset, setOffset] = useState(0);
  const listing = useQuery({
    queryKey: ["directories", path, hidden, offset],
    queryFn: () =>
      api<Directory>(
        `/directories?${new URLSearchParams({ path, hidden: String(hidden), offset: String(offset) })}`,
      ),
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (listing.data) setAddress(listing.data.path);
  }, [listing.data]);
  const open = (next: string) => {
    setPath(next);
    setAddress(next);
    setOffset(0);
  };
  const data = listing.data;
  return (
    <dialog
      ref={dialog}
      className="repository-picker panel"
      aria-labelledby="repository-picker-title"
      onCancel={onClose}
    >
      <div className="section-title">
        <h2 id="repository-picker-title">Choose a Git repository</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close folder browser"
        >
          Close
        </button>
      </div>
      <p className="muted">
        Folders on the machine running Otter. When connected to your home
        server, these are server folders—not files on this PC. Nothing is
        uploaded.
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          open(address);
        }}
      >
        <label className="grow">
          Folder location
          <input
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <button type="submit">Go</button>
      </form>
      <div className="folder-toolbar">
        <button
          type="button"
          disabled={!data?.parent}
          onClick={() => open(data!.parent!)}
        >
          ↑ Up
        </button>
        <button type="button" onClick={() => open(data?.home ?? "")}>
          Home
        </button>
        <button type="button" disabled={!data} onClick={() => open(data!.cwd)}>
          Otter working folder
        </button>
        <label>
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => {
              setHidden(e.target.checked);
              setOffset(0);
            }}
          />{" "}
          Show hidden folders
        </label>
      </div>
      {listing.error && <p role="alert">{listing.error.message}</p>}
      <div
        className="folder-list"
        aria-label="Folders"
        aria-busy={listing.isFetching}
      >
        {listing.isPending && <p role="status">Loading folders…</p>}
        {data?.entries.map((entry) => (
          <button
            type="button"
            className="folder-row"
            key={entry.path}
            onClick={() => open(entry.path)}
            aria-label={`Open folder ${entry.name}`}
          >
            <span>
              <span aria-hidden="true">▸ ▰ </span>
              {entry.name}
            </span>
            {entry.is_git && <span className="badge">Git</span>}
          </button>
        ))}
        {data && !data.entries.length && (
          <p className="muted">
            No {hidden ? "" : "visible "}subfolders in this directory.
          </p>
        )}
      </div>
      {data && data.total > 200 && (
        <div className="pager">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 200))}
          >
            Previous folders
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 200, data.total)} of {data.total}
          </span>
          <button
            disabled={offset + 200 >= data.total}
            onClick={() => setOffset(offset + 200)}
          >
            Next folders
          </button>
        </div>
      )}
      {data?.truncated && (
        <p className="warning">
          Only the first 10,000 directory entries were inspected. Enter a more
          specific folder location to find other folders.
        </p>
      )}
      <p className="muted">
        {data?.git_root ? (
          <>
            Repository: <code>{data.git_root}</code>
          </>
        ) : (
          "Open a Git repository folder to select it."
        )}
      </p>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!data?.git_root || listing.isFetching || listing.isError}
          onClick={() => onSelect(data!.git_root!)}
        >
          Select repository
        </button>
      </div>
    </dialog>
  );
}
