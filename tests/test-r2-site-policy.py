"""SQLite-level guard regression; production is never contacted."""
import sqlite3
import re
import unittest
from pathlib import Path


class TestR2SitePolicy(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('PRAGMA foreign_keys=ON')
        sources = sorted(Path('migrations').glob('*.sql'))
        for source in sources:
            if source.name <= '0013_r2_uploads.sql':
                self.db.executescript(source.read_text())
        self.add_project('pilot')
        self.add_project('ordinary')
        self.add_project('archived')
        self.db.execute("UPDATE rehearsal_projects SET archived_at='2026-01-01' WHERE id='archived'")
        self.db.execute("INSERT INTO studio_r2_write_policy VALUES ('pilot',20971520)")
        migration = Path('migrations/0014_r2_site_write_policy.sql').read_text()
        for sql in re.findall(r'\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;', migration, re.I):
            self.db.execute(sql)

    def add_project(self, project):
        self.db.execute("""INSERT INTO rehearsal_projects
            (id,title,status,revision,script_version,deck_version,algorithm_version,updated_at,document_json)
            VALUES (?,?,'draft',0,'s','d','a','2026-01-01','{}')""", (project, project))
        self.db.execute('INSERT INTO studio_usage (project_id) VALUES (?)', (project,))

    def effective(self):
        return self.db.execute('SELECT * FROM studio_r2_effective_policy ORDER BY project_id').fetchall()

    def reserve(self, id, project, size):
        self.db.execute("""INSERT INTO studio_r2_uploads
            (id,project_id,kind,mime,bytes,hash,object_key,expires_at)
            VALUES (?,?,'pptx','test',?,?,?,1)""", (id, project, size, 'a'*64, 'studio/e3/'+project+'/'+id))

    def test_modes_and_reservation_fences(self):
        self.assertEqual(self.effective(), [('pilot', 20971520)])
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'studio_quota_exceeded'):
            self.reserve('a', 'ordinary', 100)
        self.db.execute("UPDATE studio_r2_site_policy SET mode='all' WHERE id=1")
        self.add_project('future')
        self.assertEqual([r[0] for r in self.effective()], ['future','ordinary','pilot'])
        self.reserve('a', 'ordinary', 20971520)
        self.reserve('b', 'future', 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM studio_r2_write_policy').fetchone(), (1,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'studio_quota_exceeded'):
            self.reserve('oversize', 'ordinary', 20971521)
        self.db.execute("INSERT INTO studio_r2_write_blocks VALUES ('ordinary')")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'studio_quota_exceeded'):
            self.reserve('blocked', 'ordinary', 1)
        self.db.execute("UPDATE studio_r2_site_policy SET mode='off' WHERE id=1")
        self.assertEqual(self.effective(), [])
        self.assertEqual(self.db.execute('SELECT count(*) FROM studio_r2_uploads').fetchone(), (2,))

    def test_cross_store_project_and_bucket_reservations(self):
        self.db.execute("UPDATE studio_r2_site_policy SET mode='all',max_deck_bytes=52428800 WHERE id=1")
        for n in range(6):
            self.reserve(str(n), 'ordinary', 52428800)
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'studio_quota_exceeded'):
            self.reserve('project-overage', 'ordinary', 1)
        self.db.execute("INSERT INTO studio_r2_verified VALUES ('retired','tag',7685427200,?)", ('b'*64,))
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'studio_quota_exceeded'):
            self.reserve('site-overage', 'pilot', 1)


if __name__ == '__main__':
    unittest.main()
