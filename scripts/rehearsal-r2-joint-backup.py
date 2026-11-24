"""Print aggregate evidence only; retain D1 SQL and R2 copies as a private recovery set."""
import argparse
from contextlib import closing
import hashlib
from importlib import import_module
import json
import os
from pathlib import Path
import re
import subprocess
import time

inventory = import_module('rehearsal-r2-inventory')
d1 = import_module('d1-readonly-backup')
verifier = import_module('verify-studio-backup')
ACCOUNT = '00000000000000000000000000000000'
BUCKET = 'rehearsal-studio-media'
ETAG = re.compile(r'^[a-f0-9]{32}(?:-[1-9][0-9]*)?$')


class R2Reader:
    """R2 S3 token restricted to the production media bucket; no write commands."""
    def __init__(self):
        if os.environ.get('CLOUDFLARE_ACCOUNT_ID') != ACCOUNT:
            raise RuntimeError('Unexpected Cloudflare account')
        if not os.environ.get('AWS_ACCESS_KEY_ID') or not os.environ.get('AWS_SECRET_ACCESS_KEY'):
            raise RuntimeError('Missing the protected, bucket-scoped R2 credentials')
        self.env = {**os.environ, 'AWS_EC2_METADATA_DISABLED': 'true',
                    'AWS_REGION': 'auto', 'AWS_PAGER': ''}

    def _call(self, verb, *args):
        result = subprocess.run(['aws', '--no-cli-pager', '--endpoint-url',
            f'https://{ACCOUNT}.r2.cloudflarestorage.com', '--region', 'auto',
            '--output', 'json', 's3api', verb, '--bucket', BUCKET, *args],
            env=self.env, check=False, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError('Authorized R2 ' + verb + ' failed; no verified joint backup produced')
        return json.loads(result.stdout)

    def get(self, key, etag, outfile):
        quoted = ('--if-match', '"' + etag + '"') if etag else ()
        return self._call('get-object', '--key', key, *quoted, str(outfile))

    def list(self):
        response = self._call('list-objects-v2')
        return {obj['Key']: obj['Size'] for obj in response.get('Contents', [])}


def verify_copy(file, path, metadata):
    if metadata['ContentLength'] != file.size or path.stat().st_size != file.size:
        raise RuntimeError('Referenced R2 object length differs from the saved metadata')
    actual_tag = metadata['ETag'].strip('"')
    if not ETAG.fullmatch(actual_tag) or (file.etag and file.etag != actual_tag):
        raise RuntimeError('Referenced R2 object generation differs from the saved metadata')
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != file.sha256:
            raise RuntimeError('Referenced R2 object SHA-256 differs from the saved metadata')
    return actual_tag


def verify_reattachment_recipe(path, etag):
    # Workers write single objects with an MD5 ETag, or use 5 MiB parts.
    # Validate the version tag on an independent copy before retention.
    if '-' not in etag:
        with path.open('rb') as stream:
            expected = hashlib.file_digest(stream, 'md5').hexdigest()
    else:
        md5s, part_size = bytearray(), 5 * 1024 * 1024
        with path.open('rb') as stream:
            for part in iter(lambda: stream.read(part_size), b''):
                md5s.extend(hashlib.md5(part).digest())
        expected = hashlib.md5(md5s).hexdigest() + '-' + str(len(md5s) // 16)
    if expected != etag:
        raise RuntimeError('Existing object ETag cannot be recreated with the known restore recipe')


def copy_referenced_objects(files, reader, output):
    objects = output / 'objects'
    objects.mkdir(mode=0o700, exist_ok=False)
    recovered = []
    for file in files:
        if not file.object_key:
            continue
        name = hashlib.sha256(file.object_key.encode('utf-8')).hexdigest()
        path = objects / name
        etag = verify_copy(file, path, reader.get(file.object_key, file.etag, path))
        if file.object_key.startswith('studio/e3/'):
            verify_reattachment_recipe(path, etag)
        recovered.append({'id': file.id, 'projectId': file.project_id, 'kind': file.kind,
                          'name': name, 'key': file.object_key, 'etag': etag,
                          'bytes': file.size, 'sha256': file.sha256})
    return recovered


def snapshot(reader, out, query_client):
    for attempt in range(3):
        try:
            d1.export_once(query_client.query, query_client.bookmark, out)
            break
        except RuntimeError as exc:
            if attempt == 2 or 'Database changed during backup' not in str(exc):
                raise
            time.sleep(5)
    with closing(inventory.open_snapshot(out / 'rehearsal-restored.sqlite')) as db:
        files, other = inventory.media_inventory(db)
    if any(file.problems for file in files):
        raise RuntimeError('File-level integrity exception in this snapshot; make no storage changes')
    copied = copy_referenced_objects(files, reader, out)
    # Validates the fully restored relational snapshot, D1 BLOBs, and every
    # copied R2 object against the recorded file ID, size and original hash.
    proof = verifier.verify(out / 'rehearsal-restored.sqlite', out / 'objects')
    live = reader.list()
    tracked = {row['key'] for row in copied}
    for group in ('r2Uploads', 'r2Quarantine', 'r2Retired', 'r2Intents'):
        tracked.update(row['object_key'] for row in other[group])
    unknown = set(live) - tracked
    summary = {**inventory.summary(files, other), 'status': 'verified snapshot and object bytes',
               'sqliteRecoverySha256': proof['backup_sha256'], 'objectsCopied': len(copied),
               'r2ListObjects': len(live), 'r2ListBytes': sum(live.values()),
               'r2UnclassifiedObjects': len(unknown), 'r2UnclassifiedBytes': sum(live[key] for key in unknown)}
    (out / 'r2-recovery-manifest.json').write_text(json.dumps(copied, sort_keys=True))
    (out / 'joint-summary.json').write_text(json.dumps(summary, sort_keys=True))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Choose a new private output directory')
    os.umask(0o077)
    try:
        print(json.dumps(snapshot(R2Reader(), args.output, d1.D1ReadClient()), sort_keys=True))
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None


if __name__ == '__main__':
    main()
