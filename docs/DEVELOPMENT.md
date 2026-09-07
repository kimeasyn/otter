# Development

## Bootstrap and isolation

The development host needs Git, Docker + Compose, Bash and Node. The current LXC
already provides these. Rust, pnpm, Tauri native libraries and Chromium dependencies
are installed only in `Dockerfile.dev`. The production archive does not need Node.

Run `./scripts/dev`. It builds the development image, installs locked dependencies,
compiles the daemon/UI inside Docker and runs the daemon as the host user. Ctrl+C
shuts it down. Source stays in the original bind-mounted repository, with the host
UID/GID. `otter-dev_cargo`, `otter-dev_target` and `otter-dev_pnpm` are isolated cache
volumes. No Docker socket, privileged container or host networking is used.

Observed image: Node 24.20.0, pnpm 10.30.3, Rust/Cargo 1.98.0 and Debian Bookworm
native libraries. Runtime major lines are pinned; patch versions may advance on
a fresh image build. Cargo and pnpm lockfiles pin application dependencies.

## Commands

| Command                                           | Purpose                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `./scripts/in-dev bash`                           | Isolated development shell                                               |
| `./scripts/check`                                 | Rust formatting/Clippy, TypeScript and ESLint                            |
| `./scripts/test`                                  | Rust integration and React tests                                         |
| `./scripts/e2e`                                   | Build and execute Chromium acceptance journey                            |
| `node scripts/smoke.mjs`                          | Native host daemon/storage/restart smoke after dev build                 |
| `node scripts/history-smoke.mjs`                  | Optional read-only real-history check on host; no source content printed |
| `./scripts/build`                                 | Production daemon + UI archive                                           |
| `./scripts/build-desktop`                         | Tauri sidecar and Linux bundles                                          |
| `./scripts/in-dev node scripts/desktop-smoke.mjs` | Packaged AppImage/Xvfb lifecycle test                                    |
| `./scripts/url`                                   | Private URL for running host daemon                                      |

Formatting:

```bash
./scripts/in-dev cargo fmt --all
./scripts/in-dev pnpm exec prettier --write apps/web/src
./scripts/in-dev cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The desktop crate has an independent Cargo workspace/lockfile so headless tests
do not require WebKit compilation. `build-desktop` prepares the target-suffixed
sidecar before invoking Tauri. Generated binaries and caches are Git ignored.
The AppImage runtime is downloaded from the official AppImage release with
bounded retries and cached in `.otter-dev/appimage`; linuxdeploy consumes it via
its documented [LDAI_RUNTIME_FILE setting](https://github.com/linuxdeploy/linuxdeploy-plugin-appimage#environment-variables).
This avoids a late appimagetool HTTP 504 aborting an otherwise complete bundle.

## Runtime and browser iteration

The normal development command serves the built UI from the native daemon. This
provides access to host repositories/provider CLIs without broad container mounts
or copying credentials. Rebuild the frontend after UI edits. Alternatively run
Vite and the daemon in the same isolated environment; Vite proxies localhost:4317.
The default Compose configuration does not publish development ports.

Another computer accesses the host daemon via SSH forwarding; README contains
the exact home-server commands. Remote-agent transport is outside beta scope.

## Tests

Tests create temporary repositories/databases; they never run destructive Git
checks against the real Otter repository. Provider fixtures are synthetic. The
browser journey creates a task/worktree, runs the fake team, opens a PTY, searches
history and verifies state after daemon restart.
The native smoke additionally kills its own daemon with SIGKILL and verifies
interrupted state plus Git changes made while the daemon was down. Storage tests
exercise paginated queries and FTS against 1,000 sessions / 200,000 events.

Chromium binaries are downloaded inside Docker to ignored `.otter-dev/browsers`.
The AppImage smoke disables WebKit sandboxing only in the disposable Docker/Xvfb
test environment. Production launchers do not set that option.

Use `OTTER_DATA_DIR` for isolated state and `OTTER_AUTO_IMPORT=0` to avoid loading
the current user's history into test databases. Never commit real history or credentials.
