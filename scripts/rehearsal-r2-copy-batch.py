"""Copy an exact, already-reserved D1 batch. No production D1 writes or deletions."""
import argparse
from contextlib import closing
import hashlib
from importlib import import_module
import json
import os
from pathlib import Path
import re
import sys
import tempfile

joint = import_module('rehearsal-r2-joint-backup')
inventory = joint.inventory
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


class CopyFailed(RuntimeError):
    pass


def safe_to_copy(row, file):
    expected = f'studio/e3/{file.project_id}/e4-{file.id}-{file.sha256[:16]}'
    return (SAFE_ID.fullmatch(file.id) and SAFE_ID.fullmatch(file.project_id)
            and not file.problems and file.state == 'd1' and file.d1_bytes == file.size
            and row['project_id'] == file.project_id and row['object_key'] == expected
            and row['bytes'] == file.size and row['hash'] == file.sha256
            and row['source_created_at'] == file.created_at)


def compile_update(rows, operation, backup_digest=None):
    if not rows:
        return ''
    # SQL literals contain only whitelisted ids and generation values. The
    # migration triggers independently fence stale metadata and transitions.
    for row in rows:
        if not SAFE_ID.fullmatch(row['id']) or not joint.ETAG.fullmatch(row['etag']):
            raise CopyFailed('Unexpected migration file identity or ETag')
    data = json.dumps({row['id']: row['etag'] for row in rows}, separators=(',', ':'))
    if operation == 'attach':
        return (f"WITH receipt AS (SELECT key AS id,value AS etag FROM json_each('{data}')) "
                "UPDATE studio_r2_migration_jobs AS j SET state='dual', "
                "r2_etag=(SELECT etag FROM receipt WHERE id=j.file_id), dual_at=unixepoch()*1000 "
                "WHERE state='reserved' AND file_id IN (SELECT id FROM receipt) RETURNING state;")
    if operation == 'reclaim' and inventory.SHA256.fullmatch(backup_digest or ''):
        return (f"WITH receipt AS (SELECT key AS id,value AS etag FROM json_each('{data}')) "
                f"UPDATE studio_r2_migration_jobs AS j SET state='reclaimed',recovery_sha256='{backup_digest}' "
                "WHERE state='dual' AND dual_at<=unixepoch()*1000-300000 AND "
                "EXISTS(SELECT 1 FROM receipt WHERE id=j.file_id AND etag=j.r2_etag) RETURNING state;")
    raise CopyFailed('Explicit joint backup receipt is required to generate a reclaim statement')


def copy_batch(backup, reader, batch):
    provenance = json.loads((backup / 'joint-summary.json').read_text())
    if provenance['status'] != 'verified snapshot and object bytes':
        raise CopyFailed('No verified joint snapshot')
    path = backup / 'rehearsal-restored.sqlite'
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != provenance.get('sqliteRecoverySha256'):
            raise CopyFailed('Private database snapshot changed after verification')
    with closing(inventory.open_snapshot(path)) as db:
        site = db.execute("SELECT mode FROM studio_r2_site_policy WHERE id=1").fetchone()
        schema = db.execute('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').fetchone()
        if not site or site[0] != 'all' or not schema or schema[0] != '0015_r2_online_media_migration.sql':
            raise CopyFailed('Production has not completed E3.5 and the additive E4 migration')
        candidates, _ = inventory.media_inventory(db)
        by_id = {row.id: row for row in candidates}
        jobs = db.execute("""SELECT * FROM studio_r2_migration_jobs WHERE state='reserved'
             ORDER BY reserved_at,file_id LIMIT ?""", (batch,)).fetchall()
        completed, changed = [], 0
        with tempfile.TemporaryDirectory(prefix='studio-e4-copy-') as folder:
            source, readback = Path(folder) / 'd1-blob', Path(folder) / 'readback'
            for job in jobs:
                file = by_id.get(job['file_id'])
                if file is None or not safe_to_copy(job, file):
                    changed += 1
                    continue
                digest, total = hashlib.sha256(), 0
                with source.open('wb') as out:
                    for (data,) in db.execute("""SELECT data FROM rehearsal_file_chunks
                           WHERE file_id=? ORDER BY chunk_index""", (file.id,)):
                        out.write(data)
                        digest.update(data)
                        total += len(data)
                if digest.hexdigest() != file.sha256 or total != file.size:
                    raise CopyFailed('D1 source changed or is incomplete; batch not attachable')
                try:
                    receipt = reader._call('put-object', '--key', job['object_key'], '--body', str(source),
                                           '--content-type', file.mime, '--if-none-match', '*')
                    candidate = receipt['ETag'].strip('"')
                    if not joint.ETAG.fullmatch(candidate):
                        raise CopyFailed('Unexpected R2 object generation')
                except RuntimeError:
                    # An earlier attempt may have succeeded. Only resume if
                    # an independent read below proves the same exact bytes.
                    candidate = None
                readback.unlink(missing_ok=True)
                observed = joint.verify_copy(file, readback, reader.get(job['object_key'], candidate, readback))
                if '-' in observed:
                    raise CopyFailed('Migration uses single PUT objects, not a multipart generation')
                completed.append({'id': file.id, 'etag': observed, 'bytes': file.size})
        return completed, changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('private_backup', type=Path)
    parser.add_argument('--batch', type=int, default=3, choices=range(1, 257), metavar='1..256')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        completed, changed = copy_batch(args.private_backup, joint.R2Reader(), args.batch)
        (args.private_backup / 'attach-verified.sql').write_text(compile_update(completed, 'attach'))
        print(json.dumps({'verifiedObjects': len(completed), 'bytes': sum(r['bytes'] for r in completed),
                          'unattachedSourceChanges': changed}))
    except (RuntimeError, OSError) as exc:
        print('Copy phase refused or incomplete; no attachment/reclaim SQL was emitted.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
