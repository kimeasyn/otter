# OTTER — AUTONOMOUS BETA DEVELOPMENT GOAL

Build a functional beta version of **Otter** in the current Git repository.

You are already running from the target repository directory through Codex CLI.

The repository has been initialized with `git init`, but it may otherwise be empty.

Assume that after I submit this Goal I will NOT participate in development.

Do not ask me implementation questions.

You are responsible for taking the repository from its current state to the strongest coherent, installable, testable Otter beta possible.

You must autonomously:

* inspect the current repository
* inspect the development environment
* establish a safe isolated development environment
* install required dependencies inside that isolated environment
* create the initial Git baseline commit
* choose reasonable implementation details
* scaffold the project
* implement the product
* test continuously
* fix failures
* create meaningful Git commits throughout development
* build production artifacts where possible
* document limitations honestly
* leave the repository clean and understandable

Do not stop after:

* planning
* scaffolding
* architecture documents
* static mockups
* fake UI
* partial CRUD
* generating TODO lists

Continue until the beta acceptance criteria near the end of this Goal are satisfied as far as technically and safely possible.

If something is ambiguous, make the most reasonable engineering decision yourself, document important decisions, and continue.

---

# 1. PRODUCT NAME

The product name is:

# Otter

Use **Otter** consistently throughout the application.

Use it in:

* application/window title
* navigation/header
* welcome screen
* empty states
* settings/about
* application metadata
* Tauri configuration
* README
* documentation
* application logs where appropriate
* package descriptions where appropriate

The local core daemon is named:

```
otterd
```

Do not use old working names such as:

* Agent Workbench
* Agent Workspace
* AgentLog
* AI Workbench

Those phrases may describe the product category in explanatory text, but the actual product name is **Otter**.

Do not spend significant beta development time on branding or logo design.

A clean text-based Otter identity is enough.

Visual direction:

* professional developer tool
* dense but readable
* modern
* understated
* technical
* primarily dark
* not cartoonish
* not playful despite the name Otter

---

# 2. PRODUCT DEFINITION

Otter is not primarily:

* an IDE
* a source code editor
* a terminal replacement
* a generic chat application
* a generic Git GUI
* a Claude frontend
* a Codex frontend

Otter is:

> A local-first AI Development Control Center.

Core product problem:

> As developers use multiple AI coding agents in parallel across sessions, branches, worktrees, and providers, it becomes difficult to understand which agent worked where, what happened in previous sessions, what files changed, what context produced those changes, which work is still active, and how parallel work should eventually be reviewed and merged.

Otter exists to make this work persistent, visible, navigable, and manageable.

Core product statement:

> Git records the resulting code. Otter records and controls the AI-assisted work that produced it.

Secondary product statement:

> Otter is not an IDE for AI agents. It is a control center for managing AI agents doing software development.

Use these statements when product decisions are ambiguous.

---

# 3. HIGH-LEVEL PRODUCT PRINCIPLES

Prioritize:

1. Local-first operation
2. Developer-focused UX
3. Reliable persistence
4. Vendor-neutral agent abstraction
5. Git/worktree awareness
6. Visibility into agent activity
7. Recovery after crashes/restarts
8. Honest capability reporting
9. Real functionality instead of demo screens
10. Strong information architecture
11. Extensibility without unnecessary abstraction
12. Minimal impact on the host development environment

Avoid:

* cloud dependencies for beta
* user accounts
* authentication services
* SaaS infrastructure
* Kafka
* Kubernetes
* Redis unless absolutely justified
* PostgreSQL for beta
* Elasticsearch
* vector databases
* unnecessary microservices
* unnecessary LLM calls
* giant graph libraries
* visual workflow builders
* another VS Code clone
* fake provider status
* hard-coded sample state pretending to be real
* destructive automatic Git behavior
* silent failures
* hidden magic that cannot be inspected

---

# 4. HOST SERVER SAFETY — HARD REQUIREMENT

The host machine must be treated as a shared and valuable development environment.

It may already contain:

* unrelated repositories
* running services
* Docker containers
* databases
* globally installed Node versions
* Rust versions
* Python versions
* system libraries
* active development workloads

Otter development must NOT unnecessarily change or destabilize that environment.

## DO NOT casually perform host-level operations such as:

```
sudo apt install ...
sudo apt remove ...
apt install ...
apt upgrade ...
yum ...
dnf ...
pacman ...
brew install ...
npm install -g ...
pnpm add -g ...
cargo install ...
rustup default ...
update-alternatives ...
systemctl ...
service ...
```

Do not modify:

```
/usr/local
/usr/bin
/opt
/etc
```

unless there is an extraordinary reason and no safe alternative.

Do not edit global shell files:

```
~/.bashrc
~/.zshrc
~/.profile
```

Do not change global Git configuration unless unavoidable.

Do not replace or upgrade existing host:

* Node
* npm
* pnpm
* Rust
* Cargo
* Python
* Git
* Docker
* databases
* compilers

Do not stop, restart, rename, delete, or reconfigure unrelated host services.

Do not perform:

```
docker system prune
docker volume prune
docker image prune -a
docker network prune
```

Do not remove Docker resources that Otter did not create.

Host isolation is more important than shaving a few minutes off setup.

---

# 5. ISOLATED DEVELOPMENT ENVIRONMENT

The preferred development environment for this project is a **containerized Docker development environment**.

The current stack includes:

* Rust
* Cargo
* Node.js
* pnpm
* React
* Tauri
* SQLite
* native Linux build dependencies

Therefore Python virtual environments such as `uv` are NOT the appropriate primary isolation mechanism.

Use container isolation for the main development environment.

---

# 6. DEVELOPMENT ENVIRONMENT SELECTION

At the beginning inspect what is already available.

Check at minimum:

```
docker --version
docker compose version
```

If Docker is available, use Docker.

If Docker is unavailable, check:

```
podman --version
```

If Podman is available and sufficiently compatible, use Podman.

Do NOT automatically install or enable a system-wide Docker daemon if neither is present.

Installing Docker itself changes the host substantially and contradicts the host-protection requirement.

If no container runtime exists:

1. create the safest project-local isolated toolchain possible
2. keep toolchains under the repository or a dedicated user-owned Otter development directory
3. avoid modifying global versions
4. continue implementing everything possible
5. document any native build limitation in `BETA_STATUS.md`

Do not stop and ask me which isolation strategy to use.

Choose automatically according to these rules.

---

# 7. DOCKER DEVELOPMENT ENVIRONMENT

When Docker is available, set up a reproducible Otter development environment.

Create appropriate artifacts such as:

```
Dockerfile.dev
compose.dev.yml
```

Optionally add:

```
.devcontainer/devcontainer.json
```

if it provides meaningful value.

The development image should contain everything needed for ordinary Otter development.

Install INSIDE the container as needed:

* Rust toolchain
* Cargo
* rustfmt
* clippy
* Node.js
* Corepack
* pnpm
* C/C++ compiler toolchain
* pkg-config
* SQLite development packages
* Git
* curl
* certificates
* Tauri CLI/build dependencies
* GTK/WebKit/native Linux Tauri dependencies
* frontend test dependencies
* E2E dependencies where practical
* Xvfb if useful for headless GUI-related testing
* any additional libraries reasonably required by implementation

