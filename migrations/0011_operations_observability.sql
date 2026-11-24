-- Additive operations telemetry. Earlier capacity and storage migrations are optional.
CREATE TABLE IF NOT EXISTS studio_ops_start (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at INTEGER NOT NULL,
  total_projects INTEGER NOT NULL,
  total_recordings INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO studio_ops_start (id, started_at, total_projects)
SELECT 1, CAST(unixepoch() AS INTEGER) * 1000, COUNT(*) FROM rehearsal_projects;

CREATE TABLE IF NOT EXISTS studio_ops_project_recordings (
  project_id TEXT PRIMARY KEY REFERENCES rehearsal_projects(id) ON DELETE CASCADE,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_ops_daily (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  pptx INTEGER NOT NULL DEFAULT 0,
  recordings INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
);
CREATE INDEX IF NOT EXISTS studio_ops_daily_by_day ON studio_ops_daily(day);
CREATE TABLE IF NOT EXISTS studio_ops_sessions (
  day TEXT NOT NULL,
  session TEXT NOT NULL,
  device TEXT NOT NULL,
  PRIMARY KEY (day, session)
);
CREATE TABLE IF NOT EXISTS studio_ops_health (
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upload_failed','integrity','quota','server')),
  count INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);

CREATE TRIGGER IF NOT EXISTS studio_ops_project_created AFTER INSERT ON rehearsal_projects
BEGIN
  UPDATE studio_ops_start SET total_projects = total_projects + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS studio_ops_recording_success AFTER INSERT ON rehearsal_recordings
WHEN unixepoch(NEW.submitted_at)*1000 >= (SELECT started_at FROM studio_ops_start WHERE id=1)
BEGIN
  UPDATE studio_ops_start SET total_recordings = total_recordings + 1 WHERE id = 1;
  INSERT INTO studio_ops_project_recordings VALUES (NEW.project_id, NEW.submitted_at, NEW.submitted_at, 1)
  ON CONFLICT (project_id) DO UPDATE SET
    first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at), total = total + 1;
  INSERT INTO studio_ops_daily (project_id, day, recordings)
  VALUES (NEW.project_id, date(NEW.submitted_at, '+8 hours'), 1)
  ON CONFLICT (project_id, day) DO UPDATE SET recordings = recordings + 1;
END;

CREATE TRIGGER IF NOT EXISTS studio_ops_pptx_success AFTER INSERT ON rehearsal_files
WHEN NEW.kind = 'pptx'
 AND unixepoch(NEW.created_at)*1000 >= (SELECT started_at FROM studio_ops_start WHERE id=1)
BEGIN
  INSERT INTO studio_ops_daily (project_id, day, pptx)
  VALUES (NEW.project_id, date(NEW.created_at, '+8 hours'), 1)
  ON CONFLICT (project_id, day) DO UPDATE SET pptx = pptx + 1;
END;
