# Otter Beta Status

Verification date: 2026-09-07. Original scope: [PRD.md](PRD.md).
This is a local-first Linux beta, not a claim that every provider/account or desktop OS is certified.

## Implemented

- Rust `otterd`, React/TypeScript UI and Tauri 2 lifecycle shell using the same authenticated local API.
- SQLx migrations, SQLite ownership guard, exclusive daemon lock, private data directory, restart token rotation and FTS5.
- Real Git repository validation, branch/worktree discovery, HEAD, dirty files and divergence. Work Unit-specific base branches are respected.
- Compact clickable Workspace Map; Work Unit wizard with captured base commit, new or existing worktree, persisted default team and rollback on storage failure.
- Reusable profiles, names, roles, instructions, provider/model selection, inherited Work Unit worktree assignment, start/stop and case-insensitive `@Name` addressing.
- Planner → Builder → Reviewer with explicit transitions, plans/results/reviews, structured handoffs and durable timeline. Handoff persistence and next-agent startup state are atomic.
- Codex and Claude JSONL adapters; bounded incremental imports, raw preservation, partial-line retry, truncation recovery, unknown/malformed record retention and duplicate prevention.
- Overview, Conversation, Actions, Files, Commands, Timeline and Raw views; paginated search with direct event highlighting.
- Native project/worktree PTY shell via authenticated WebSocket and xterm.js, including resize and close cleanup.
- Measured merge hints, observed real test exit status, synthetic review labels and file-level overlap warnings. No automatic merge, branch deletion or discard.
- Non-secret environment fingerprint, process/ingestion health and provenance through Work Units, worktrees, agents and sessions.
- Deterministic FakeProvider success/failure/cancellation and full persisted workflow without paid model calls.
- SIGKILL/restart recovery with fresh Git observations and unattachable processes marked interrupted; persisted PIDs are never treated as authority to kill a process.
- Docker-isolated development, native Linux daemon/web archive and Tauri AppImage/Debian packages.

## Partially Implemented

- Real provider execution: Codex CLI flags and actual local history were verified. The native execution adapter was tested with a synthetic executable contract, not a paid model invocation. Account authentication, model access and host-specific provider sandbox behavior remain runtime prerequisites.
- Claude execution uses documented print/stream JSON flags with conservative permissions, but no Claude CLI is installed on this host. Synthetic parsing works; live account execution is unverified.
- Provider roles: Codex native sandbox is requested. Claude's built-in tool restriction is not an OS sandbox and does not restrict configured MCP tools; its role policy is explicitly advisory.
- Provenance: commits are observed on the Work Unit branch. Specific agent authorship is left unknown unless source evidence establishes it; there is no line-level blame.
- Session actions depend on exposed source fields. Unrecognized tools and formats remain available in Raw; Otter does not infer missing file accesses, exit codes, token usage or hidden reasoning.

## Not Implemented

- Provider-native resume/interactive agent PTY attachment; capability flags are disabled. Ordinary workspace terminals work.
- Automatically discovered account model catalogs, generic workflow editor, approval inbox, remote-agent networking, semantic search and destructive Git UI actions.
- Windows/macOS native distribution and cross-platform runtime certification. Those clients can use the home-server browser UI over SSH.
- Automatic system-service installation or auto-update/signing infrastructure.

These are documented capability limits/non-goals under PRD sections 25, 51, 53, 73, 75 and 78, not hidden working controls.

## Provider Compatibility

| Provider     | Observed version           | Verified here                                                                                          |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex        | `codex-cli 0.153.4`        | `--version`, `exec --help`, required JSON/ephemeral/sandbox/model flags; real read-only history import |
| Claude Code  | Not installed              | Unavailable state, synthetic source parsing; command shape checked against official reference          |
| FakeProvider | Otter synthetic provider 1 | Planner/Builder/Reviewer, simulated activity, failures, stop, persistence and search                   |

Detection requires the adapter's safe structured-output flags. An installed executable alone does not establish account/model availability. Managed sessions disable provider-side session persistence and retain native session IDs in Otter to avoid duplicate reimport.
See [Provider adapters](docs/PROVIDER_ADAPTERS.md) for exact options, sources and configuration.

## Environment

- Linux x86_64 inside the user's existing Proxmox LXC home server.
- Docker 28.5.1 / Compose 2.40.2. Otter-only image from Node 24 and Rust 1 Debian Bookworm bases, UID/GID-matched non-root commands and isolated named caches.
- Observed container toolchains: Node 24.20.0, pnpm 10.30.3, Rust/Cargo 1.98.0.
- Native libraries, Rust and browser dependencies installed in the development container. No host package/global runtime changes, Docker socket mount, privileged mode, host networking or changes to unrelated services.
- Browser access uses loopback plus SSH forwarding. Xvfb verifies packaged Linux desktop lifecycle; WebKit sandbox disabling is confined to that disposable container test.

## Tests Executed