You have authority to install these inside the development image.

Do not ask me to install them manually.

Use a reproducible Dockerfile rather than manually mutating a long-running container.

Pin major/runtime versions where reasonable without creating unnecessary maintenance burden.

---

# 8. CONTAINER SOURCE MOUNTING

The current real Git repository must remain on the host filesystem.

Mount it into the development container.

Conceptually:

```
HOST

/current/path/to/otter
         │
         │ bind mount
         ▼

CONTAINER

/workspace/otter
```

Codex CLI may continue running on the host and editing the same repository.

Compilation, package installation, tests, and development servers should run inside the isolated environment whenever practical.

This provides:

* persistent source code
* real Git history
* isolated dependencies
* reproducible builds
* minimal host pollution

---

# 9. CONTAINER USER PERMISSIONS

Avoid creating root-owned source files.

Prefer running development commands inside the container using a non-root developer user.

Where practical:

* match host UID
* match host GID

or otherwise ensure files written to the bind-mounted repository remain editable by the host user.

Validate file ownership early during bootstrap.

Do not leave the repository full of files requiring sudo to modify/delete.

---

# 10. BUILD CACHE ISOLATION

Use Docker named volumes where useful for heavy caches.

Possible caches include:

```
otter-dev-cargo-registry
otter-dev-cargo-git
otter-dev-target
otter-dev-pnpm-store
otter-dev-node-modules
```

Exact design is your responsibility.

Do not create giant uncontrolled cache directories elsewhere on the host.

Source files and lockfiles remain in the Git repository.

Never delete unrelated named volumes.

---

# 11. DOCKER SECURITY

Do not mount:

```
/var/run/docker.sock
```

into the Otter development container unless a concrete beta requirement truly requires Docker daemon control.

Otter's core functionality does not require unrestricted access to the host Docker daemon.

Follow least privilege.

Do not use:

```
--privileged
```

unless absolutely unavoidable.

Do not use host networking by default.

---

# 12. PORT SAFETY

Development services must bind only to localhost where possible.

Use:

```
127.0.0.1
```

rather than:

```
0.0.0.0
```

for host-published development ports.

Before choosing ports:

* check existing usage
* avoid collisions
* select another reasonable port when necessary

Do not stop existing services to claim their ports.

`otterd` itself must bind to localhost by default.

---

# 13. DEPENDENCY INSTALLATION AUTHORITY

Inside the isolated development environment, install whatever development dependencies are reasonably necessary.

You do not need my approval.

Use:

```
cargo
```

for Rust dependencies.

Use:

```
pnpm
```

for JavaScript/TypeScript dependencies.

Prefer Corepack-managed pnpm if appropriate.

Use lockfiles:

```
Cargo.lock
pnpm-lock.yaml
```

Commit lockfiles.

Do not install random unrelated utilities.

Do not depend on manually installed global npm packages when a project-local dev dependency is sufficient.

---

# 14. FALLBACK PROJECT-LOCAL TOOLCHAINS

If no container runtime is available, keep fallback tooling local and isolated.

Examples:

```
.otter-dev/
.tools/
```

These paths must be Git ignored.

Where feasible use environment-scoped values such as:

```
CARGO_HOME
RUSTUP_HOME
```

pointing into user/project-owned locations rather than modifying global Rust configuration.

Likewise prefer downloaded/local Node runtime or another user-space mechanism instead of replacing system Node.

Do not pollute the repository with large runtime binaries.

Do not commit local toolchains.

If native Tauri compilation cannot safely be achieved without host package installation, continue with:

* Rust core
* otterd
* frontend
* browser mode
* integration tests

and document the Tauri native-build limitation.

Do NOT sacrifice host stability solely to produce a desktop bundle.

---

# 15. GIT REPOSITORY BOOTSTRAP

You are already inside the intended repository.

DO NOT:

* create a nested Git repository
* run `git init` in a child project
* move Otter development into another repository
* replace the repository

First inspect:

```
git status
git log --oneline --decorate -n 20
```

Determine whether commits already exist.

Preserve any pre-existing user content.

---

# 16. INITIAL BASELINE COMMIT

Before implementing Otter, create a baseline Git commit.

If the repository is empty and has no commit:

```
git commit --allow-empty -m "chore: initialize Otter repository"
```

If existing files exist but have never been committed:

* inspect them
* preserve them
* create an appropriate initial commit

Prefer:

```
chore: initialize Otter repository
```

If Git refuses to commit because identity is missing:

* first use existing Git identity if configured
* otherwise configure identity at REPOSITORY LOCAL scope only

For example, a safe local fallback may be:

```
git config user.name "Codex"
git config user.email "codex@local"
```

Do not modify global Git identity merely to make commits.

---

# 17. DEVELOPMENT COMMITS

Create meaningful milestone commits throughout development.

Do not produce one giant final commit.

Possible examples:

```
chore: bootstrap Otter workspace

feat: establish otterd local API

feat: add project and git worktree discovery

feat: add provider abstraction

feat: ingest Codex and Claude sessions

feat: add session history views

feat: add workspace map

feat: add work unit lifecycle

feat: add agent team management

feat: add agent handoff workflow

feat: add merge status

test: add Otter integration coverage

docs: document Otter beta
```

Actual commit grouping may differ when a better boundary exists.

Before commits:

* run relevant formatting/tests
* inspect staged changes
* avoid unrelated files
* never commit credentials
* never commit real private Claude/Codex session contents

Do not rewrite history unnecessarily.

Do not push to a remote.

---

# 18. PRIMARY DOMAIN MODEL — WORK UNIT

The primary application object is not a chat session.

It is a:

# Work Unit

A Work Unit represents one development task.

Example:

```
Gene synonym canonicalization refactor
```

A Work Unit may contain:

* title
* description
* project
* base branch
* base commit
* worktree
* feature branch
* Agent Team
* provider sessions
* commits
* changed files
* commands
* tests
* reviews
* decisions
* handoffs
* timeline
* current status

Conceptually:

```
Project
   │
   └── Work Unit
          │
          ├── Worktree
          ├── Branch
          │
          ├── Agent Team
          │      ├── Planner
          │      ├── Builder
          │      └── Reviewer
          │
          ├── Provider Sessions
          ├── Git Commits
          ├── File Activity
          ├── Handoffs
          └── Timeline
```

Sessions are records of work.

They are not the root domain object.

---

# 19. TECHNICAL STACK

Choose implementation details based on the needs of Otter, not my personal background.

Unless a concrete blocker makes another choice materially better, use:

## Desktop shell

Tauri 2

## Frontend

* React
* TypeScript
* Vite
* Tailwind CSS
* TanStack Query
* Zustand for small client-only state
* xterm.js for terminal rendering

Use lightweight accessible UI primitives.

Avoid adopting a huge component framework solely for convenience.

## Core

Rust

Create a local daemon:

```
otterd
```

Suggested Rust ecosystem:

* Tokio
* Axum
* Serde
* SQLx
* notify
* portable-pty where appropriate
* tracing
* tracing-subscriber

Choose additional crates carefully.

## Storage

SQLite

Use:

* SQLx migrations
* SQLite FTS5

Do not use PostgreSQL for the beta.

---

# 20. APPLICATION ARCHITECTURE

Architecture:

