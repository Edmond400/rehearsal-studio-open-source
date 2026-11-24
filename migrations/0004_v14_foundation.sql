-- Additive foundation. Do not modify legacy recordings, assets, or retention triggers.
CREATE TABLE IF NOT EXISTS studio_admin_passwords (
 project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 algorithm TEXT NOT NULL CHECK(algorithm='pbkdf2-sha256-v1'),
 iterations INTEGER NOT NULL CHECK(iterations BETWEEN 10000 AND 100000),
 salt TEXT NOT NULL CHECK(length(salt)=32),
 verifier TEXT NOT NULL CHECK(length(verifier)=64),
 credential_version INTEGER NOT NULL CHECK(credential_version>=1),
 upgraded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_project_visibility (
 project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 visibility TEXT NOT NULL CHECK(visibility IN ('public','unlisted')),
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_directory_visibility ON studio_project_visibility(visibility,project_id);
CREATE INDEX IF NOT EXISTS studio_directory_order ON rehearsal_projects(updated_at DESC,id DESC) WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS rehearsal_releases (
 project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 release_id TEXT NOT NULL,
 release_no INTEGER NOT NULL CHECK(release_no>=1),
 source_draft_revision INTEGER NOT NULL CHECK(source_draft_revision>=0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 created_at TEXT NOT NULL,
 mutation_id TEXT,
 PRIMARY KEY(project_id,release_id),
 UNIQUE(project_id,release_no),
 UNIQUE(project_id,mutation_id)
);
CREATE TRIGGER IF NOT EXISTS rehearsal_release_immutable BEFORE UPDATE ON rehearsal_releases BEGIN
 SELECT RAISE(ABORT,'rehearsal_release_immutable');
END;
CREATE TABLE IF NOT EXISTS rehearsal_release_heads (
 project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 release_id TEXT NOT NULL,
 FOREIGN KEY(project_id,release_id) REFERENCES rehearsal_releases(project_id,release_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rehearsal_release_turns (
 project_id TEXT NOT NULL,
 release_id TEXT NOT NULL,
 turn_uid TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 member_id TEXT NOT NULL,
 turn_fingerprint TEXT NOT NULL CHECK(length(turn_fingerprint)=64),
 ordered_slide_refs_json TEXT NOT NULL CHECK(json_valid(ordered_slide_refs_json)),
 block_ids_json TEXT NOT NULL CHECK(json_valid(block_ids_json)),
 PRIMARY KEY(project_id,release_id,turn_uid),
 UNIQUE(project_id,release_id,ordinal),
 FOREIGN KEY(project_id,release_id) REFERENCES rehearsal_releases(project_id,release_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS rehearsal_recording_project_id ON rehearsal_recordings(project_id,id);
CREATE TRIGGER IF NOT EXISTS rehearsal_release_turn_immutable BEFORE UPDATE ON rehearsal_release_turns BEGIN
 SELECT RAISE(ABORT,'rehearsal_release_turn_immutable');
END;
CREATE TABLE IF NOT EXISTS rehearsal_recording_origins (
 project_id TEXT NOT NULL,
 recording_id TEXT NOT NULL,
 release_id TEXT NOT NULL,
 turn_uid TEXT NOT NULL,
 PRIMARY KEY(project_id,recording_id),
 FOREIGN KEY(project_id,recording_id) REFERENCES rehearsal_recordings(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,release_id,turn_uid) REFERENCES rehearsal_release_turns(project_id,release_id,turn_uid) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rehearsal_recording_release_refs (
 project_id TEXT NOT NULL,
 release_id TEXT NOT NULL,
 turn_uid TEXT NOT NULL,
 recording_id TEXT NOT NULL,
 validated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,release_id,turn_uid,recording_id),
 FOREIGN KEY(project_id,recording_id) REFERENCES rehearsal_recording_origins(project_id,recording_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,release_id,turn_uid) REFERENCES rehearsal_release_turns(project_id,release_id,turn_uid) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS rehearsal_recording_reference_compatible BEFORE INSERT ON rehearsal_recording_release_refs
WHEN NOT EXISTS(
 SELECT 1 FROM rehearsal_recording_origins o
 JOIN rehearsal_release_turns source ON source.project_id=o.project_id AND source.release_id=o.release_id AND source.turn_uid=o.turn_uid
 JOIN rehearsal_release_turns target ON target.project_id=NEW.project_id AND target.release_id=NEW.release_id AND target.turn_uid=NEW.turn_uid
 WHERE o.project_id=NEW.project_id AND o.recording_id=NEW.recording_id AND o.turn_uid=NEW.turn_uid
 AND source.member_id=target.member_id AND source.turn_fingerprint=target.turn_fingerprint
)
BEGIN SELECT RAISE(ABORT,'rehearsal_recording_reference_incompatible'); END;
CREATE INDEX IF NOT EXISTS rehearsal_recording_release_by_audio ON rehearsal_recording_release_refs(project_id,recording_id);
CREATE TABLE IF NOT EXISTS rehearsal_playback_choices (
 project_id TEXT NOT NULL,
 release_id TEXT NOT NULL,
 turn_uid TEXT NOT NULL,
 recording_id TEXT,
 selection_revision INTEGER NOT NULL CHECK(selection_revision>=1),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,release_id,turn_uid),
 FOREIGN KEY(project_id,release_id,turn_uid) REFERENCES rehearsal_release_turns(project_id,release_id,turn_uid) ON DELETE CASCADE,
 FOREIGN KEY(project_id,release_id,turn_uid,recording_id) REFERENCES rehearsal_recording_release_refs(project_id,release_id,turn_uid,recording_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rehearsal_draft_mutations (
 project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 client_mutation_id TEXT NOT NULL,
 base_revision INTEGER NOT NULL,
 saved_revision INTEGER NOT NULL CHECK(saved_revision>base_revision),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,client_mutation_id)
);
CREATE INDEX IF NOT EXISTS rehearsal_draft_mutations_expiry ON rehearsal_draft_mutations(created_at);
CREATE TABLE IF NOT EXISTS rehearsal_draft_checkpoints (
 project_id TEXT NOT NULL REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
 checkpoint_id TEXT NOT NULL,
 draft_revision INTEGER NOT NULL,
 document_json TEXT NOT NULL CHECK(json_valid(document_json)),
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,checkpoint_id)
);
CREATE INDEX IF NOT EXISTS rehearsal_checkpoint_history ON rehearsal_draft_checkpoints(project_id,draft_revision DESC);
