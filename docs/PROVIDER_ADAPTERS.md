# Provider adapters

Otter normalizes locally available records through `ProviderAdapter`, while
preserving each source record in SQLite. Raw provider files are never modified.
Unknown records remain inspectable. Claude thinking blocks and Codex encrypted
reasoning are not transformed into visible reasoning; only explicit public Codex
summaries are shown as **Reasoning Summary**.

## Observed compatibility (2026-09-07)

- Host Codex: `codex-cli 0.153.4`. Inspected `--help` and `exec --help`.
  Supports noninteractive `exec --json`, explicit `--sandbox`, model selection,
  stdin prompts and output-last-message. Existing local JSONL session structures
  include `session_meta`, `response_item`, `event_msg`, and unknown future records.
- Host Claude Code: not installed. Parsing uses synthetic JSONL fixtures; runtime
  availability is determined by CLI detection, never assumed.
- FakeProvider: explicitly synthetic and deterministic; no paid requests.

The Codex adapter was checked against the installed CLI and the official
[noninteractive execution documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
Otter uses least-privilege explicit sandbox settings for managed execution.
Detection checks the required structured-output and safety flags in `exec --help`
(Codex) or `--help` (Claude). Unsupported CLI versions cannot start managed agents,
but their existing session files can still be imported.
Managed Codex execution uses `--ephemeral`: Otter stores the JSONL stream and native
thread identifier in its own database, avoiding duplicate imports of the same
managed run from provider rollout files. Existing external sessions remain read-only.
Native resume and interactive agent PTY support remain disabled. Model catalog discovery is not assumed: an empty catalog means the
provider account's available models have not been established.

The Claude command shape follows the official [CLI reference](https://code.claude.com/docs/en/cli-reference):
print/verbose stream JSON, default permission mode, and no session persistence.
Planner/Reviewer limit built-in tools to Read/Glob/Grep, but this is not an OS
sandbox and does not restrict configured MCP tools. The UI therefore calls its
role policy advisory. Provider-native session IDs are retained from init records.
No installed Claude runtime or paid Claude model execution was verified here.

## Configuration

Optional daemon environment variables:

- `OTTER_CODEX_BIN`, `OTTER_CLAUDE_BIN`: executable paths.
- `OTTER_CODEX_SESSIONS`, `OTTER_CLAUDE_SESSIONS`: JSONL discovery roots.
- `OTTER_AUTO_IMPORT=0`: disable background provider history import.

Default roots are `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`
(`~/.codex` when unset), and `~/.claude/projects`. Background imports run every
10 seconds in bounded batches. Explicit imports accept a JSONL file path through
the authenticated UI. Tests use only fixtures under `fixtures/`.

## Persistence and boundaries

Each source has a persisted byte cursor, record sequence, and prefix fingerprint.
One SQLite transaction commits raw records, normalized events, FTS entries and
the cursor. Unfinished final lines are retried. Truncation resets the cursor;
the `(session, sequence, checksum)` identity prevents reimporting unchanged records.
Each batch is bounded to 500 records / approximately 8 MiB, with a 4 MiB per-line
limit that reports an error instead of consuming unbounded memory.

Local paths, prompts and raw records are private application data, not logs or
repository fixtures. Otter does not recover or infer hidden model reasoning.
