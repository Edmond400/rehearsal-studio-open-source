-- Private objects are reserved before any R2 call. Cancelled and expired
-- reservations continue to count until a reconciler proves the object is gone.
CREATE TABLE studio_r2_uploads (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('pptx','audio','slide')),
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 52428800),
 hash TEXT NOT NULL CHECK(length(hash)=64),
 object_key TEXT NOT NULL UNIQUE,
 upload_id TEXT,
 lease TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','cancelled','committing')),
 source_id TEXT
);
-- Superseded uploads retain a distinct object key and their full reserved
-- bytes. Cleanup requires a separate verified reconciliation.
CREATE TABLE studio_r2_upload_quarantine (
 object_key TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 upload_id TEXT,
 bytes INTEGER NOT NULL,
 quarantined_at INTEGER NOT NULL
);
CREATE INDEX studio_r2_quarantine_project ON studio_r2_upload_quarantine(project_id);
CREATE INDEX studio_r2_upload_project ON studio_r2_uploads(project_id);
CREATE TABLE studio_r2_upload_parts (
 file_id TEXT NOT NULL REFERENCES studio_r2_uploads(id) ON DELETE CASCADE,
 part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 9),
 hash TEXT NOT NULL CHECK(length(hash)=64),
 etag TEXT,
 PRIMARY KEY (file_id,part)
);

-- A full object digest is verified before attaching a reference. Retired
-- objects retain their accounting and verification record until reviewed.
CREATE TABLE studio_r2_verified (
 object_key TEXT PRIMARY KEY,
 etag TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>0),
 hash TEXT NOT NULL CHECK(length(hash)=64)
);
CREATE TABLE studio_r2_write_policy (
 project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 max_deck_bytes INTEGER NOT NULL CHECK(max_deck_bytes BETWEEN 20971520 AND 52428800)
);
-- Keep the legacy 20 MiB CHECK and all foreign keys in place. The exact
-- byte length for R2 files comes from the verified object manifest.
CREATE VIEW studio_media_files AS
 SELECT f.id,f.project_id,f.kind,f.mime,COALESCE(v.bytes,f.bytes) AS bytes,f.hash,f.created_at
 FROM rehearsal_files f LEFT JOIN studio_r2_media m ON m.file_id=f.id
 LEFT JOIN studio_r2_verified v ON v.object_key=m.object_key;
CREATE VIEW studio_d1_media AS
 SELECT f.* FROM rehearsal_files f LEFT JOIN studio_r2_media m ON m.file_id=f.id
 WHERE m.state IS NULL OR m.state='dual';

CREATE TRIGGER studio_r2_reserve BEFORE INSERT ON studio_r2_uploads
WHEN NOT EXISTS (SELECT 1 FROM studio_r2_write_policy WHERE project_id=NEW.project_id)
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_r2_uploads),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_verified),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_upload_quarantine),0)
 + COALESCE((SELECT sum(f.bytes) FROM studio_r2_media m JOIN rehearsal_files f ON f.id=m.file_id
   WHERE NOT EXISTS (SELECT 1 FROM studio_r2_verified v WHERE v.object_key=m.object_key)),0) > 8000000000
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_r2_uploads WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_upload_quarantine WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM studio_media_files WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0) > 314572800
BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded'); END;

DROP TRIGGER studio_quota;
DROP TRIGGER rehearsal_media_upload_quota;
DROP TRIGGER rehearsal_files_respect_reservations;
CREATE TRIGGER studio_quota BEFORE INSERT ON rehearsal_files
WHEN NOT EXISTS(SELECT 1 FROM studio_r2_uploads u WHERE u.id=NEW.id AND u.project_id=NEW.project_id
 AND u.status='committing' AND min(u.bytes,20971520)=NEW.bytes AND u.hash=NEW.hash AND u.kind=NEW.kind AND u.mime=NEW.mime)
 AND (NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_d1_media WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0)
 > COALESCE((SELECT max_bytes FROM studio_usage WHERE project_id=NEW.project_id),0)
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_d1_media),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE reserved=1),0)>188743680
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_media_files WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_uploads WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_upload_quarantine WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0)>314572800)
BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded'); END;

CREATE TRIGGER rehearsal_media_upload_quota BEFORE INSERT ON rehearsal_media_uploads
WHEN NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_d1_media WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0)
 > COALESCE((SELECT max_bytes FROM studio_usage WHERE project_id=NEW.project_id),0)
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_d1_media),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE reserved=1),0)>188743680
 OR NEW.bytes + COALESCE((SELECT sum(bytes) FROM studio_media_files WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_uploads WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_upload_quarantine WHERE project_id=NEW.project_id),0)
 + COALESCE((SELECT sum(bytes) FROM rehearsal_media_uploads WHERE project_id=NEW.project_id AND reserved=1),0)>314572800
BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded'); END;

CREATE TABLE studio_r2_upload_failures (
 day TEXT PRIMARY KEY,
 total INTEGER NOT NULL DEFAULT 0,
 integrity INTEGER NOT NULL DEFAULT 0
);
