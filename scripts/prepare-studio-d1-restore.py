"""Reorder a trusted independent Studio D1 SQL export for an empty restore target.

D1 exports data before standalone unique indexes. Composite foreign keys need
those indexes before inserts, even with deferred checks. Keep triggers last so
restoring rows does not replay application writes. The optional SQLite restore writes a new offline database for verification.
"""
import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile

TABLE = re.compile(r'^CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\s*\(', re.I)
# Cloudflare remote exports include column names; local exports can omit them.
IDENTIFIER = r'(?:"\w+"|\w+)'
INSERT = re.compile(
    rf'^INSERT INTO "?(\w+)"?(?:\s*\(\s*{IDENTIFIER}(?:\s*,\s*{IDENTIFIER})*\s*\))?\s+VALUES\s*\(',
    re.I,
)
INDEX = re.compile(r'^CREATE (?:UNIQUE )?INDEX\b', re.I)
FINAL = re.compile(r'^CREATE (?:VIEW|TRIGGER)\b', re.I)
DEFER = re.compile(r'^PRAGMA defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;$', re.I)
REQUIRED = {'d1_migrations', 'rehearsal_projects', 'rehearsal_file_chunks', 'studio_usage'}


def statements(source):
    pending = []
    for line in source:
        if not pending and not line.strip():
            continue
        pending.append(line)
        if ';' in line:
            statement = ''.join(pending).strip()
            if sqlite3.complete_statement(statement):
                yield statement
                pending.clear()
    if pending:
        raise ValueError('Incomplete SQL statement in D1 export')


def prepare(source_path, target_path):
    with ExitStack() as stack:
        source = stack.enter_context(Path(source_path).open(encoding='utf-8', newline=''))
        phases = [stack.enter_context(tempfile.TemporaryFile(mode='w+t', encoding='utf-8', newline='')) for _ in range(4)]
        tables, inserted = set(), set()
        for sql in statements(source):
            if DEFER.fullmatch(sql):
                continue
            table = TABLE.match(sql)
            insert = INSERT.match(sql)
            if table:
                name = table.group(1)
                if name != 'd1_migrations' and not name.startswith(('rehearsal_', 'studio_')):
                    raise ValueError(f'Unexpected table in independent Studio backup: {name}')
                tables.add(name)
                phase = 0
            elif INDEX.match(sql):
                phase = 1
            elif insert:
                inserted.add(insert.group(1))
                phase = 2
            elif sql.upper() == 'DELETE FROM SQLITE_SEQUENCE;':
                phase = 2
            elif FINAL.match(sql):
                phase = 3
            else:
                raise ValueError('Unexpected statement in D1 export')
            phases[phase].write(sql + '\n')
        if not REQUIRED <= tables or inserted - tables - {'sqlite_sequence'}:
            raise ValueError('Expected a full SQL export from the independent Studio database')

        fd = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8', newline='') as target:
                target.write('PRAGMA defer_foreign_keys=TRUE;\n')
                for phase in phases:
                    phase.seek(0)
                    shutil.copyfileobj(phase, target)
        except BaseException:
            Path(target_path).unlink(missing_ok=True)
            raise


def restore_sqlite(ordered_path, target_path):
    # Apply one complete statement at a time in a single transaction. The
    # largest buffered statement is one exported row, independent of dump size.
    fd = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    try:
        with sqlite3.connect(target_path) as database:
            database.execute('PRAGMA foreign_keys=ON')
            database.execute('BEGIN')
            with Path(ordered_path).open(encoding='utf-8', newline='') as source:
                for statement in statements(source):
                    database.execute(statement)
            if database.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                raise ValueError('Restored SQLite database failed integrity_check')
            if database.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise ValueError('Restored SQLite database has foreign-key errors')
    except BaseException:
        Path(target_path).unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export_sql')
    parser.add_argument('restore_sql', help='New file for import into a separate empty database')
    parser.add_argument('--sqlite-out', help='Optional new offline SQLite file for verified restore')
    args = parser.parse_args()
    prepare(args.export_sql, args.restore_sql)
    if args.sqlite_out:
        restore_sqlite(args.restore_sql, args.sqlite_out)
