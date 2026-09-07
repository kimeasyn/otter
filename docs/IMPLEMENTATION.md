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

- [ ] A: isolated build, authenticated UI/daemon/SQLite vertical slice
- [ ] B: project validation and real Git discovery
- [ ] C: compact interactive workspace map
- [ ] D: provider discovery, resilient persistent ingestion and session views
- [ ] E: Work Unit wizard, branch/worktree creation and persisted team
- [ ] F: profiles, capabilities, process start/stop and explicit addressing
- [ ] G: persisted Planner → Builder → Reviewer workflow and handoffs
- [ ] H: measured merge status, test/review state and overlap warnings
- [ ] I: restart recovery, process reconciliation and resumed imports
- [ ] J: FTS search with useful source navigation
- [ ] PTY terminal, environment fingerprint, health and provenance
- [ ] Automated Rust, frontend, integration and browser acceptance checks
- [ ] Production artifacts, Tauri build attempt, README and beta report

AGENTS.md contains only two editor fragments; it has no additional development
instructions and is preserved as user content. No remote push during this goal,
as specified in PRD section 17.
