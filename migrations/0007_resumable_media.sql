-- Temporary uploads reserve full capacity before receiving bytes.
-- Finalized media keeps the existing file ID, SHA-256 and 512 KiB chunk format.
CREATE TABLE rehearsal_media_uploads (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('pptx','audio')),
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 20971520),
 hash TEXT NOT NULL CHECK(length(hash)=64),
 next_part INTEGER NOT NULL DEFAULT 0 CHECK(next_part BETWEEN 0 AND 80),
 hash_state TEXT,
 verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
 reserved INTEGER NOT NULL DEFAULT 1 CHECK(reserved IN (0,1)),
 expires_at INTEGER NOT NULL
);
CREATE INDEX rehearsal_media_uploads_project ON rehearsal_media_uploads(project_id);
CREATE INDEX rehearsal_media_uploads_expiry ON rehearsal_media_uploads(expires_at);

CREATE TABLE rehearsal_media_parts (
 upload_id TEXT NOT NULL REFERENCES rehearsal_media_uploads(id) ON DELETE CASCADE,
 part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 79),
 hash TEXT NOT NULL CHECK(length(hash)=64),
 data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 262144),
 PRIMARY KEY(upload_id,part)
);

CREATE TRIGGER rehearsal_media_upload_quota BEFORE INSERT ON rehearsal_media_uploads
WHEN NEW.bytes + COALESCE((SELECT sum(bytes) FROM rehearsal_files WHERE project_id=NEW.project_id),0)
  + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0)
  > COALESCE((SELECT max_bytes FROM studio_usage WHERE project_id=NEW.project_id),0)
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM rehearsal_files),0)
  + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE reserved=1),0)>188743680
BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded'); END;

CREATE TRIGGER rehearsal_files_respect_reservations BEFORE INSERT ON rehearsal_files
WHEN EXISTS(SELECT 1 FROM rehearsal_media_uploads WHERE reserved=1)
 AND (NEW.bytes + COALESCE((SELECT sum(bytes) FROM rehearsal_files WHERE project_id=NEW.project_id),0)
  + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0)
  > COALESCE((SELECT max_bytes FROM studio_usage WHERE project_id=NEW.project_id),0)
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM rehearsal_files),0)
  + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE reserved=1),0)>188743680)
BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded'); END;

CREATE TRIGGER rehearsal_media_part_immutable BEFORE UPDATE ON rehearsal_media_parts
BEGIN SELECT RAISE(ABORT,'rehearsal_media_part_immutable'); END;
