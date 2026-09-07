# Otter implementation ledger

The full product contract remains in PRD.md. This ledger tracks delivery evidence;
an unchecked item is not a completed beta feature.

## Environment decision

Docker 28.5.1 and Compose 2.40.2 are available on the x86_64 LXC host.
Use an Otter-only development image and named caches, with UID/GID matching the
host. Do not install host packages, mount the Docker socket, or touch other services.
Build browser + daemon artifacts for access through SSH forwarding. Keep the daemon
loopback-only. Desktop packaging is a separate Tauri build using the same core.

## Delivery gates

- [x] A: isolated build, authenticated UI/daemon/SQLite vertical slice
- [x] B: project validation and real Git discovery
- [x] C: compact interactive workspace map
- [x] D: provider discovery, resilient persistent ingestion and session views
- [x] E: Work Unit wizard, branch/worktree creation and persisted team
- [x] F: profiles, capabilities, process start/stop and explicit addressing
- [x] G: persisted Planner → Builder → Reviewer workflow and handoffs
- [x] H: measured merge status, test/review state and overlap warnings
- [x] I: restart recovery, process reconciliation and resumed imports
- [x] J: FTS search with useful source navigation
- [x] PTY terminal, environment fingerprint, health and provenance
- [x] Automated Rust, frontend, integration and browser acceptance checks
- [x] Production artifacts, Tauri build/runtime smoke, README and beta report

AGENTS.md contains only two editor fragments; it has no additional development
instructions and is preserved as user content. PRD section 17 prohibits autonomous
remote push. A separate explicit user request to push was fulfilled; subsequent
goal changes remain local unless another push is requested.

## Requirement evidence map

Paths below are repository-relative. Tests use temporary repositories and synthetic
history unless explicitly described as the optional read-only real-history smoke.

| PRD sections                  | Current implementation / verification evidence                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3: identity/principles      | Otter branding in `apps/web/src/App.tsx`, `index.html` and Tauri config; browser/package smoke checks identity                                                                                            |
| 4–14: host safety/isolation   | `Dockerfile.dev`, `compose.dev.yml`, `scripts/in-dev`; matched non-root UID/GID, named caches, no published ports/socket/privileged/host networking; dependencies built inside Docker                     |
| 15–17: repository/milestones  | Baseline `e296715`, architecture `3899038`, history `77b1b5e`, workflow `0549614`; original PRD preserved                                                                                                 |
| 18, 23: domain/storage        | SQL migrations, `work.rs`, unit/detail APIs; workflow/storage integration tests prove relationship persistence                                                                                            |
| 19–22: architecture/auth/data | Cargo/pnpm manifests; `db.rs`, daemon main/router, Tauri shell; API auth/origin tests, unrelated-SQLite guard and native restart smoke                                                                    |
| 24: reasoning privacy         | `providers.rs`; parser test excludes hidden thinking/encrypted content from public summaries; Raw contains actual locally available records only                                                          |
| 25–26: adapters/actual CLI    | Version/help detection and truthful capability flags; host Codex help and real-history smoke; Claude unavailable, synthetic fixture supported                                                             |
| 27: ingestion                 | Bounded transactions/cursors; fixture test covers append, duplicate, partial, truncate, malformed/unknown, restart and unchanged source bytes                                                             |
| 28–34: session experience     | `History.tsx`, history API; Chromium opens all six event tabs plus Overview, verifies conversation excludes tool badges                                                                                   |
| 35: search                    | FTS triggers, search/focus offset; Rust storage/fixture tests and Chromium click-through to highlighted source                                                                                            |
| 36–38: Git/map/overlap        | `git.rs`, `scan_project`, WorkspaceMap; actual divergence/dirty/HEAD/collision tests, per-unit-base regression, overlap API test and browser map                                                          |
| 39: wizard                    | `NewWorkUnit`, `work::create`; Chromium creates branch/worktree/team, frontend slug/capability tests, storage-failure rollback test                                                                       |
| 40–46: profiles/roles/agents  | `work.rs`, Executor, Agent Team UI; Chromium adds/renames/removes unused agent, saves profile, sends `@REVIEWER`, stops and opens session; core routing tests                                             |
| 47–52: workflow/handoffs      | Explicit stages persist plan/result/review, two structured handoffs and timeline; failed handoff test proves no next agent starts                                                                         |
| 53: terminal                  | `terminal.rs`, `Terminal.tsx`; browser opens worktree PTY, executes harmless printf, verifies actual output and closes it; unreliable native agent attachment disabled                                    |
| 54: provenance                | Foreign keys and aggregate session/artifact/handoff links; commits labelled observed branch history without guessing agent authorship                                                                     |
| 55–56: merge safety           | `units.rs` measurable rules and real test recognition excluding fake; overlap API/synthetic merge browser assertions; no destructive Git UI operations                                                    |
| 57–58: health/environment     | Counts/last activity/repeated-command heuristic, Needs Attention, `work::fingerprint`; no fabricated token/context metrics or `.env` contents                                                             |
| 59: recovery                  | `Db::reconcile`, owned-child cancellation; native SIGKILL smoke verifies unit/session preservation, interrupted status, token rotation and refreshed HEAD/dirty state; importer restart/idempotency tests |
| 60–63: navigation/design      | Projects/Work Units/Sessions/Search, compact map/team/detail/attention/terminal; browser screenshot/control journey; explicit empty/unknown states                                                        |
| 64: FakeProvider              | Timed synthetic events/results and injected failure; core/Chromium workflow needs no account                                                                                                              |
| 65–67: tests/fixtures/safety  | Rust/frontend/browser suites and synthetic Codex/Claude fixtures; destructive Git tests exclusively use temporary repositories                                                                            |
| 68: bounded performance       | Indexed paginated history, capped ingestion; 1,000-session / 200,000-event test passes. 100-worktree full GUI performance not certified                                                                   |
| 69–70: logs/errors            | JSON tracing for startup, storage readiness, ingestion counts, process state and API failures without request content; meaningful private UI errors; failure/guard tests                                  |
| 71–74: structure/scripts/docs | Monorepo, dev/check/test/e2e/build/build-desktop scripts, README and four required docs; native archive and Tauri Xvfb smoke                                                                              |
| 75–78: scope/adaptation       | No generic DAG, cloud/telemetry, embeddings, hidden-reasoning extraction, IDE or destructive auto-Git; unreliable provider capabilities disabled/documented                                               |
| 79–80: quality/journeys       | Gates A–J above backed by Rust, frontend, native and browser tests, not static placeholder screens                                                                                                        |
| 81–84: delivery checks        | Formatting/Clippy/typecheck/lint/tests/builds, archive smoke, secrets-pattern scan, README commands and isolated image build; final Git status/history and coherent commit inspected at delivery          |
| 85–88: autonomy/core product  | Environment/implementation did not require user framework/schema/install decisions; home-server browser access and downloadable Linux packages documented                                                 |

## Verification scope

See [BETA_STATUS.md](../BETA_STATUS.md) for executed commands and explicit
provider/platform limitations. A green FakeProvider journey does not claim a paid
Codex/Claude task was executed. File-level overlap is not a proven merge conflict;
a completed synthetic review is not real review evidence.
