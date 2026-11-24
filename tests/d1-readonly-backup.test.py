import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup', Path(__file__).resolve().parents[1] / 'scripts/d1-readonly-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def fixture(self):
        con = sqlite3.connect(':memory:')
        con.row_factory = sqlite3.Row
        con.executescript('''
          CREATE TABLE rehearsal_projects(id INTEGER PRIMARY KEY AUTOINCREMENT, text_value TEXT, real_value REAL, int_value INTEGER);
          CREATE TABLE rehearsal_files(id TEXT PRIMARY KEY, project_id INTEGER REFERENCES rehearsal_projects(id), data BLOB, size INTEGER GENERATED ALWAYS AS (length(data)) STORED);
          CREATE TABLE rehearsal_versions(id TEXT PRIMARY KEY, project_id INTEGER REFERENCES rehearsal_projects(id)) WITHOUT ROWID;
          CREATE TABLE rehearsal_recordings(id TEXT PRIMARY KEY);
          CREATE TABLE studio_sessions(id TEXT PRIMARY KEY);
          CREATE TABLE audit(id INTEGER PRIMARY KEY, message TEXT);
          CREATE INDEX file_project ON rehearsal_files(project_id);
          CREATE VIEW file_sizes AS SELECT id,size FROM rehearsal_files;
          CREATE TRIGGER record_audit AFTER INSERT ON rehearsal_recordings BEGIN INSERT INTO audit(message) VALUES(new.id); END;
        ''')
        for i in range(1, 24):
            con.execute('INSERT INTO rehearsal_projects VALUES(?,?,?,?)', (i, "中文'\x00\n" + str(i), 1.2345678901234567 / i, 9223372036854775807 - i))
            con.execute('INSERT INTO rehearsal_files(id,project_id,data) VALUES(?,?,?)', (str(i), i, bytes(range(256)) * i))
        con.execute('INSERT INTO rehearsal_projects VALUES(99,CAST(X\'80FF\' AS TEXT),9e999,-9223372036854775808)')
        con.execute('INSERT INTO rehearsal_projects(id) VALUES(100)')
        con.execute('DELETE FROM rehearsal_projects WHERE id=100')
        con.execute("INSERT INTO rehearsal_versions VALUES('v1',1)")
        con.commit()
        return con

    def query(self, con):
        def execute(sql):
            self.assertTrue(sql.startswith('SELECT '), 'remote writes forbidden')
            return [dict(r) for r in con.execute(sql)]
        return execute

    def test_lossless_roundtrip_and_explicit_columns(self):
        con = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            report = backup.export_once(self.query(con), lambda: 'stable', Path(directory))
            self.assertEqual(report['status'], 'PASS')
            self.assertEqual(report['tableCounts']['rehearsal_projects'], 24)
            restored = sqlite3.connect(Path(directory) / 'rehearsal-restored.sqlite')
            self.assertEqual(restored.execute('SELECT hex(text_value),int_value FROM rehearsal_projects WHERE id=99').fetchone(), ('80FF', -9223372036854775808))
            self.assertEqual(restored.execute("SELECT seq FROM sqlite_sequence WHERE name='rehearsal_projects'").fetchone()[0], 100)
            self.assertEqual(restored.execute('SELECT sum(size) FROM rehearsal_files').fetchone()[0], con.execute('SELECT sum(size) FROM rehearsal_files').fetchone()[0])
            restored.execute("INSERT INTO rehearsal_recordings VALUES('trigger-test')")
            self.assertEqual(restored.execute('SELECT message FROM audit').fetchone()[0], 'trigger-test')
            restored.close()
        con.close()

    def test_changed_bookmark_refuses_backup(self):
        con = self.fixture()
        bookmarks = iter(['before', 'after'])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'Database changed'):
                backup.export_once(self.query(con), lambda: next(bookmarks), Path(directory))
            self.assertFalse((Path(directory) / 'rehearsal-preflight.sql').exists())
            self.assertFalse((Path(directory) / 'preflight-summary.json').exists())
        con.close()

    def test_real_literal_format_can_differ_across_sqlite_versions(self):
        con = self.fixture()
        con.execute('UPDATE rehearsal_projects SET real_value=0.1 WHERE id=1')
        remote = self.query(con)
        local_literal = con.execute("SELECT printf('%!.26g',real_value) FROM rehearsal_projects WHERE id=1").fetchone()[0]
        other_literal = '0.100000000000000005' if local_literal == '0.1000000000000000056' else '0.1000000000000000056'

        def query(sql):
            rows = remote(sql)
            if 'FROM "rehearsal_projects" ORDER BY "rowid" LIMIT 8 OFFSET 0' in sql:
                self.assertEqual(rows[0]['c3'], local_literal)
                rows[0]['c3'] = other_literal
            return rows

        with tempfile.TemporaryDirectory() as directory:
            report = backup.export_once(query, lambda: 'stable', Path(directory))
            self.assertEqual(report['status'], 'PASS')
        con.close()

    def test_broken_reference_refuses_verification(self):
        con = self.fixture()
        con.execute("INSERT INTO rehearsal_files(id,project_id,data) VALUES('orphan',404,X'00')")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'foreign_key_check'):
                backup.export_once(self.query(con), lambda: 'stable', Path(directory))
            self.assertFalse((Path(directory) / 'preflight-summary.json').exists())
        con.close()


if __name__ == '__main__':
    unittest.main()
