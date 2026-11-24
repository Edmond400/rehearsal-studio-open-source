"""Lossless, bookmark-consistent logical SQL backup using D1 Read only.

All remote SQL is SELECT. All INSERT/DDL/PRAGMA run only in offline SQLite.
Never prints credentials, SQL, user rows, or recovery bookmarks.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DATABASE_ID = '00000000-0000-4000-8000-000000000001'
SCHEMA_QUERY = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY type,name"
REAL_LITERAL = re.compile(r'-?\d+(?:\.\d+(?:[eE][+-]?\d+)?|[eE][+-]?\d+)')


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal_expression(column):
    c = ident(column)
    return (f"CASE typeof({c}) WHEN 'null' THEN 'NULL' "
            f"WHEN 'blob' THEN 'X'''||hex({c})||'''' "
            f"WHEN 'text' THEN 'CAST(X'''||hex(CAST({c} AS BLOB))||''' AS TEXT)' "
            f"WHEN 'integer' THEN CAST({c} AS TEXT) "
            f"WHEN 'real' THEN CASE WHEN {c}>1.7976931348623157e308 THEN '9e999' "
            f"WHEN {c} < -1.7976931348623157e308 THEN '-9e999' ELSE printf('%!.26g',{c}) END END")


def layout(con, table):
    info = con.execute('PRAGMA table_xinfo(' + ident(table) + ')').fetchall()
    columns = [r[1] for r in info if r[6] == 0]
    table_info = next(r for r in con.execute('PRAGMA table_list') if r[1] == table)
    if not table_info[4]:
        rowid = next((n for n in ('rowid', '_rowid_', 'oid') if n not in columns), None)
        if rowid is None:
            raise RuntimeError('Unsupported shadowed rowid; backup refused')
        columns = [rowid] + columns
        order = ident(rowid)
    else:
        order = ','.join(ident(r[1]) for r in sorted(info, key=lambda r: r[5]) if r[5])
    select = 'SELECT ' + ','.join(literal_expression(c) + ' AS c' + str(i) for i, c in enumerate(columns))
    select += ' FROM ' + ident(table) + ' ORDER BY ' + order
    return columns, select


def row_digest_update(digest, values):
    canonical = []
    for value in values:
        if not isinstance(value, str):
            raise RuntimeError('Unexpected non-literal response; backup refused')
        # SQLite versions can print different decimals for the same binary64.
        if REAL_LITERAL.fullmatch(value):
            value = 'REAL ' + float(value).hex()
        canonical.append(value)
    digest.update(json.dumps(canonical, separators=(',', ':')).encode('ascii') + b'\n')


def export_once(query, bookmark, directory):
    directory.mkdir(parents=True, exist_ok=True)
    start = bookmark()
    schema = query(SCHEMA_QUERY)
    tables = [r for r in schema if r['type'] == 'table' and r['name'] != 'sqlite_sequence']
    if any('VIRTUAL TABLE' in r['sql'].upper() for r in tables):
        raise RuntimeError('Virtual tables require specialized backup; refused')
    required = {'rehearsal_projects', 'rehearsal_files', 'rehearsal_versions', 'rehearsal_recordings', 'studio_sessions'}
    if not required <= {r['name'] for r in tables}:
        raise RuntimeError('Production schema allowlist check failed')
    model = sqlite3.connect(':memory:')
    for t in tables:
        model.execute(t['sql'])
    if any(r['name'] == 'sqlite_sequence' for r in schema):
        tables.append({'name': 'sqlite_sequence'})
    target = directory / 'rehearsal-preflight.sql'
    counts, hashes, plans = {}, {}, {}
    with target.open('w', encoding='utf-8') as out:
        out.write('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n')
        for t in tables:
            if t['name'] != 'sqlite_sequence':
                out.write(t['sql'] + ';\n')
        for t in tables:
            name = t['name']
            columns, select = layout(model, name)
            plans[name] = select
            if name == 'sqlite_sequence':
                out.write('DELETE FROM sqlite_sequence;\n')
            digest, offset = hashlib.sha256(), 0
            while True:
                rows = query(select + ' LIMIT 8 OFFSET ' + str(offset))
                for row in rows:
                    values = [row['c' + str(i)] for i in range(len(columns))]
                    row_digest_update(digest, values)
                    out.write('INSERT INTO ' + ident(name) + '(' + ','.join(map(ident, columns)) + ') VALUES (' + ','.join(values) + ');\n')
                offset += len(rows)
                if len(rows) < 8:
                    break
            counts[name], hashes[name] = offset, digest.hexdigest()
        for r in schema:
            if r['type'] != 'table' and r.get('sql'):
                out.write(r['sql'] + ';\n')
        out.write('COMMIT;\n')
    end = bookmark()
    model.close()
    if start != end:
        target.unlink()
        raise RuntimeError('Database changed during backup; no verified backup produced')
    restored = directory / 'rehearsal-restored.sqlite'
    restored.unlink(missing_ok=True)
    con = sqlite3.connect(restored)
    try:
        con.executescript(target.read_text(encoding='utf-8'))
        if con.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Offline integrity_check failed')
        if con.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('Offline foreign_key_check failed')
        for name, select in plans.items():
            digest, n = hashlib.sha256(), 0
            for row in con.execute(select):
                row_digest_update(digest, list(row))
                n += 1
            if n != counts[name] or digest.hexdigest() != hashes[name]:
                raise RuntimeError('Offline row count/content digest mismatch for ' + name)
    finally:
        con.close()
    report = {'status': 'PASS', 'method': 'D1 Read SELECT only; stable Time Travel bookmark',
              'productionDatabaseBinding': 'verified', 'sqlExportBytes': target.stat().st_size,
              'sqlSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
              'offlineRestoreIntegrity': 'ok', 'offlineForeignKeys': 'ok',
              'tableCounts': counts, 'tableContentSha256': hashes,
              'bookmarkUnchanged': True, 'temporaryBackupOnly': False, 'privateBackupRetentionDays': 7}
    (directory / 'd1-timetravel.json').write_text(json.dumps({'bookmark': start}))
    (directory / 'preflight-summary.json').write_text(json.dumps(report, indent=2))
    return report


class D1ReadClient:
    def __init__(self):
        account = os.environ['CLOUDFLARE_ACCOUNT_ID']
        if not re.fullmatch('[0-9a-f]{32}', account):
            raise RuntimeError('Invalid account identifier')
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/d1/database/' + DATABASE_ID
        self.token = os.environ['CLOUDFLARE_API_TOKEN']

    def request(self, path, payload=None):
        request = urllib.request.Request(self.base + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    data = json.load(response)
                if not data.get('success'):
                    raise RuntimeError('Cloudflare operation rejected; response values withheld')
                return data['result']
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(attempt + 1)
                    continue
                raise RuntimeError('Cloudflare HTTP ' + str(exc.code) + '; response values withheld') from None

    def query(self, sql):
        if not sql.startswith('SELECT '):
            raise RuntimeError('Remote SQL must be SELECT')
        results = self.request('/query', {'sql': sql})
        if len(results) != 1 or not results[0].get('success'):
            raise RuntimeError('Unexpected query response')
        meta = results[0].get('meta', {})
        if meta.get('rows_written', 0) != 0 or meta.get('changes', 0) != 0:
            raise RuntimeError('Remote write metadata detected; backup refused')
        return results[0]['results']

    def bookmark(self):
        value = self.request('/time_travel/bookmark').get('bookmark')
        if not isinstance(value, str) or not re.fullmatch('[0-9a-f-]{40,}', value):
            raise RuntimeError('Missing recovery bookmark')
        return value


if __name__ == '__main__':
    client = D1ReadClient()
    report = export_once(client.query, client.bookmark, Path(sys.argv[1]))
    print('PASS: read-only SQL backup, unchanged bookmark, offline restore, integrity, foreign keys and all-table content digests; bytes:', report['sqlExportBytes'])
