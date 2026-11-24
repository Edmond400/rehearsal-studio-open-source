-- Safe on an E3 Worker: existing pilot grants and all data remain untouched.
-- The new guard is installed before the old one is removed.
CREATE TABLE studio_r2_site_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 mode TEXT NOT NULL CHECK(mode IN ('pilot','all','off')),
 max_deck_bytes INTEGER NOT NULL CHECK(max_deck_bytes BETWEEN 20971520 AND 52428800)
);
INSERT INTO studio_r2_site_policy VALUES (1,'pilot',20971520);

CREATE TABLE studio_r2_write_blocks (
 project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE
);

CREATE VIEW studio_r2_effective_policy AS
 SELECT p.id AS project_id,s.max_deck_bytes
 FROM rehearsal_projects p JOIN studio_r2_site_policy s ON s.id=1 AND s.mode='all'
 WHERE p.archived_at IS NULL AND p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM studio_r2_write_blocks b WHERE b.project_id=p.id)
 UNION ALL
 SELECT p.id AS project_id,min(s.max_deck_bytes,w.max_deck_bytes)
 FROM studio_r2_write_policy w JOIN rehearsal_projects p ON p.id=w.project_id
 JOIN studio_r2_site_policy s ON s.id=1 AND s.mode='pilot'
 WHERE p.archived_at IS NULL AND p.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM studio_r2_write_blocks b WHERE b.project_id=p.id);

CREATE TRIGGER studio_r2_reserve_e35 BEFORE INSERT ON studio_r2_uploads
WHEN NOT EXISTS (SELECT 1 FROM studio_r2_effective_policy p WHERE p.project_id=NEW.project_id
 AND (NEW.kind<>'pptx' OR NEW.bytes<=p.max_deck_bytes))
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
DROP TRIGGER studio_r2_reserve;
