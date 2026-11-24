-- Final rehearsal-only schema, verified from source migrations. Empty independent DB only.
CREATE TABLE rehearsal_write_guards (id TEXT PRIMARY KEY, allowed INTEGER NOT NULL CHECK(allowed=1));
CREATE TABLE "rehearsal_projects" (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published','ended')),
 revision INTEGER NOT NULL, script_version TEXT NOT NULL, deck_version TEXT NOT NULL, algorithm_version TEXT NOT NULL,
 document_json TEXT NOT NULL CHECK(json_valid(document_json)), updated_at TEXT NOT NULL,
 password_hash TEXT,credential_version INTEGER NOT NULL DEFAULT 0,published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),deleted_at TEXT
);
CREATE TABLE "rehearsal_versions" (
 project_id TEXT NOT NULL REFERENCES "rehearsal_projects"(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)), changed_at TEXT NOT NULL,
 PRIMARY KEY(project_id,revision)
);
CREATE TABLE "rehearsal_members" (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES "rehearsal_projects"(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1))
);
CREATE TABLE "rehearsal_files" (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES "rehearsal_projects"(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('audio','slide','pptx')), mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0 AND bytes<=20971520),
 hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE "rehearsal_file_chunks" (
 file_id TEXT NOT NULL REFERENCES "rehearsal_files"(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), data BLOB NOT NULL CHECK(length(data)>0 AND length(data)<=524288),
 PRIMARY KEY(file_id,chunk_index)
);
CREATE TABLE "rehearsal_recordings" (
 id TEXT PRIMARY KEY REFERENCES "rehearsal_files"(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES "rehearsal_projects"(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES "rehearsal_members"(id), turn_id TEXT NOT NULL,
 script_version TEXT NOT NULL, deck_version TEXT NOT NULL, algorithm_version TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'ready' CHECK(status='ready'), duration_ms INTEGER NOT NULL CHECK(duration_ms>0 AND duration_ms<=10800000),
 submitted_at TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN(0,1)), complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN(0,1)),
 predicted_seconds REAL NOT NULL CHECK(predicted_seconds>=0), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 events_json TEXT NOT NULL CHECK(json_valid(events_json)), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
 request_hash TEXT NOT NULL
);
CREATE TABLE "rehearsal_estimates" (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES "rehearsal_projects"(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, algorithm_version TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), calculated_at TEXT NOT NULL
);
CREATE TABLE "rehearsal_turn_progress" (
 project_id TEXT NOT NULL REFERENCES "rehearsal_projects"(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES "rehearsal_members"(id), turn_id TEXT NOT NULL,
 script_version TEXT NOT NULL, deck_version TEXT NOT NULL, submitted_at TEXT NOT NULL,
 PRIMARY KEY(project_id,member_id,turn_id,script_version,deck_version)
);
CREATE TABLE rehearsal_access_sessions(token_hash TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,credential_version INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX idx_rehearsal_members_project ON rehearsal_members(project_id,enabled);
CREATE INDEX idx_rehearsal_files_project ON rehearsal_files(project_id,kind);
CREATE INDEX idx_rehearsal_recordings_recent ON rehearsal_recordings(project_id,member_id,turn_id,submitted_at DESC);
CREATE INDEX rehearsal_sessions_project ON rehearsal_access_sessions(project_id);
CREATE TRIGGER rehearsal_guard_cleanup AFTER INSERT ON rehearsal_write_guards BEGIN DELETE FROM rehearsal_write_guards WHERE id=NEW.id; END;
CREATE TRIGGER rehearsal_locked_limit BEFORE INSERT ON rehearsal_recordings
WHEN (SELECT count(*) FROM rehearsal_recordings WHERE project_id=NEW.project_id AND member_id=NEW.member_id AND turn_id=NEW.turn_id AND locked=1)>=3
BEGIN SELECT RAISE(ABORT,'rehearsal_turn_locked'); END;
CREATE TRIGGER rehearsal_keep_three AFTER INSERT ON rehearsal_recordings BEGIN
 DELETE FROM rehearsal_files WHERE id IN (SELECT id FROM rehearsal_recordings WHERE project_id=NEW.project_id AND member_id=NEW.member_id AND turn_id=NEW.turn_id AND locked=0 ORDER BY submitted_at ASC,id ASC LIMIT MAX(0,(SELECT count(*) FROM rehearsal_recordings WHERE project_id=NEW.project_id AND member_id=NEW.member_id AND turn_id=NEW.turn_id)-3));
END;
CREATE TRIGGER rehearsal_delete_audio AFTER DELETE ON rehearsal_recordings BEGIN DELETE FROM rehearsal_files WHERE id=OLD.id; END;
CREATE TRIGGER rehearsal_mark_turn_submitted AFTER INSERT ON rehearsal_recordings BEGIN
 INSERT INTO rehearsal_turn_progress VALUES(NEW.project_id,NEW.member_id,NEW.turn_id,NEW.script_version,NEW.deck_version,NEW.submitted_at)
 ON CONFLICT(project_id,member_id,turn_id,script_version,deck_version) DO UPDATE SET submitted_at=MAX(submitted_at,excluded.submitted_at);
END;