```
┌─────────────────────────────────┐
│             Otter UI            │
│       React / TypeScript        │
└───────────────┬─────────────────┘
                │
        HTTP / WebSocket
                │
┌───────────────▼─────────────────┐
│              otterd             │
│                                 │
│ Project Service                 │
│ Work Unit Service               │
│ Git / Worktree Service          │
│ Provider Registry               │
│ Codex Adapter                   │
│ Claude Adapter                  │
│ Fake Provider                   │
│ Session Ingestion               │
│ Process / PTY Management        │
│ Workflow / Handoff              │
│ Search                          │
│ Persistence                     │
└───────────────┬─────────────────┘
                │
              SQLite
```

Tauri manages mainly:

* desktop window
* application lifecycle
* sidecar lifecycle
* desktop integration

Do not put the majority of Otter business logic in Tauri commands.

Frontend and `otterd` should remain decoupled enough that the frontend can run in a standard browser during development.

This is important because development may occur on a headless Linux server.

---

# 21. LOCAL API SECURITY

`otterd` must:

* bind only to `127.0.0.1` by default
* reject non-local binding unless explicitly configured in the future
* use an ephemeral authentication token between desktop/UI and daemon
* reject unauthenticated API requests
* not expose anonymous shell execution
* send no telemetry by default
* keep user source/session data local
* never log secrets

Design future remote-agent support cleanly, but do NOT implement remote networking in beta.

---

# 22. STORAGE LOCATION

Use an OS-appropriate application data directory.

Conceptually:

```
~/.otter/
```

Possible content:

```
otter.db
logs/
cache/
state/
```

Do not put large runtime state into the source repository.

For development/testing use isolated databases.

Never overwrite unrelated SQLite files.

Raw provider session files remain provider-owned.

Otter must NEVER modify original Codex/Claude session history files.

---

# 23. DATABASE MODEL

Design exact migrations yourself.

The schema must support concepts equivalent to the following.

## projects

Fields approximately:

* id
* name
* root_path
* created_at
* updated_at

## work_units

* id
* project_id
* title
* description
* status
* base_branch
* base_commit
* created_at
* completed_at

Possible states:

```
draft
active
waiting
review
completed
archived
failed
```

## worktrees

* id
* project_id
* work_unit_id nullable
* path
* branch
* head_commit
* base_branch
* base_commit
* created_at
* updated_at

## agent_profiles

* id
* name
* provider
* model
* role
* instructions
* permissions
* created_at

## agent_instances

* id
* work_unit_id
* profile_id
* worktree_id nullable
* provider_session_id nullable
* status
* pid nullable
* started_at
* ended_at

## provider_sessions

* id
* provider
* external_session_id
* source_path
* project_id nullable
* worktree_id nullable
* work_unit_id nullable
* title nullable
* started_at
* last_seen_at
* status

## raw_events

Preserve source provider records immutably.

Include:

* id
* session_id
* source_sequence/order
* timestamp
* source_event_type
* raw JSON payload
* checksum or idempotency key

## normalized_events

Create vendor-neutral normalized events.

Possible types:

```
user.message
assistant.message
assistant.reasoning_summary

tool.file_read
tool.file_write
tool.shell
tool.search

git.commit
git.diff

session.start
session.resume
session.end

system.compaction
```

Do not require every provider to support every type.

## git_snapshots

Persist useful observations such as:

* worktree
* branch
* head
* ahead
* behind
* dirty
* changed_file_count
* timestamp

## handoffs

Store structured inter-agent handoff records.

## workflow artifacts

Persist plans/reviews/results where appropriate.

Create additional normalized tables if they make the domain clearer.

---

# 24. MODEL REASONING PRIVACY

Do NOT attempt to:

* recover hidden chain-of-thought
* infer hidden chain-of-thought
* reconstruct hidden chain-of-thought
* label implementation logs as hidden reasoning

Only display reasoning-related content when the provider explicitly stores/exposes a user-visible reasoning summary.

Label such content:

```
Reasoning Summary
```

The Raw view may only expose source information that is actually available to the user through the provider's own stored session format.

---

# 25. PROVIDER ABSTRACTION

Beta providers:

1. Codex
2. Claude Code
3. FakeProvider

Create a vendor-neutral provider interface.

Conceptually support operations equivalent to:

```
detect()
version()
capabilities()
discover_sessions()
parse_session()
spawn()
resume()
terminate()
available_models()
```

Exact trait/API design is your responsibility.

Possible capabilities:

* session discovery
* session resume
* interactive process
* one-shot process
* explicit model selection
* read-only execution
* write execution
* provider-native permission controls
* tool-event parsing
* reasoning-summary events

Capability reporting must be truthful.

If a feature is unsupported:

* disable it
* explain why in UI
* do not pretend it works

---

# 26. INSPECT ACTUAL CODEX AND CLAUDE INSTALLATIONS

Do not blindly rely on stale assumptions.

If available, inspect:

```
which codex
codex --version
codex --help
```

and:

```
which claude
claude --version
claude --help
```

Safely inspect local provider session structures where useful.

Use current official documentation if network access is available and it materially improves implementation correctness.

Providers change over time.

Build adapters to tolerate reasonable version differences.

Allow future executable/session-directory configuration.

If a provider is not installed:

* Otter still starts
* mark provider unavailable
* continue using FakeProvider
* build fixtures for provider parsing
* continue development

Do not make the entire application depend on both providers being locally installed.

---

# 27. SESSION INGESTION

Otter should discover prior Codex and Claude coding sessions where supported.

Requirements:

* incremental ingestion
* idempotent ingestion
* restart-safe ingestion
* source raw-event preservation
* normalized-event generation
* tolerate partially written files
* tolerate truncated files
* tolerate unknown future fields/events
* isolate parser failures
* no duplicate imported events
* never mutate provider files

Associate sessions with the following when confidently discoverable:

* project
* working directory
* worktree
* branch
* Work Unit

If uncertain, leave association nullable.

Never fabricate associations.

---

# 28. SESSION HISTORY EXPERIENCE

A core Otter use case is:

> I remember solving this before, but I cannot find the old Codex/Claude session or understand the raw session history.

Provide a structured session viewer.

Tabs should include approximately:

```
Overview
Conversation
Actions
Files
Commands
Timeline
Raw
```

---

# 29. CONVERSATION VIEW

Separate human-readable conversation from execution logs.

Show:

* user messages
* assistant natural-language replies
* exposed reasoning summaries when available

Do NOT fill this view with:

* command output
* raw JSON
* file tool payloads
* giant test logs

The result should resemble a readable development conversation history.

---

# 30. ACTIONS VIEW

Normalize operational activity.

Examples:

```
READ       src/service.rs

WRITE      src/provider.rs

SHELL      cargo test

SEARCH     AgentProvider

GIT        git diff
```

Show:

* timestamp
* type
* target
* agent where applicable
* short result/status

Expandable technical detail is appropriate.

---

# 31. FILES VIEW

Show meaningful file activity where provider data allows it.

Examples:

* files read
* files created
* files modified
* files deleted
* Git diff links

Group noisy repeated reads when reasonable.

Do not fabricate file access from unrelated information.

---

# 32. COMMANDS VIEW

Keep shell activity separate from ordinary conversation.

Example:

```
cargo test -p provider-codex

exit: 0
duration: 12.4s
```