| Command                                                                       | Evidence                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./scripts/check`                                                             | Rust formatting, Clippy with warnings denied, TypeScript and ESLint passed                                                                                          |
| `./scripts/test`                                                              | 15 Rust integration tests and 4 frontend tests passed                                                                                                               |
| `./scripts/e2e`                                                               | Chromium workflow, real Git map, PTY output/close, search focus, six history tabs, import idempotency and restart passed                                            |
| `node scripts/smoke.mjs`                                                      | Native host API auth, serving, real Git, SIGKILL recovery, refreshed HEAD/dirty state, interrupted agent/session and token rotation passed                          |
| `node scripts/history-smoke.mjs`                                              | One stable real Codex source: 34 raw / 12 normalized records, zero new records on reimport, unchanged source SHA-256 and paginated tabs; no private content printed |
| `./scripts/in-dev cargo test -p otter-core --test storage_git -- --nocapture` | 1,000 synthetic sessions / 200,000 normalized events; page+FTS+count checks ~2.7 ms on this host after ingestion (not a cross-machine benchmark)                    |
| `./scripts/in-dev node scripts/desktop-smoke.mjs`                             | Packaged AppImage starts in Xvfb, serves bundled UI through authenticated sidecar and stops its daemon on exit                                                      |

Rust tests additionally exercise actual diverged temporary Git branches/worktrees, collisions, rollback, unrelated SQLite protection, fixture normalization, malformed/truncated/partial JSONL, state transitions, duplicate-start prevention, cancellation, failed handoff rollback and overlapping files. No destructive test uses the real Otter repository.

The expanded Chromium journey also passed profile save/add/edit/remove and
case-insensitive addressing, stop and associated-session navigation.
Repository selection now includes an authenticated folder explorer, with parent
navigation, hidden folders, Git markers and cancellation. Rust verifies directory
access authentication, files excluded from listings, hidden folders, spaces/Unicode
names and invalid paths. Chromium verifies browse → select → register and cancellation
without changing the entered path. In home-server mode the explorer lists server
folders, not browser-client files; no directory upload is performed.
`node scripts/release-smoke.mjs` passed actual archive extraction, native launcher,
private URL, authenticated API, bundled JavaScript and shutdown cleanup.
`./scripts/in-dev cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
passed for the native Tauri shell.
`docker compose -f compose.dev.yml build --no-cache dev` also passed from fresh
development image layers; the observed toolchain versions remained unchanged.
One subsequent AppImage build failed when the upstream runtime download returned
HTTP 504. The build script now retries and caches the official runtime before
packaging; no application or sandbox setting was weakened to handle this.

## Build Status

- Production frontend and native Linux daemon build successfully.
- Tauri Linux build produces AppImage and Debian packages; packaged lifecycle has been tested under Xvfb.
- Output: `artifacts/otter-linux-x86_64.tar.gz`, `artifacts/desktop/Otter_0.1.0_amd64.AppImage`, `artifacts/desktop/Otter_0.1.0_amd64.deb`.
- Build outputs/caches/runtime databases are ignored by Git. Source instructions and lockfiles are committed; binaries are downloaded separately from this home server.

## Known Limitations

- Linux archive requires compatible Linux x86_64 system libraries and Git for repository operations. AppImage needs a GUI; `--appimage-extract-and-run` handles systems without FUSE.
- Imports poll every 10 seconds in batches of 500 records / approximately 8 MiB. A single line over 4 MiB is reported as an import error. A large initial backlog takes multiple passes.
- Existing histories are linked by exact known cwd; uncertain Work Unit attribution stays null. Reusing a path does not retroactively assign old sessions to a new task.
- Session/history APIs paginate. The 200,000-event storage test is not an exhaustive 100-worktree GUI performance certification.
- Provider CLI integration can be affected by account permissions, local configuration, MCP servers and sandbox restrictions. Otter never enables an unsafe bypass automatically.
- `interrupted` means the new daemon cannot attach to the prior execution, not proof that arbitrary external processes stopped. Otter only cancels owned children.
- Local session records can themselves contain sensitive material. The database is private application data; back it up carefully. Logs do not include prompts, auth tokens or environment values.
- Light theme, automatic workflow transitions and custom team presets are not beta priorities. Profiles are reusable; the built-in workflow is deliberately explicit.

## Recommended Next Steps

1. Use FakeProvider once, then run a small real task with an installed/authenticated provider and inspect its permission behavior.
2. Add versioned real-provider compatibility checks on dedicated test accounts; retain synthetic deterministic CI.
3. Add macOS/Windows native build runners and signed releases.
4. Improve tool/result correlation and broader provider-format coverage without guessing missing evidence.
5. Benchmark larger multi-project/worktree workloads and add targeted virtualization where measurements justify it.

## Acceptance evidence

The section-by-section evidence map is [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).
User connection, download, data/privacy and troubleshooting instructions are in [README.md](README.md).
