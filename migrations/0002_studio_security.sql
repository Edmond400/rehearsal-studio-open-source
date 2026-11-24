ALTER TABLE rehearsal_projects ADD COLUMN archived_at TEXT;
CREATE TABLE studio_owner_credentials(project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,secret_digest TEXT NOT NULL,credential_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE studio_sessions(token_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN('owner','editor')),credential_version INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX studio_sessions_project ON studio_sessions(project_id);
CREATE TABLE studio_usage(project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,max_bytes INTEGER NOT NULL DEFAULT 62914560 CHECK(max_bytes BETWEEN 0 AND 94371840));
CREATE TABLE studio_audit(id TEXT PRIMARY KEY,project_id TEXT REFERENCES rehearsal_projects(id) ON DELETE CASCADE,actor_role TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE studio_limits(scope_hash TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX studio_limits_expiry ON studio_limits(expires_at);
CREATE TABLE studio_challenges(nonce TEXT PRIMARY KEY,anonymous_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE studio_creation_requests(request_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
CREATE TABLE studio_settings(id TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TRIGGER studio_quota BEFORE INSERT ON rehearsal_files WHEN
 NEW.bytes+COALESCE((SELECT SUM(bytes) FROM rehearsal_files WHERE project_id=NEW.project_id),0)>COALESCE((SELECT max_bytes FROM studio_usage WHERE project_id=NEW.project_id),0)
 OR NEW.bytes+COALESCE((SELECT SUM(bytes) FROM rehearsal_files),0)>188743680
 BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded');END;
CREATE TRIGGER studio_max_projects BEFORE INSERT ON rehearsal_projects WHEN (SELECT COUNT(*) FROM rehearsal_projects)>=100
 BEGIN SELECT RAISE(ABORT,'studio_project_limit');END;