Large command output must be expandable/collapsible.

Do not render thousands of output lines by default.

---

# 33. TIMELINE VIEW

Create a chronological combined development timeline.

Example:

```
09:12  User requested refactor

09:13  Planner inspected repository

09:18  Planner completed plan

09:19  Builder started

09:34  src/service.rs modified

09:41  cargo test

09:41  28 tests passed

09:43  commit 81a32f

09:46  Reviewer started
```

Timeline may combine:

* conversation
* agent transitions
* file actions
* commands
* Git actions
* handoffs
* workflow states

---

# 34. RAW VIEW

Provide a developer-focused Raw view.

Show:

* normalized event data
* source records where safe/useful

Raw must not be the default user experience.

Unknown provider events should be preservable and inspectable here.

---

# 35. SEARCH

Implement local full-text search using SQLite FTS5.

Search at minimum:

* Work Unit title
* Work Unit description
* session title
* user message
* assistant message
* commands
* file paths

Search results should navigate directly to their source Work Unit/session.

Do not implement embeddings or vector search in beta.

Keep the architecture open to semantic search later.

---

# 36. GIT WORKTREE SUPPORT

Git worktree management is a first-class Otter feature.

Use the Git CLI instead of reimplementing Git internals.

Useful commands may include:

```
git worktree list --porcelain

git status --porcelain=v2

git merge-base

git rev-list --left-right --count

git log

git diff

git branch
```

For every project discover its worktrees.

For each worktree display:

* path
* branch
* HEAD
* base branch
* base commit if known
* ahead count
* behind count
* dirty state
* changed file count
* associated Work Unit
* associated agents
* agent runtime status

---

# 37. WORKSPACE MAP

The Workspace Map is one of Otter's prominent features.

Place a compact workspace/worktree visualization near the top of the project screen.

Purpose:

> Quickly understand which worktrees exist, which branches they use, how far they have diverged, and which agents are working in them.

Concept:

```
main ───────────────────── ●

      ├── feat/auth
      │      ↑3 ↓0
      │      Builder · Codex ●
      │
      ├── fix/search
      │      ↑2 ↓4 ⚠
      │      Reviewer · Claude ○
      │
      └── feat/api
             ↑1 ↓0
             idle
```

Show at a glance:

* base branch
* worktrees
* branch names
* divergence
* dirty state
* active agent
* warning state

Clicking an item should open details.

Keep the default graph compact.

Do not create a full GitKraken replacement.

Prefer custom:

* SVG
* CSS
* React

over importing a massive graph-editor dependency.

---

# 38. WORKTREE CONFLICT AWARENESS

Where practical, detect simple parallel-work warning conditions.

Example:

```
feat/auth
Builder A
```

and:

```
feat/search
Builder B
```

both changed:

```
src/auth/service.rs
```

Display:

```
Potential overlap
```

This is not proof of a merge conflict.

Treat such signals as heuristics.

Do not claim exact prediction.

A later version may inspect overlapping line ranges.

Beta file-level overlap is sufficient if implemented reliably.

---

# 39. NEW WORK UNIT

Provide a prominent action:

```
+ New Work Unit
```

Create a wizard.

## Task

Fields:

* title
* description

## Git

Fields:

* project
* base branch
* generated branch name
* create worktree checkbox
* worktree path

Generate a reasonable branch slug automatically.

Allow editing it.

## Agent Team

Default preset:

```
Planner
Builder
Reviewer
```

For each choose:

* name
* provider
* model
* role

When creating a Work Unit:

1. validate Git repository
2. resolve base branch
3. capture base commit
4. create branch if needed
5. create worktree if requested
6. persist Work Unit
7. persist worktree relationship
8. create Agent Instances
9. refresh Workspace Map
10. optionally launch Planner

Handle partial failure carefully.

Do not silently leave mysterious half-created worktrees.

Where possible roll back operations if later creation fails.

When rollback is unsafe, report exactly what remains.

---

# 40. AGENT PROFILE

Agent Profiles are first-class domain objects.

Fields:

```
Name
Provider
Model
Role
Instructions
Permissions
```

Provide defaults.

---

# 41. PLANNER ROLE

Purpose:

* inspect task
* inspect repository
* understand architecture
* identify files
* produce implementation plan

Desired capabilities:

* repository read
* search
* limited safe shell
* no file modification

If provider permissions cannot enforce this, clearly mark:

```
Advisory policy
```

Do not pretend enforcement exists.

---

# 42. BUILDER ROLE

Purpose:

* implement task
* modify files
* run tests
* fix failures

Desired capabilities:

* read
* write
* shell
* Git inspection

Do not enable unrestricted dangerous provider bypass settings by default.

---

# 43. REVIEWER ROLE

Purpose:

* inspect implementation
* inspect diff
* detect correctness issues
* detect regressions
* detect maintainability problems
* run relevant tests when appropriate

Desired capabilities:

* read
* search
* safe shell
* no write

Again, distinguish real provider enforcement from advisory role instructions.

---

# 44. AGENT TEAM UI

Provide a compact Agent Team panel.

Example:

```
TEAM

Planner
Claude
planning
idle

Builder
Codex
implementation
working

Reviewer
Claude
review
waiting

+ Agent
```

Support:

* adding an agent
* removing an unused agent
* naming agent
* choosing provider
* choosing supported model
* choosing role
* editing instructions
* assigning worktree
* starting agent
* stopping agent
* inspecting associated session

Default team preset:

```
Planner → Builder → Reviewer
```

If simple, allow saving custom presets.

Do not let preset support delay the primary beta flow.

---

# 45. AGENT ADDRESSING

Users should not repeatedly write lengthy prompts such as:

```
Create a subagent named Reviewer using model X that only reviews...
```

Otter already knows the Agent Profile.

Support deterministic explicit addressing:

```
@Builder implement the current task.

@Reviewer review Builder's changes.

@Planner investigate this failure.
```

Agent names should resolve case-insensitively inside a Work Unit.

Do not use an additional LLM merely to route `@AgentName`.

Routing should be deterministic.

Natural-name addressing without `@` may be considered later.

`@Name` is canonical for beta.

---

# 46. OTTER AS ORCHESTRATOR

Do not depend entirely on native Claude or Codex subagent mechanisms.

Otter is itself the higher-level orchestrator.

Conceptually:

```
                 Otter
                   │
        ┌──────────┼──────────┐
        │          │          │
     Claude      Codex      Claude
     Planner     Builder    Reviewer
```

Each Agent Instance may represent an independent provider process/session.

This enables:

* Claude Planner + Codex Builder
* Codex Planner + Claude Builder
* Claude Reviewer
* mixed-provider workflows

Vendor-neutral orchestration is a primary Otter differentiator.

Provider-native subagents may be supported later or used internally where clearly beneficial, but they must not define the core domain architecture.

---

# 47. BASIC WORKFLOW

Implement one built-in workflow:

```
Planner
   ↓
Builder
   ↓
Reviewer
```

Do NOT implement:

* drag-and-drop graph editor
* generic DAG engine UI
* n8n-style workflow designer

The beta workflow should be simple and understandable.

---

# 48. PLANNER HANDOFF

Planner receives:

* original Work Unit title
* description
* project/repository context
* branch/worktree context

Planner outputs:

