-- Install and verify protection before disabling legacy retention.
CREATE TABLE IF NOT EXISTS rehearsal_audio_leases (
 project_id TEXT NOT NULL,
 recording_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,recording_id),
 FOREIGN KEY(project_id,recording_id) REFERENCES rehearsal_recordings(project_id,id) ON DELETE CASCADE
);

CREATE VIEW IF NOT EXISTS rehearsal_protected_recordings AS
 SELECT r.project_id,r.id FROM rehearsal_recordings r
 WHERE r.locked=1
 OR NOT EXISTS(SELECT 1 FROM rehearsal_recording_origins o WHERE o.project_id=r.project_id AND o.recording_id=r.id)
 OR EXISTS(SELECT 1 FROM rehearsal_playback_choices c WHERE c.project_id=r.project_id AND c.recording_id=r.id)
 OR EXISTS(SELECT 1 FROM rehearsal_audio_leases l WHERE l.project_id=r.project_id AND l.recording_id=r.id AND l.expires_at>unixepoch()*1000)
 OR EXISTS(
  SELECT 1 FROM rehearsal_recording_release_refs f
  LEFT JOIN rehearsal_release_heads h ON h.project_id=f.project_id
  WHERE f.project_id=r.project_id AND f.recording_id=r.id AND f.release_id IS NOT h.release_id
 )
 OR EXISTS(
  SELECT 1 FROM rehearsal_recording_origins o
  LEFT JOIN rehearsal_release_heads h ON h.project_id=o.project_id
  WHERE o.project_id=r.project_id AND o.recording_id=r.id AND o.release_id IS NOT h.release_id
 );

CREATE TRIGGER IF NOT EXISTS rehearsal_protect_recording BEFORE DELETE ON rehearsal_recordings
WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
 AND EXISTS(SELECT 1 FROM rehearsal_protected_recordings WHERE project_id=OLD.project_id AND id=OLD.id)
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_protected'); END;

CREATE TRIGGER IF NOT EXISTS rehearsal_protect_release_reference BEFORE DELETE ON rehearsal_recording_release_refs
WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
 AND EXISTS(SELECT 1 FROM rehearsal_protected_recordings WHERE project_id=OLD.project_id AND id=OLD.recording_id)
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_reference_protected'); END;

CREATE TRIGGER IF NOT EXISTS rehearsal_protect_recording_origin BEFORE DELETE ON rehearsal_recording_origins
WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
 AND EXISTS(SELECT 1 FROM rehearsal_protected_recordings WHERE project_id=OLD.project_id AND id=OLD.recording_id)
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_origin_protected'); END;

CREATE TRIGGER IF NOT EXISTS rehearsal_origin_no_update BEFORE UPDATE ON rehearsal_recording_origins
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_origin_immutable'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_ref_no_update BEFORE UPDATE ON rehearsal_recording_release_refs
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_reference_immutable'); END;

CREATE TRIGGER IF NOT EXISTS rehearsal_release_no_delete BEFORE DELETE ON rehearsal_releases
WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'rehearsal_release_protected'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_turn_no_delete BEFORE DELETE ON rehearsal_release_turns
WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'rehearsal_turn_protected'); END;

CREATE TRIGGER IF NOT EXISTS rehearsal_protect_release_file BEFORE DELETE ON rehearsal_files
WHEN OLD.kind IN ('slide','pptx') AND EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
 AND EXISTS(SELECT 1 FROM rehearsal_releases r WHERE r.project_id=OLD.project_id AND
  (json_extract(r.snapshot_json,'$.sourceDeck.id')=OLD.id OR
   EXISTS(SELECT 1 FROM json_each(r.snapshot_json,'$.slides') WHERE json_extract(value,'$.id')=OLD.id)))
BEGIN SELECT RAISE(ABORT,'rehearsal_release_file_protected'); END;

-- A publisher reads this counter before collecting recording candidates.
-- A concurrent upload or deletion forces publication to retry.
CREATE TABLE IF NOT EXISTS rehearsal_recording_epochs (
 project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 epoch INTEGER NOT NULL CHECK(epoch>0)
);
CREATE TRIGGER IF NOT EXISTS rehearsal_epoch_origin_insert AFTER INSERT ON rehearsal_recording_origins
BEGIN
 INSERT INTO rehearsal_recording_epochs VALUES (NEW.project_id,1)
 ON CONFLICT(project_id) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER IF NOT EXISTS rehearsal_epoch_recording_delete AFTER DELETE ON rehearsal_recordings
WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=OLD.project_id)
BEGIN
 INSERT INTO rehearsal_recording_epochs VALUES (OLD.project_id,1)
 ON CONFLICT(project_id) DO UPDATE SET epoch=epoch+1;
END;

CREATE TRIGGER IF NOT EXISTS rehearsal_file_immutable BEFORE UPDATE ON rehearsal_files
BEGIN SELECT RAISE(ABORT,'rehearsal_file_immutable'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_chunk_immutable BEFORE UPDATE ON rehearsal_file_chunks
BEGIN SELECT RAISE(ABORT,'rehearsal_chunk_immutable'); END;
CREATE TRIGGER IF NOT EXISTS rehearsal_chunk_protected BEFORE DELETE ON rehearsal_file_chunks
WHEN EXISTS(SELECT 1 FROM rehearsal_files WHERE id=OLD.file_id)
BEGIN SELECT RAISE(ABORT,'rehearsal_chunk_protected'); END;

CREATE TRIGGER IF NOT EXISTS rehearsal_recording_payload_immutable
BEFORE UPDATE OF id,project_id,member_id,turn_id,script_version,deck_version,algorithm_version,
 duration_ms,submitted_at,predicted_seconds,snapshot_json,events_json,metadata_json,request_hash ON rehearsal_recordings
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_payload_immutable'); END;

CREATE TABLE IF NOT EXISTS rehearsal_recording_receipts (
 project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 recording_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 submitted_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,recording_id)
);
CREATE INDEX IF NOT EXISTS rehearsal_receipt_expiry ON rehearsal_recording_receipts(project_id,submitted_at);
