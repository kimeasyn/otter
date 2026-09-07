# Otter data model

The migration SQL under `crates/otter-core/migrations` is authoritative.

| Object            | Purpose and relationships                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| projects          | Unique canonical Git root, display name, base branch                                                |
| work_units        | Task, status, project, captured base commit, feature branch, worktree and environment fingerprint   |
| worktrees         | Discovered path, branch, HEAD and latest Git observation; optional Work Unit                        |
| git_snapshots     | Persisted observations when a worktree's Git state changes                                          |
| agent_profiles    | Provider, optional model, role, instructions and permission policy                                  |
| agent_instances   | Profile assigned to a Work Unit/worktree; current process/session/result state                      |
| provider_sessions | Native or managed session, source file, optional confirmed project/worktree/unit/agent associations |
| raw_events        | Immutable stored provider records with sequence and checksum identity                               |
| normalized_events | Vendor-neutral conversation, tools, public summaries and session events                             |
| ingestion_cursors | Per-file committed byte offset, sequence and prefix fingerprint                                     |
| handoffs          | Structured source/destination agents, task, Git context, results and session links                  |
| artifacts         | Persisted plans, builder results and reviewer findings                                              |
| timeline          | Work Unit creation, agent lifecycle and workflow transitions                                        |
| processes         | Observations of daemon-owned agent/terminal processes; PIDs are not durable authority               |
| search_index      | SQLite FTS5 index of tasks, session titles, messages, commands and paths                            |

Foreign keys enforce ownership relationships. Partial uniqueness permits at most
one non-completed, non-archived Work Unit per worktree. A profile is copied when
assigned/edited so other teams do not silently change. Used agents cannot be
deleted because their provenance must survive. Archiving does not delete Git data.

Source record insertion and normalized events commit with the ingestion cursor.
The `(session_id, source_sequence, checksum)` constraint makes repeated imports
idempotent. Unknown/malformed records remain in Raw, and partial final records
remain outside the cursor until complete. History is paginated instead of loaded
all at once. FTS triggers update task/session indexing and preserve useful navigation.

Work Unit states: draft, active, waiting, review, completed, failed and archived.
Allowed transitions are in `work::transition_allowed`; the API rejects invalid
transitions. Running agent state is maintained from owned execution handles, and
unattachable state becomes interrupted on restart.

Environment fingerprints contain only OS/architecture, tool versions, selected
lockfile hashes, HEAD and whether `.env` exists. They never contain `.env` values.