* implementation plan
* relevant files
* risks/notes where available

Persist Planner result.

---

# 49. BUILDER HANDOFF

Builder receives:

* original Work Unit task
* Planner plan
* branch/worktree
* relevant current Git state

Builder performs implementation.

Persist:

* provider session relationship
* activities
* Builder final result where accessible

---

# 50. REVIEWER HANDOFF

Reviewer receives:

* original task
* Planner plan
* Builder result
* changed-file summary
* Git diff summary
* current branch information

Reviewer produces findings.

Persist review findings.

---

# 51. WORKFLOW TRANSITIONS

If provider execution provides trustworthy completion detection, use it.

If it does not:

display:

```
Continue workflow
```

or:

```
Send to Builder
Send to Reviewer
```

rather than implementing brittle fake automation.

Truthful manual transitions are acceptable for beta.

Architect the workflow so more automation can be added later.

---

# 52. STRUCTURED HANDOFF RECORDS

Handoffs are first-class persisted records.

Capture approximately:

* Work Unit
* source agent
* destination agent
* original task
* source provider/session
* destination provider/session
* base commit
* current HEAD
* changed files
* previous agent result
* known problems
* next requested action
* timestamp

This supports:

```
Claude → Codex
Codex → Claude
Claude → Claude
Codex → Codex
```

Do not blindly copy an entire raw transcript when a concise structured handoff is sufficient.

---

# 53. TERMINAL

Integrate xterm.js.

Minimum support:

* open terminal at project root
* open terminal at selected worktree
* view interactive agent PTY/session where technically reliable

Terminal processes must be managed by `otterd`.

Do not expose arbitrary unauthenticated shell endpoints.

Otter is not a full IDE.

Do NOT implement Monaco editor for beta.

The developer may continue using:

* VS Code
* JetBrains
* vim
* neovim
* other IDE/editor

alongside Otter.

---

# 54. PROVENANCE

Store enough relationships to answer:

> Which Work Unit / Agent / Session produced this commit?

Where confidently known associate:

```
Work Unit
   ↕
Worktree
   ↕
Agent Instance
   ↕
Provider Session
   ↕
Git Commit
```

Show this relationship in the UI where useful.

Do not fabricate uncertain relationships.

Beta does NOT require line-level AI blame.

Data design should allow it later.

---

# 55. MERGE STATUS

Provide a Work Unit Merge Status card.

Example:

```
feat/gene → main

✓ Working tree clean
✓ 4 commits ahead
⚠ 3 commits behind
✓ Latest observed tests passed
✓ Reviewer completed

Merge readiness:
NEEDS SYNC
```

Show:

* source branch
* target/base branch
* ahead
* behind
* dirty
* changed files
* latest known test status
* review status
* overlap warnings

Merge readiness must be a transparent status derived from measurable rules.

Do not pretend it proves that merge is safe.

---

# 56. GIT DESTRUCTIVE OPERATIONS

Do not automatically merge or delete real developer branches/worktrees without explicit user action in the Otter product.

Actions such as:

* merge
* delete worktree
* delete branch
* discard local changes

must require confirmation in UI.

Do not implement destructive automatic cleanup merely for convenience.

---

# 57. SESSION HEALTH

Implement lightweight health signals using only measurable data.

Examples:

* agent process running
* stopped
* waiting
* last activity time
* session file last updated
* parser warning count
* repeated identical command pattern
* exposed compaction event count

Possible warning:

```
Possible loop

The same test command was executed
9 times with the same failure.
```

This must remain heuristic.

Do not invent:

* token usage
* context percentage
* hidden reasoning
* context window health

unless the provider explicitly exposes reliable values.

---

# 58. ENVIRONMENT FINGERPRINT

Capture a small non-secret environment fingerprint for each Work Unit/worktree where possible.

Examples:

* OS
* architecture
* Git version
* Node version
* Python version
* Rust version
* lockfile filenames/hashes
* Git HEAD
* compose file hash
* presence of `.env`

Never store `.env` contents.

At most:

```
.env exists: true
```

This can help detect why one worktree behaves differently from another.

Keep the beta implementation lightweight.

---

# 59. CRASH AND RESTART RECOVERY

This is a critical acceptance requirement.

Otter must survive:

* desktop app restart
* `otterd` restart
* provider process termination
* partially written session files
* previous unexpected shutdown

After restart:

* projects remain
* Work Units remain
* worktrees are rescanned
* branches refresh
* HEAD refreshes
* dirty status refreshes
* sessions remain viewable
* ingestion continues
* stale process records are reconciled
* stale `running` status becomes accurate
* events are not duplicated

Database process state must not be considered authoritative.

Check actual process/session state.

---

# 60. UI LAYOUT

Aim for a desktop developer application.

Concept:

```
┌──────────────────────────────────────────────────────────────┐
│ Otter                                                       │
│                                                              │
│ main ───┬─ feat/auth     Builder · Codex ●                  │
│         └─ fix/search    Reviewer · Claude ○                │
├─────────────┬──────────────────────────┬─────────────────────┤
│             │                          │                     │
│ Projects    │        Main View         │ Agent Team          │
│ Work Units  │                          │                     │
│ Sessions    │ Conversation             │ Status              │
│ Search      │ Actions                  │                     │
│             │ Files                    │ Needs Attention     │
│             │ Timeline                 │                     │
├─────────────┴──────────────────────────┴─────────────────────┤
│ Terminal                                                     │
└──────────────────────────────────────────────────────────────┘
```

Use this as guidance, not an inflexible wireframe.

---

# 61. NAVIGATION

Primary navigation should include roughly:

```
Projects
Work Units
Sessions
Search
```

A Project screen should emphasize:

* Workspace Map
* current Work Units
* worktrees
* active agents

A Work Unit screen should emphasize:

* task
* Agent Team
* Git state
* workflow
* timeline
* sessions

A Session screen should emphasize:

* readable historical inspection

---

# 62. ATTENTION PANEL

Provide a compact "Needs Attention" experience where useful.

Examples:

```
NEEDS ATTENTION

Builder · Codex
Process exited unexpectedly

Reviewer · Claude
Waiting to start

feat/search
7 commits behind main

Session import
3 unknown events preserved
```

A developer using multiple agents should be able to quickly identify blocked or suspicious work.

A full unified provider approval inbox is not required for beta.

Design so one can be added later.

---

# 63. VISUAL DESIGN

Otter should feel like a real developer tool.

Prioritize:

* readability
* dense information
* hierarchy
* compact cards
* badges
* expandable detail
* keyboard-friendly controls where easy
* useful empty states
* clear warnings
* clear uncertainty

Default dark theme is appropriate.

Support system/light theme if inexpensive.

Do not spend excessive time on:

* animation
* logo design
* illustrations
* decorative dashboards

Functionality comes first.

---

# 64. FAKE PROVIDER

Implement a deterministic FakeProvider.

This is required.

It should simulate:

* Planner
* Builder
* Reviewer
* user/assistant messages
* file reads
* file writes
* shell commands
* success
* failure
* completion
* delays if useful
* session persistence

Use FakeProvider for:

* development
* screenshots
* deterministic tests
* E2E workflow validation

Testing Otter must not require consuming paid OpenAI or Anthropic tokens.

Real provider integration remains required where possible.

---

