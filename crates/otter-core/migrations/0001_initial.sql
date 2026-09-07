CREATE TABLE projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
 base_branch TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE work_units (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
 base_branch TEXT NOT NULL, base_commit TEXT NOT NULL, branch TEXT NOT NULL,
 worktree_path TEXT NOT NULL, environment_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE worktrees (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 work_unit_id TEXT REFERENCES work_units(id), path TEXT NOT NULL UNIQUE,
 branch TEXT, head_commit TEXT, base_branch TEXT, base_commit TEXT,
 state_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE git_snapshots (
 id INTEGER PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES worktrees(id),
 state_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX snapshots_worktree ON git_snapshots(worktree_id, id DESC);
CREATE TABLE agent_profiles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT,
 role TEXT NOT NULL, instructions TEXT NOT NULL, permissions TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE agent_instances (
 id TEXT PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
 profile_id TEXT NOT NULL REFERENCES agent_profiles(id), name TEXT NOT NULL,
 worktree_id TEXT REFERENCES worktrees(id), provider_session_id TEXT,
 status TEXT NOT NULL DEFAULT 'idle', pid INTEGER, started_at TEXT, ended_at TEXT,
 result TEXT, error TEXT,
 UNIQUE(work_unit_id, name COLLATE NOCASE)
);
CREATE TABLE provider_sessions (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_session_id TEXT NOT NULL,
 source_path TEXT, project_id TEXT REFERENCES projects(id),
 worktree_id TEXT REFERENCES worktrees(id), work_unit_id TEXT REFERENCES work_units(id),
 agent_id TEXT REFERENCES agent_instances(id), title TEXT NOT NULL, cwd TEXT,
 started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, status TEXT NOT NULL,
 warning_count INTEGER NOT NULL DEFAULT 0,
 UNIQUE(provider, external_session_id)
);
CREATE TABLE raw_events (
 id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES provider_sessions(id),
 source_sequence INTEGER NOT NULL, timestamp TEXT, source_event_type TEXT,
 raw_json TEXT NOT NULL, checksum TEXT NOT NULL,
 UNIQUE(session_id, source_sequence, checksum)
);
CREATE TABLE normalized_events (
 id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES provider_sessions(id),
 raw_event_id INTEGER REFERENCES raw_events(id), timestamp TEXT NOT NULL,
 kind TEXT NOT NULL, text TEXT NOT NULL, target TEXT, detail_json TEXT NOT NULL DEFAULT '{}',
 UNIQUE(raw_event_id, kind, text, target)
);
CREATE INDEX events_session ON normalized_events(session_id, id);
CREATE TABLE ingestion_cursors (
 source_path TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL,
 byte_offset INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0,
 prefix_hash TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE handoffs (
 id TEXT PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
 source_agent_id TEXT NOT NULL REFERENCES agent_instances(id),
 destination_agent_id TEXT NOT NULL REFERENCES agent_instances(id),
 payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
 agent_id TEXT REFERENCES agent_instances(id), session_id TEXT REFERENCES provider_sessions(id),
 kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE timeline (
 id INTEGER PRIMARY KEY, work_unit_id TEXT NOT NULL REFERENCES work_units(id),
 agent_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);
CREATE TABLE processes (
 id TEXT PRIMARY KEY, work_unit_id TEXT REFERENCES work_units(id), agent_id TEXT,
 kind TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER, status TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE VIRTUAL TABLE search_index USING fts5(kind UNINDEXED, source_id UNINDEXED,
 session_id UNINDEXED, work_unit_id UNINDEXED, text, tokenize='unicode61');
CREATE TRIGGER work_search_insert AFTER INSERT ON work_units BEGIN
 INSERT INTO search_index(kind,source_id,work_unit_id,text)
 VALUES('work_unit',new.id,new.id,new.title || ' ' || new.description);
END;
CREATE TRIGGER work_search_update AFTER UPDATE OF title,description ON work_units BEGIN
 DELETE FROM search_index WHERE kind='work_unit' AND source_id=new.id;
 INSERT INTO search_index(kind,source_id,work_unit_id,text)
 VALUES('work_unit',new.id,new.id,new.title || ' ' || new.description);
END;
CREATE TRIGGER session_search_insert AFTER INSERT ON provider_sessions BEGIN
 INSERT INTO search_index(kind,source_id,session_id,work_unit_id,text)
 VALUES('session',new.id,new.id,new.work_unit_id,new.title);
END;
CREATE TRIGGER event_search_insert AFTER INSERT ON normalized_events BEGIN
 INSERT INTO search_index(kind,source_id,session_id,work_unit_id,text)
 VALUES(new.kind,new.id,new.session_id,
 (SELECT work_unit_id FROM provider_sessions WHERE id=new.session_id),
 new.text || ' ' || coalesce(new.target,''));
END;
