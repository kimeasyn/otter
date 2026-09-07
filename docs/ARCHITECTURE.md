# Otter architecture

Otter is a local-first AI Development Control Center. Git records resulting code;
Otter records the Work Units, agents, sessions and handoffs behind that work.

```
React browser UI or Tauri window
              │ authenticated HTTP / terminal WebSocket
              ▼
           otterd
              ├── SQLite / FTS5 / SQLx migrations
              ├── Git CLI / worktree observations
              ├── provider detection / JSONL import
              ├── managed agent processes / FakeProvider
              └── PTY shell sessions
```

`crates/otter-core` owns storage, provider normalization, incremental ingestion,
Git inspection, Work Unit creation and agent execution. `crates/otterd` provides
the HTTP application, aggregate views and PTY transport. `apps/web` is a React,
TypeScript and Vite client with TanStack Query for server state and Zustand for
ephemeral connection state. Tailwind is available alongside component CSS.
The terminal is loaded lazily through xterm.js.

Tauri 2 is a lifecycle shell. It starts the packaged daemon on an ephemeral
loopback port, reads its private connection file, opens the local UI and stops
the daemon on application exit. It exposes no shell permissions to web content.
The same production UI works in a browser without Tauri.

## Isolation and runtime boundary

Compilation, installation and automated testing use `Dockerfile.dev`. Source is
bind-mounted and commands run with the host UID/GID. Cargo and pnpm caches belong
to the `otter-dev` Compose project. No Docker socket or privileged container is
needed. No other host services are modified.

The built daemon runs as the local user so it can see their repositories and
provider CLIs without copying credentials into the development image. This is
also how the downloadable archive runs. The LXC is the user's existing runtime;
Otter does not install a new system service or expose a LAN daemon.

## Security and privacy

- Loopback binding is enforced. Access a home-server instance with SSH forwarding.
- API requests require a random per-start token. Host and Origin are validated.
- Terminal handshakes carry the token in a WebSocket subprotocol; it is not a query parameter.
- Static UI and APIs use a restrictive content security policy and no-referrer policy.
- Tokens live in a private connection file; the UI stores them in tab-scoped sessionStorage.
- Private application directories are required. Existing shared-directory permissions are not changed.
- Existing SQLite files must identify as Otter before migrations run.
- Provider raw source files are opened read-only. Imported content is rendered as text.
- No telemetry, cloud backend or additional routing-model call is used.
- A real provider may communicate with its own service when the user starts it.

## Git and workflow safety

Work Unit creation validates names and base references before creating a branch.
The branch starts at the captured base commit. A SQLite transaction persists the
unit, worktree and team. On failure, rollback removes only the clean worktree and
branch created by that request. Otherwise the error identifies what remains.

The built-in workflow uses explicit stage transitions. Each handoff contains the
original task, plan, prior result, session IDs, HEAD, changed files and diff summary.
Handoff insertion and the next agent/session/process state commit together before
the provider process starts, so a failed handoff cannot silently launch work.
Rerunning planning or building invalidates downstream completion state while
retaining historical artifacts. `@Name` routing is deterministic and case-insensitive.
One managed agent runs per Work Unit at a time. Provider sandbox failures are
reported; Otter does not switch to unsafe bypass flags.

Merge status is a transparent heuristic, never a merge-safety proof. FakeProvider
results cannot satisfy real test/review evidence. Commits are reported as observed
on a Work Unit branch; specific agent authorship is not inferred.

## Recovery

SQLite transactions protect history and ingestion cursors. A data-directory lock
prevents multiple daemons from mutating the same state. Each restart rotates the
token, reconciles unattachable running records as interrupted, rescans Git when
project/work views are loaded and resumes imports. Persisted PIDs are never used
to kill processes. Live owned child handles implement cancellation. Linux agent
children request termination when their daemon parent dies.
