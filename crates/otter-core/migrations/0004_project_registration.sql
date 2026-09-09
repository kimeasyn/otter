-- Unregister projects without deleting repositories or their history.
ALTER TABLE projects ADD COLUMN removed_at TEXT;
