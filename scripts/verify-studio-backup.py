"""Read-only verification of an independent studio SQLite backup, never a remote DB."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def verify(path, object_dir=None):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if any(n in names for n in ['students', 'birthdays', 'administrators', 'incentive_activities']):
            raise ValueError('Refusing a class-service database; independent studio backup required')
        required = {'rehearsal_projects', 'rehearsal_versions', 'rehearsal_files', 'rehearsal_file_chunks', 'rehearsal_recordings'}
        if not required <= names:
            raise ValueError('Incomplete studio schema')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or list(db.execute('PRAGMA foreign_key_check')):
            raise ValueError('Integrity or foreign-key check failed')
        files = []
        locations = {}
        if 'studio_r2_media' in names:
            locations = dict((row[0], row[1:]) for row in db.execute(
                'SELECT file_id,object_key,state FROM studio_r2_media'))
        if locations and object_dir is None:
            raise ValueError('R2 references require an independent object backup')
        objects = Path(object_dir).resolve(strict=True) if object_dir is not None else None
        for fid, project, size, expected in db.execute('SELECT id,project_id,bytes,hash FROM rehearsal_files ORDER BY id'):
            key, state = locations.get(fid, (None, 'd1'))
            if key:
                # Names are derived from the immutable object key and cannot
                # contain user-controlled filesystem paths.
                obj = objects / hashlib.sha256(key.encode()).hexdigest()
                if obj.is_symlink() or not obj.is_file():
                    raise ValueError('Missing object backup: ' + fid)
                if key.startswith('studio/e3/'):
                    if not key.startswith('studio/e3/' + project + '/') or 'studio_r2_verified' not in names:
                        raise ValueError('Object project or manifest mismatch: ' + fid)
                    manifest = db.execute('SELECT bytes,hash FROM studio_r2_verified WHERE object_key=?', [key]).fetchone()
                    if not manifest or manifest[1] != expected or size != min(manifest[0], 20971520):
                        raise ValueError('Object reference size/SHA-256 mismatch: ' + fid)
                    size = manifest[0]
                with obj.open('rb') as stream:
                    if obj.stat().st_size != size or hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                        raise ValueError('Object backup size/SHA-256 mismatch: ' + fid)
            if state == 'r2':
                files.append({'id': fid, 'bytes': size, 'sha256': expected})
                continue
            digest = hashlib.sha256()
            count = 0
            for index, data in db.execute('SELECT chunk_index,data FROM rehearsal_file_chunks WHERE file_id=? ORDER BY chunk_index', [fid]):
                if index != count:
                    raise ValueError('Missing file chunk: ' + fid)
                count += 1
                digest.update(data)
            actual_size = db.execute('SELECT coalesce(sum(length(data)),0) FROM rehearsal_file_chunks WHERE file_id=?', [fid]).fetchone()[0]
            if actual_size != size or digest.hexdigest() != expected:
                raise ValueError('File size/SHA-256 mismatch: ' + fid)
            files.append({'id': fid, 'bytes': size, 'sha256': expected})
        if 'rehearsal_media_uploads' in names:
            for upload_id, size, expected, next_part, verified in db.execute(
                'SELECT id,bytes,hash,next_part,verified FROM rehearsal_media_uploads'
            ):
                digest, count = hashlib.sha256(), 0
                for part, stored, data in db.execute(
                    'SELECT part,hash,data FROM rehearsal_media_parts WHERE upload_id=? ORDER BY part', [upload_id]
                ):
                    if (part != count or len(data) != min(262144, size - part * 262144)
                            or hashlib.sha256(data).hexdigest() != stored):
                        raise ValueError('Staged media part mismatch: ' + upload_id)
                    digest.update(data)
                    count += 1
                if count != next_part or (verified and (
                    count != (size + 262143) // 262144 or digest.hexdigest() != expected
                )):
                    raise ValueError('Staged media verification mismatch: ' + upload_id)
        counts, row_hashes = {}, {}
        for name in sorted(names):
            if name != 'd1_migrations' and not name.startswith(('rehearsal_', 'studio_')):
                continue
            quoted = '"' + name.replace('"', '""') + '"'
            digests = []
            for row in db.execute('SELECT * FROM ' + quoted):
                values = [{'blob_sha256': hashlib.sha256(v).hexdigest()} if isinstance(v, bytes) else v for v in row]
                digests.append(hashlib.sha256(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode()).digest())
            counts[name] = len(digests)
            digest = hashlib.sha256()
            for value in sorted(digests):
                digest.update(value)
            row_hashes[name] = digest.hexdigest()
        with path.open('rb') as backup:
            backup_hash = hashlib.file_digest(backup, 'sha256').hexdigest()
        return {'backup_sha256': backup_hash, 'counts': counts, 'row_sha256': row_hashes, 'files': files, 'integrity': 'ok'}
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database')
    parser.add_argument('--r2-objects', help='Directory of independent copies named by SHA-256 of the object key')
    args = parser.parse_args()
    print(json.dumps(verify(args.database, args.r2_objects), ensure_ascii=False, indent=2))
