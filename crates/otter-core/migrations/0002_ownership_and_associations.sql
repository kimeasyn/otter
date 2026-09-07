PRAGMA application_id = 1330926674;
CREATE INDEX sessions_cwd ON provider_sessions(cwd);
CREATE INDEX sessions_work ON provider_sessions(work_unit_id);
CREATE INDEX agents_work ON agent_instances(work_unit_id);
CREATE INDEX timeline_work ON timeline(work_unit_id,id DESC);
CREATE TRIGGER session_search_update AFTER UPDATE OF title,work_unit_id ON provider_sessions BEGIN
 UPDATE search_index SET text=new.title,work_unit_id=new.work_unit_id
 WHERE kind='session' AND source_id=new.id;
 UPDATE search_index SET work_unit_id=new.work_unit_id
 WHERE session_id=new.id AND kind!='session';
END;