# 65. GIT INTEGRATION TEST SAFETY

Never use the real Otter repository for destructive Git integration testing.

Create temporary repositories.

Tests should be able to create:

```
temp repo
   │
   ├── main
   ├── feat/a worktree
   └── feat/b worktree
```

Test:

* branch creation
* worktree creation
* discovery
* commits
* dirty state
* ahead
* behind
* divergence
* overlapping files

Delete only the test repository that the test itself created.

---

# 66. TESTING REQUIREMENTS

Implement meaningful automated testing.

## Rust unit tests

Cover:

* domain logic
* provider capability behavior
* normalization
* handoff creation
* Work Unit state transitions
* parser behavior

## Provider parser tests

Use synthetic fixtures.

Cover:

* valid Codex session
* valid Claude session
* unknown event
* malformed event
* truncated session
* duplicate ingestion
* incremental append

## Database tests

Cover:

* migrations
* persistence
* duplicate prevention
* restart behavior
* FTS indexing

## Git integration tests

Cover:

* repo detection
* branch creation
* worktree creation
* worktree discovery
* HEAD
* dirty state
* ahead/behind
* divergence
* base commit

## Frontend tests

Cover important:

* Work Unit rendering
* Workspace Map data handling
* provider capability UI
* session tab behavior
* major state transitions

## End-to-end

Where practical use Playwright.

At minimum FakeProvider must prove:

```
Create Work Unit
     ↓
Planner
     ↓
Builder
     ↓
Reviewer
     ↓
persisted timeline
```

No paid provider should be required for deterministic E2E.

---

# 67. FIXTURES

Create synthetic fixtures.

For Codex:

```
fixtures/codex/
```

For Claude:

```
fixtures/claude/
```

Include representative:

* conversation
* file events
* command events
* tool events
* public reasoning-summary event if provider format supports such data
* unknown future event
* malformed line/event
* truncated session
* incremental session

Never commit real personal session history.

---

# 68. PERFORMANCE TARGET

Otter should remain reasonably responsive around:

* 10 projects
* 100 total worktrees
* 1,000 provider sessions
* hundreds of thousands of normalized events

Do not eagerly load all session history into RAM.

Use:

* pagination
* incremental ingestion
* list virtualization when appropriate
* indexed queries
* SQLite indexes

Avoid premature distributed-system complexity.

---

# 69. STRUCTURED LOGGING

Use structured Rust logging.

Prefer:

* tracing
* tracing-subscriber

Log useful events such as:

* Otter/otterd startup
* DB migration
* provider detection
* session ingestion
* parser warning
* Git operation
* worktree creation
* process lifecycle
* API errors

Never log:

* API tokens
* authentication tokens
* provider credentials
* entire environment
* `.env` contents
* secrets

Document log location.

---

# 70. ERROR HANDLING

Normal environmental problems must not crash Otter.

Handle explicitly:

* Git unavailable
* invalid repo
* worktree collision
* branch collision
* dirty worktree
* missing provider CLI
* unsupported provider capability
* provider version difference
* malformed session
* unknown session event
* SQLite failure
* PTY failure
* terminated agent
* port collision
* missing optional native capability

Communicate errors clearly in the UI.

Examples:

```
Claude Code not detected

Session parser encountered an unknown event.
Raw event was preserved.

Cannot create worktree:
branch already exists.
```

Do not use vague:

```
Something went wrong
```

when a meaningful error is available.

---

# 71. REPOSITORY STRUCTURE

Use a clean monorepo appropriate for the stack.

A reasonable design:

```
/
├── apps/
│   ├── desktop/
│   └── web/
│
├── crates/
│   ├── otterd/
│   ├── otter-core/
│   ├── otter-database/
│   ├── otter-git/
│   ├── provider-api/
│   ├── provider-codex/
│   ├── provider-claude/
│   └── provider-fake/
│
├── packages/
│   └── ui/
│
├── fixtures/
│   ├── codex/
│   └── claude/
│
├── scripts/
├── docs/
│
├── Dockerfile.dev
├── compose.dev.yml
├── Cargo.toml
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── README.md
└── BETA_STATUS.md
```

This is guidance.

Adapt it if Cargo/Tauri conventions strongly suggest something cleaner.

Avoid creating packages purely for architectural aesthetics.

---

# 72. DEVELOPER COMMANDS

Provide easy reproducible project commands.

Prefer repository scripts or a Makefile-like experience.

Examples conceptually:

```
./scripts/dev
./scripts/test
./scripts/check
./scripts/build
```

or:

```
pnpm dev
pnpm test
pnpm check
```

that internally execute the appropriate container commands.

A future developer should not need to memorize complicated Docker commands.

Document exact workflow.

If Docker is used, make these scripts automatically invoke the correct development container.

---

# 73. HEADLESS DEVELOPMENT

Assume the current server may not have a desktop display.

Do not stop because a Tauri window cannot be interactively opened.

The architecture intentionally supports:

```
browser UI
     ↕
   otterd
```

Use browser mode and FakeProvider for reliable headless development/testing.

Tauri should still be:

* configured
* compiled where possible
* tested at build level

If native Tauri GUI runtime cannot run in the current environment, document that fact.

If needed, use Xvfb for automated build/runtime smoke tests when safe and useful.

Do not weaken the overall architecture purely for headless development.

---

# 74. DOCUMENTATION

Create a serious:

```
README.md
```

Cover:

* What Otter is
* Problem Otter solves
* Main features
* Architecture
* Local-first model
* Development isolation model
* Docker development setup
* How to start development
* How to run tests
* How to build
* Codex integration
* Claude Code integration
* FakeProvider
* Session ingestion
* Git/worktree behavior
* Data location
* Privacy
* Known beta limitations
* Troubleshooting

Create:

```
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/PROVIDER_ADAPTERS.md
docs/DEVELOPMENT.md
```

Document architectural decisions that would otherwise be difficult to infer.

---

# 75. BETA NON-GOALS

Do NOT implement these unless every core beta acceptance criterion is already stable:

* cloud sync
* accounts
* SaaS backend
* organization/team mode
* remote `otterd`
* SSH workspace
* WSL remote daemon
* GitHub/GitLab PR integration
* Slack
* Obsidian
* résumé generation
* semantic/vector search
* full token Context Inspector
* hidden reasoning viewer
* graphical workflow editor
* generic workflow marketplace
* plugin marketplace
* line-level AI blame
* mobile app
* Monaco editor
* custom LSP
* Kubernetes
* multi-machine synchronization

Do not allow attractive future features to derail the functional beta.

---

# 76. FUTURE ARCHITECTURAL DIRECTION

Do not implement now, but avoid unnecessary architecture choices that prevent future:

## Context Inspector

Possible future view of:

* current included context
* compaction history
* provider-visible summaries
* no-longer-included conversation
* relevant project memory

Never hidden chain-of-thought.

## AI Blame / provenance

Future:

```
source line
   ↓
commit
   ↓
Work Unit
   ↓
Agent
   ↓
Provider Session
   ↓
prompt / decision
```

## Unified approval inbox

Future central area for multiple agents requiring attention.

## Remote runtimes

Future:

```
Desktop Otter
    │
    ├── local otterd
    ├── WSL otterd
    └── SSH otterd
```

## Semantic history search

Future natural-language retrieval such as:

