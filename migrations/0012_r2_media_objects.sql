-- Keep the existing file schema and references compatible with V1.5 readers.
CREATE TABLE studio_r2_media (
 file_id TEXT PRIMARY KEY REFERENCES rehearsal_files(id) ON DELETE CASCADE,
 object_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('dual','r2')),
 verified_at INTEGER NOT NULL
);

-- Durable intents make object writes retryable across Worker or D1 failures.
CREATE TABLE studio_r2_intents (
 object_key TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 file_id TEXT NOT NULL,
 created_at INTEGER NOT NULL
);

-- Retain object names after any relational deletion. The operational
-- reconciler must recheck current references and in-flight intents first.
CREATE TABLE studio_r2_retired (
 object_key TEXT PRIMARY KEY,
 retired_at INTEGER NOT NULL
);
CREATE TRIGGER studio_r2_retire AFTER DELETE ON studio_r2_media
BEGIN
 INSERT INTO studio_r2_retired VALUES (OLD.object_key,unixepoch()*1000)
 ON CONFLICT(object_key) DO UPDATE SET retired_at=excluded.retired_at;
END;
