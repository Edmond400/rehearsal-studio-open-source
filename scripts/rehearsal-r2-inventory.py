"""Private, read-only inventory of an isolated Rehearsal Studio D1 snapshot."""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

SHA256 = re.compile(r'^[a-f0-9]{64}$')


@dataclass
class Media:
    id: str
    project_id: str
    kind: str
    mime: str
    size: int
    sha256: str
    created_at: str
    d1_bytes: int
    chunks: int
    state: str
    object_key: str | None
    etag: str | None
    refs: dict
    problems: list


def open_snapshot(path):
    conn = sqlite3.connect(Path(path).resolve(strict=True).as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def media_inventory(db):
    rows = db.execute("""SELECT f.*, COALESCE(m.state,'d1') AS storage_state,
        m.object_key, v.etag, v.bytes AS object_bytes, v.hash AS object_sha
      FROM rehearsal_files f LEFT JOIN studio_r2_media m ON f.id=m.file_id
      LEFT JOIN studio_r2_verified v ON v.object_key=m.object_key
      ORDER BY f.project_id,f.kind,f.id""").fetchall()
    by_id = {row['id']: row for row in rows}
    per_file = defaultdict(Counter)
    unmatched = Counter()

    def add(project, fid, kind, category):
        if not isinstance(fid, str) or not fid:
            unmatched[category + ':bad-id'] += 1
            return
        row = by_id.get(fid)
        if row is None:
            unmatched[category + ':missing'] += 1
        elif row['project_id'] != project or row['kind'] != kind:
            unmatched[category + ':identity-mismatch'] += 1
        else:
            per_file[fid][category] += 1

    def document(project, raw, category):
        if not raw:
            return
        data = json.loads(raw)
        if not isinstance(data, dict):
            unmatched[category + ':malformed'] += 1
            return
        deck = data.get('sourceDeck')
        if deck is not None:
            add(project, deck.get('id') if isinstance(deck, dict) else None, 'pptx', category)
        slides = data.get('slides', [])
        if isinstance(slides, list):
            for slide in slides:
                add(project, slide.get('id') if isinstance(slide, dict) else None, 'slide', category)
        else:
            unmatched[category + ':malformed'] += 1

    for row in db.execute('SELECT id,document_json,published_json FROM rehearsal_projects'):
        document(row[0], row[1], 'current-draft')
        document(row[0], row[2], 'current-published')
    for row in db.execute('SELECT project_id,snapshot_json FROM rehearsal_releases'):
        document(row[0], row[1], 'published-release')
    for row in db.execute('SELECT project_id,document_json FROM rehearsal_versions'):
        document(row[0], row[1], 'draft-history')
    for row in db.execute('SELECT project_id,id FROM rehearsal_recordings'):
        add(row[0], row[1], 'audio', 'recording')
    for row in db.execute('SELECT project_id,recording_id FROM rehearsal_recording_release_refs'):
        add(row[0], row[1], 'audio', 'release-recording')

    files = []
    for row in rows:
        fid, state = row['id'], row['storage_state']
        checksum = hashlib.sha256()
        mutable_issues = []
        n, total = 0, 0
        for idx, data in db.execute("""SELECT chunk_index,data FROM rehearsal_file_chunks
                WHERE file_id=? ORDER BY chunk_index""", (fid,)):
            if idx != n:
                mutable_issues.append('non-contiguous D1 chunks')
            n += 1
            total += len(data)
            checksum.update(data)
        if state != 'r2' and (total != row['bytes'] or checksum.hexdigest() != row['hash']):
            mutable_issues.append('D1 size or SHA-256 mismatch')
        if state == 'r2' and n:
            mutable_issues.append('R2-only state with residual D1 chunks')
        if not SHA256.fullmatch(row['hash']):
            mutable_issues.append('invalid file SHA-256')
        if (row['object_key'] or '').startswith('studio/e3/'):
            if (not row['object_key'].startswith('studio/e3/' + row['project_id'] + '/')
                or not row['etag'] or row['object_sha'] != row['hash']
                or row['object_bytes'] is None or min(row['object_bytes'], 20971520) != row['bytes']):
                mutable_issues.append('invalid R2 verification manifest')
        files.append(Media(fid, row['project_id'], row['kind'], row['mime'],
                           row['object_bytes'] or row['bytes'], row['hash'], row['created_at'],
                           total, n, state, row['object_key'], row['etag'],
                           dict(per_file[fid]), sorted(set(mutable_issues))))

    def objects(table, *columns):
        if not db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone():
            return []
        return [dict(row) for row in db.execute('SELECT ' + ','.join(columns) + ' FROM ' + table)]

    return files, {
        'referenceExceptionsByKind': dict(unmatched),
        'legacyUploads': objects('rehearsal_media_uploads', 'id', 'project_id', 'bytes', 'expires_at'),
        'r2Uploads': objects('studio_r2_uploads', 'object_key', 'project_id', 'bytes', 'expires_at'),
        'r2Quarantine': objects('studio_r2_upload_quarantine', 'object_key', 'project_id', 'bytes'),
        'r2Retired': objects('studio_r2_retired', 'object_key', 'retired_at'),
        'r2Intents': objects('studio_r2_intents', 'object_key', 'file_id'),
    }


def summary(files, other):
    return {
        'mediaFiles': len(files),
        'mediaLogicalBytes': sum(row.size for row in files),
        'd1ChunkBytes': sum(row.d1_bytes for row in files),
        'r2ReferenceBytes': sum(row.size for row in files if row.object_key),
        'filesByBackend': dict(Counter(row.state for row in files)),
        'filesWithProblems': sum(bool(row.problems) for row in files),
        'committedFilesWithoutIndexedReferences': sum(not row.refs for row in files),
        'referenceExceptionsByKind': other['referenceExceptionsByKind'],
        'pendingLegacyUploads': len(other['legacyUploads']),
        'pendingR2Uploads': len(other['r2Uploads']),
        'r2Quarantine': len(other['r2Quarantine']),
        'r2Retired': len(other['r2Retired']),
        'r2Intents': len(other['r2Intents']),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sqlite_backup', type=Path)
    parser.add_argument('--private-manifest', type=Path,
                        help='Optional local private manifest; never print detailed rows or credentials')
    args = parser.parse_args()
    with closing(open_snapshot(args.sqlite_backup)) as db:
        files, other = media_inventory(db)
    if args.private_manifest:
        with os.fdopen(os.open(args.private_manifest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
            json.dump({'files': [asdict(row) for row in files], **other}, out)
    print(json.dumps(summary(files, other), sort_keys=True))


if __name__ == '__main__':
    main()