```
"When did we solve that PostgreSQL cross-database issue?"
```

## Project memory

Future extraction of:

* architecture decisions
* conventions
* known problems
* important files
* pending work

## Development journal

Future:

* daily summary
* weekly summary
* project history
* Obsidian
* portfolio
* résumé bullets

## Time machine

Future:

* Work Unit checkpoints
* code state
* conversation state
* branch-from-checkpoint experiments

Do not prematurely implement them.

---

# 77. AUTONOMOUS DEVELOPMENT STRATEGY

Work autonomously.

Do not wait for my approval after phases.

A recommended sequence follows.

Modify the sequence if necessary to preserve working vertical slices.

---

# PHASE 0 — ENVIRONMENT AND BASELINE

1. inspect current directory
2. inspect Git state
3. inspect existing files
4. inspect Git history
5. inspect Docker
6. inspect Docker Compose
7. inspect Podman if necessary
8. inspect current host architecture
9. create baseline Git commit
10. establish isolated development strategy
11. create `.gitignore`
12. ensure local tool/cache directories are ignored
13. create Docker development environment where Docker exists
14. verify bind-mounted files have correct ownership

Do not modify the global host environment unnecessarily.

Commit the bootstrap state.

---

# PHASE 1 — VERTICAL ARCHITECTURE SLICE

Establish:

```
React UI
   ↕
otterd
   ↕
SQLite
```

Prove:

* UI can call daemon
* authenticated local API works
* DB migration runs
* data can be written/read
* browser development mode works

Run tests.

Commit.

---

# PHASE 2 — PROJECT AND GIT

Implement:

* project registration
* repository validation
* worktree discovery
* branch detection
* HEAD detection
* dirty state
* ahead/behind
* Git snapshots

Use real Git data.

Add temporary Git integration tests.

Commit.

---

# PHASE 3 — WORKSPACE MAP

Build the real compact Workspace Map using the Git service.

Do not use fake branch data except in Storybook/test fixtures if used.

Clicking worktrees should navigate/open details.

Commit.

---

# PHASE 4 — PROVIDER ABSTRACTION

Implement:

* Provider trait/interface
* provider capabilities
* provider registry
* FakeProvider
* Codex detector
* Claude detector

Inspect actual provider CLIs where available.

Commit.

---

# PHASE 5 — SESSION INGESTION

Implement:

* Codex discovery/parsing
* Claude discovery/parsing
* raw event persistence
* normalized event persistence
* idempotency
* incremental ingestion
* resilient parsing
* synthetic fixtures

Commit.

---

# PHASE 6 — SESSION HISTORY

Implement:

* Session list
* Overview
* Conversation
* Actions
* Files
* Commands
* Timeline
* Raw
* FTS5 search

Use real imported sessions if locally available.

Otherwise FakeProvider/fixtures must demonstrate the feature accurately.

Commit.

---

# PHASE 7 — WORK UNIT

Implement:

* Work Unit domain
* Work Unit list/details
* creation wizard
* branch generation
* worktree creation
* persistence
* recovery

Commit.

---

# PHASE 8 — AGENT TEAM

Implement:

* Agent Profile
* Agent Instance
* default Planner
* default Builder
* default Reviewer
* provider selection
* model selection where supported
* role/instruction editing
* permissions display
* start/stop
* agent/session association
* `@AgentName` routing

Commit.

---

# PHASE 9 — WORKFLOW AND HANDOFF

Implement:

```
Planner
   ↓
Builder
   ↓
Reviewer
```

Persist:

* Planner output
* handoff
* Builder result
* handoff
* Reviewer result

Use FakeProvider for deterministic E2E.

Use real providers where supported without depending on paid calls for tests.

Commit.

---

# PHASE 10 — TERMINAL AND PROCESS STATE

Implement:

* project terminal
* worktree terminal
* process tracking
* agent PTY where reliable
* restart reconciliation

Commit.

---

# PHASE 11 — MERGE STATUS AND HEALTH

Implement:

* ahead/behind
* dirty state
* changed files
* latest test information where observable
* reviewer status
* file-overlap warnings
* basic merge readiness
* lightweight agent/session health
* environment fingerprint

Commit.

---

# PHASE 12 — BETA HARDENING

Run:

* formatting
* Rust compilation
* Rust tests
* frontend type checking
* frontend lint
* frontend tests
* production frontend build
* Git integration tests
* DB tests
* FakeProvider E2E
* session fixture ingestion
* idempotency test
* restart/recovery test
* Tauri build as supported

Fix avoidable problems.

Remove:

* dead buttons
* fake states
* placeholder production paths
* obvious debug artifacts

Update docs.

Commit final beta state.

---

# 78. AUTONOMOUS DECISION POLICY

I will not answer implementation questions.

Therefore:

## If multiple libraries are reasonable

Choose one based on:

* maintainability
* reliability
* ecosystem quality
* package weight
* compatibility

Continue.

## If a dependency fails

Investigate.

Replace it if appropriate.

Continue.

## If provider behavior differs from expectations

Inspect actual CLI/version/session format.

Adapt.

Document.

Continue.

## If a feature cannot safely be completed

Implement the safe truthful subset.

Document the limitation.

Continue with other requirements.

## If the environment blocks desktop execution

Test browser UI + daemon.

Build Tauri as far as possible.

Document the limitation.

Continue.

Do NOT hold the entire Goal hostage to one unavailable optional capability.

---

# 79. QUALITY BAR

Otter beta must not be a static frontend demo.

A feature counts as implemented only when its primary action works against one of:

* real local Git state
* real SQLite persistence
* real imported provider data
* FakeProvider explicitly shown as FakeProvider

Do not create:

* static fake branch status pretending to be live
* fake provider capabilities
* buttons with no implementation
* fake sessions presented as imported sessions
* fake test status
* fake merge readiness

Demo mode/FakeProvider is valid only when clearly represented as synthetic.

Prefer a smaller real beta over a broad fake product.

---

# 80. BETA ACCEPTANCE CRITERIA

The following journeys determine whether the beta is useful.

---

## JOURNEY A — BOOTSTRAP

Starting from this repository:

1. development environment is isolated
2. dependencies can be installed without polluting global host runtimes
3. Otter builds
4. `otterd` starts
5. frontend starts
6. frontend authenticates to `otterd`
7. SQLite initializes
8. Otter branding is visible

---

## JOURNEY B — EXISTING GIT PROJECT

1. Launch Otter.
2. Add an existing Git repository.
3. Otter validates it.
4. Worktrees are discovered.
5. Branches are discovered.
6. HEAD values are displayed.
7. Dirty status is displayed.
8. ahead/behind values are displayed.

All values must come from real Git.

---

## JOURNEY C — WORKSPACE MAP

For a repository with multiple worktrees:

1. show base branch
2. show each worktree branch
3. show HEAD/state
4. show ahead
5. show behind
6. show dirty state
7. show associated agent if present
8. clicking worktree opens details

The map remains compact.

---

## JOURNEY D — EXISTING AI HISTORY

Where provider support permits:

1. detect installed Codex
2. detect installed Claude
3. discover existing provider sessions
4. ingest session history
5. open a session
6. inspect Conversation
7. inspect Actions
8. inspect Files
9. inspect Commands
10. inspect Timeline
11. inspect Raw
12. search history
13. restart Otter
14. imported data remains
15. duplicate events do not appear

