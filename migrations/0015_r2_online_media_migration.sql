-- Keep file IDs, projects, versions and all original rows. A reservation tracks
-- physical R2 bytes even if the source is concurrently deleted during copying.
CREATE TABLE studio_r2_migration_jobs (
 file_id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE,
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 20971520),
 hash TEXT NOT NULL CHECK(length(hash)=64),
 source_created_at TEXT NOT NULL,
 reserved_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dual','reclaimed')),
 r2_etag TEXT,
 dual_at INTEGER,
 recovery_sha256 TEXT
);

CREATE VIEW studio_r2_accounted_bytes AS
 SELECT COALESCE((SELECT sum(bytes) FROM studio_r2_uploads),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_verified),0)
 + COALESCE((SELECT sum(bytes) FROM studio_r2_upload_quarantine),0)
 + COALESCE((SELECT sum(f.bytes) FROM studio_r2_media m JOIN rehearsal_files f ON f.id=m.file_id
    WHERE NOT EXISTS(SELECT 1 FROM studio_r2_verified v WHERE v.object_key=m.object_key)),0)
 + COALESCE((SELECT sum(j.bytes) FROM studio_r2_migration_jobs j
    WHERE NOT EXISTS(SELECT 1 FROM studio_r2_verified v WHERE v.object_key=j.object_key)),0) AS bytes;

CREATE TRIGGER studio_r2_keep_migration_reservation BEFORE INSERT ON studio_r2_uploads
WHEN NEW.bytes + (SELECT bytes FROM studio_r2_accounted_bytes)>8000000000
BEGIN SELECT RAISE(ABORT,'studio_quota_exceeded'); END;

CREATE TRIGGER studio_r2_migration_reserve BEFORE INSERT ON studio_r2_migration_jobs
WHEN NEW.state<>'reserved' OR NEW.r2_etag IS NOT NULL OR NEW.dual_at IS NOT NULL
 OR NEW.recovery_sha256 IS NOT NULL
 OR NEW.bytes + (SELECT bytes FROM studio_r2_accounted_bytes)>8000000000
 OR NEW.object_key<>('studio/e3/'||NEW.project_id||'/e4-'||NEW.file_id||'-'||substr(NEW.hash,1,16))
 OR NOT EXISTS(SELECT 1 FROM rehearsal_files f WHERE f.id=NEW.file_id AND f.project_id=NEW.project_id
    AND f.created_at=NEW.source_created_at AND f.hash=NEW.hash AND f.bytes=NEW.bytes
    AND NOT EXISTS(SELECT 1 FROM studio_r2_media WHERE file_id=f.id))
BEGIN SELECT RAISE(ABORT,'studio_r2_migration_reservation_invalid'); END;

CREATE TRIGGER studio_r2_migration_update_fence BEFORE UPDATE ON studio_r2_migration_jobs
WHEN NEW.file_id<>OLD.file_id OR NEW.project_id<>OLD.project_id OR NEW.object_key<>OLD.object_key
 OR NEW.hash<>OLD.hash OR NEW.bytes<>OLD.bytes OR NEW.source_created_at<>OLD.source_created_at
 OR NEW.reserved_at<>OLD.reserved_at
 OR NOT ((OLD.state='reserved' AND NEW.state='dual') OR (OLD.state='dual' AND NEW.state='reclaimed'))
 OR NOT EXISTS(SELECT 1 FROM rehearsal_files f WHERE f.id=NEW.file_id AND f.project_id=NEW.project_id
    AND f.created_at=NEW.source_created_at AND f.hash=NEW.hash AND f.bytes=NEW.bytes)
 OR COALESCE((SELECT sum(length(data)) FROM rehearsal_file_chunks WHERE file_id=NEW.file_id),0)<>NEW.bytes
BEGIN SELECT RAISE(ABORT,'studio_r2_migration_source_changed'); END;

CREATE TRIGGER studio_r2_migration_verified_copy BEFORE UPDATE ON studio_r2_migration_jobs
WHEN NEW.state='dual' AND (NEW.r2_etag IS NULL OR length(NEW.r2_etag)<>32
 OR NEW.r2_etag GLOB '*[^0-9a-f]*' OR NEW.dual_at IS NULL
 OR NEW.dual_at<NEW.reserved_at OR NEW.dual_at>unixepoch()*1000
 OR NEW.recovery_sha256 IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'studio_r2_migration_copy_unverified'); END;

CREATE TRIGGER studio_r2_migration_attach AFTER UPDATE ON studio_r2_migration_jobs
WHEN OLD.state='reserved' AND NEW.state='dual'
BEGIN
 INSERT INTO studio_r2_verified VALUES(NEW.object_key,NEW.r2_etag,NEW.bytes,NEW.hash);
 INSERT INTO studio_r2_media VALUES(NEW.file_id,NEW.object_key,'dual',NEW.dual_at);
END;

CREATE TRIGGER studio_r2_migration_require_recovery BEFORE UPDATE ON studio_r2_migration_jobs
WHEN NEW.state='reclaimed' AND (
 NEW.recovery_sha256 IS NULL OR length(NEW.recovery_sha256)<>64 OR NEW.recovery_sha256 GLOB '*[^0-9a-f]*'
 OR NEW.r2_etag IS NOT OLD.r2_etag OR NEW.dual_at IS NOT OLD.dual_at
 OR OLD.dual_at>unixepoch()*1000-300000
 OR NOT EXISTS(SELECT 1 FROM studio_r2_media m JOIN studio_r2_verified v USING(object_key)
   WHERE m.file_id=NEW.file_id AND m.state='dual' AND m.object_key=NEW.object_key
     AND v.bytes=NEW.bytes AND v.hash=NEW.hash AND v.etag=NEW.r2_etag))
BEGIN SELECT RAISE(ABORT,'studio_r2_migration_recovery_required'); END;

CREATE TRIGGER rehearsal_chunk_protected_e4 BEFORE DELETE ON rehearsal_file_chunks
WHEN EXISTS(SELECT 1 FROM rehearsal_files WHERE id=OLD.file_id)
 AND NOT EXISTS(SELECT 1 FROM studio_r2_migration_jobs j
   JOIN studio_r2_media m ON m.file_id=j.file_id AND m.object_key=j.object_key AND m.state='r2'
   JOIN studio_r2_verified v ON v.object_key=j.object_key AND v.hash=j.hash AND v.etag=j.r2_etag AND v.bytes=j.bytes
   WHERE j.file_id=OLD.file_id AND j.state='reclaimed' AND j.recovery_sha256 IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'rehearsal_chunk_protected'); END;
DROP TRIGGER rehearsal_chunk_protected;

CREATE TRIGGER studio_r2_migration_reclaim AFTER UPDATE ON studio_r2_migration_jobs
WHEN OLD.state='dual' AND NEW.state='reclaimed'
BEGIN
 UPDATE studio_r2_media SET state='r2' WHERE file_id=NEW.file_id AND object_key=NEW.object_key AND state='dual';
 DELETE FROM rehearsal_file_chunks WHERE file_id=NEW.file_id;
END;