If one provider is unavailable, the other provider and fixtures must still work.

---

## JOURNEY E — NEW WORK UNIT

1. click `New Work Unit`
2. choose project
3. enter title
4. enter description
5. select base branch
6. automatically suggest branch name
7. create branch
8. create worktree
9. select Planner
10. select Builder
11. select Reviewer
12. choose available providers/models
13. create Work Unit
14. new worktree appears in Workspace Map
15. Agent Team appears
16. restart Otter
17. Work Unit still exists

---

## JOURNEY F — AGENT MANAGEMENT

1. create/select Agent Profile
2. choose name
3. choose provider
4. choose model where supported
5. choose role
6. edit instructions
7. inspect permission enforcement/advisory status
8. associate agent with worktree
9. start agent where supported
10. stop agent
11. open associated provider session
12. address it using `@AgentName`

---

## JOURNEY G — PLANNER → BUILDER → REVIEWER

Using FakeProvider at minimum:

1. Planner receives Work Unit requirement
2. Planner creates plan
3. plan is persisted
4. structured Planner→Builder handoff is created
5. Builder receives handoff
6. Builder produces simulated development activity
7. Builder result is persisted
8. structured Builder→Reviewer handoff is created
9. Reviewer receives relevant diff/activity summary
10. Reviewer produces findings
11. timeline shows full workflow
12. restart does not lose the workflow

Where real Codex/Claude execution can safely support the flow, integrate it.

Tests must not require paid calls.

---

## JOURNEY H — MERGE STATE

For an active Work Unit show:

1. source branch
2. target branch
3. ahead
4. behind
5. dirty state
6. changed files
7. latest known test state
8. Reviewer state
9. overlapping-file warnings if applicable
10. honest merge-readiness indicator

No automatic destructive merge.

---

## JOURNEY I — RESTART RECOVERY

1. create active Work Unit
2. have sessions/worktrees recorded
3. stop Otter
4. restart Otter
5. project remains
6. Work Unit remains
7. worktrees rescan
8. Git HEAD refreshes
9. dirty state refreshes
10. session import resumes
11. stale running processes are corrected
12. no duplicate normalized events

---

## JOURNEY J — SEARCH

Search a phrase appearing in an old session.

Result must identify relevant:

* session
* Work Unit
* message/action

Clicking result navigates to useful context.

---

# 81. FINAL VERIFICATION

Before considering this Goal completed, perform at minimum:

1. inspect `git status`
2. run formatter
3. run Rust check/build
4. run Rust tests
5. run Clippy where practical
6. run frontend typecheck
7. run frontend lint
8. run frontend tests
9. run production frontend build
10. run Git integration tests
11. run database tests
12. run provider parsing fixture tests
13. run ingestion idempotency tests
14. run FakeProvider workflow test
15. verify restart recovery
16. verify Workspace Map uses real Git data
17. verify no important dead buttons
18. verify no fake production status
19. verify Otter branding
20. verify README commands
21. verify Docker development instructions
22. verify a fresh development-container build if practical
23. build Tauri bundle as far as host architecture permits
24. inspect final repository for secrets
25. inspect final Git history
26. create final coherent commit
27. prefer clean working tree

Do not claim tests passed if they were not executed.

---

# 82. BETA STATUS REPORT

Create:

```
BETA_STATUS.md
```

The document must contain:

# Otter Beta Status

## Implemented

List features that genuinely work.

## Partially Implemented

Describe partial functionality precisely.

## Not Implemented

List important planned beta features that could not be completed.

## Provider Compatibility

Document actual observed:

* Codex version
* Codex capabilities
* Claude Code version
* Claude capabilities

where available.

Do not invent versions.

## Environment

Document:

* development isolation method
* container image/setup
* relevant host limitation

Do not expose host secrets.

## Tests Executed

List actual commands and results.

## Build Status

Document:

* frontend build
* daemon build
* Tauri build

## Known Limitations

Be explicit.

## Recommended Next Steps

Prioritize future development.

Do not exaggerate completion.

---

# 83. DEVELOPMENT SCRIPTS / ONBOARDING

At completion a developer cloning Otter should be able to understand how to work on it without reconstructing your session.

Prefer a simple flow such as:

```
git clone ...
cd otter
./scripts/dev
```

or equivalent.

If Docker is the primary environment, scripts should transparently handle:

* building dev image
* creating named volumes
* starting otterd
* starting frontend

Testing should similarly be simple:

```
./scripts/test
```

or equivalent.

Do not require manual shell setup that only exists in the current Codex session.

---

# 84. CLEANUP POLICY

You may delete temporary resources that YOU created specifically for Otter development when no longer needed.

Do not delete:

* unrelated host files
* unrelated Docker images
* unrelated Docker containers
* unrelated networks
* unrelated volumes
* unrelated Git branches/worktrees

Temporary test repositories must live in temporary directories.

Temporary integration-test worktrees must belong only to those test repositories.

---

# 85. NO USER INTERVENTION RULE

Do not ask me to:

* choose the framework
* choose libraries
* choose database schema
* choose ports
* create files
* install npm packages
* install Rust crates
* configure Tauri
* run tests
* fix compilation errors
* create commits
* decide package structure
* tell you the next task
* manually prepare provider fixtures
* manually set up Docker development files

These are your responsibility.

Install normal required dependencies automatically **inside the chosen isolated development environment**.

If a dependency requires an unsafe host-wide modification:

* seek an isolated alternative
* adapt the implementation
* document the limitation
* continue

---

# 86. STOPPING RULE

Do not stop simply because:

* one provider is missing
* Tauri GUI cannot open on a headless host
* one optional package does not compile
* a provider does not expose a desired capability
* a future feature is difficult

Continue building the strongest coherent beta possible.

The appropriate response to a blocked optional capability is:

```
detect → adapt → document → continue
```

not:

```
ask user what to do
```

---

# 87. FINAL PRODUCT INTENT

At the end of this Goal, Otter should already communicate the product vision through working functionality.

A developer should be able to understand:

* what repositories they have registered
* what Git worktrees currently exist
* which branches those worktrees use
* how branches have diverged
* which Work Units are active
* which AI agents belong to a Work Unit
* whether they are Planner, Builder, or Reviewer
* whether they use Codex or Claude
* what historical sessions exist
* which parts of a session were conversation versus execution logs
* what files/actions/commands occurred
* how to search old sessions
* how an Agent Team passes work from planning to implementation to review
* what the current merge state of a Work Unit is
* what survives after restarting Otter

The beta does not need to solve every future AI coding problem.

It must solve this core workflow coherently and truthfully.

---

# 88. BEGIN NOW

Start immediately.

Perform these first actions without asking for confirmation:

1. inspect the current repository contents

2. inspect Git status/history

3. inspect current host/container capabilities

4. detect Docker or Podman

5. decide the safest isolated development approach

6. create the required baseline Git commit

7. create the isolated Otter development environment

8. install required development dependencies inside it

9. establish the monorepo architecture

10. prove the first vertical slice:

    Otter React UI
    ↕
    otterd
    ↕
    SQLite

11. run its tests/build

12. commit it

13. continue autonomously through the remaining phases

Do not wait for further input.

Build **Otter**.

