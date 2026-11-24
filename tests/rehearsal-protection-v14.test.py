import importlib.util
from pathlib import Path
import sqlite3
import unittest

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('foundation', root / 'tests/studio-migration-v14.test.py')
foundation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(foundation)

class Protection(unittest.TestCase):
    def setUp(self):
        self.fixture = foundation.FoundationMigration()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.db = self.fixture.db
        self.db.executescript(foundation.MIGRATION)
        self.db.execute("INSERT INTO rehearsal_releases VALUES ('legacy-a','r1',1,1,'{}','2026-11-04',NULL)")
        self.db.execute("INSERT INTO rehearsal_releases VALUES ('legacy-a','r2',2,1,'{}','2026-11-04',NULL)")
        self.db.execute("INSERT INTO rehearsal_release_heads VALUES ('legacy-a','r2')")
        for release in ('r1','r2'):
            self.db.execute("INSERT INTO rehearsal_release_turns VALUES ('legacy-a',?,'t1',0,'legacy-a-member',?,'[]','[]')",(release,'f'*64))
        for audio,release in ((0,'r1'),(1,'r2'),(2,'r2')):
            rid=f'legacy-a-audio-{audio}'
            self.db.execute("INSERT INTO rehearsal_recording_origins VALUES ('legacy-a',?,?,'t1')",(rid,release))
            self.db.execute("INSERT INTO rehearsal_recording_release_refs VALUES ('legacy-a',?,'t1',?,'2026-11-04')",(release,rid))
        self.db.execute("INSERT INTO rehearsal_recording_release_refs VALUES ('legacy-a','r2','t1','legacy-a-audio-0','2026-11-04')")
        self.db.execute("INSERT INTO rehearsal_playback_choices VALUES ('legacy-a','r2','t1','legacy-a-audio-1',1,'2026-11-04')")
        self.db.execute("UPDATE rehearsal_recordings SET locked=0 WHERE project_id='legacy-a'")
        self.db.commit()

    def test_switch_requires_protection(self):
        switch=(root/'migrations/0006_v14_retention_switch.sql').read_text()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.executescript(switch)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('rehearsal_keep_three','rehearsal_locked_limit')").fetchone(),(2,))
        self.db.executescript((root/'migrations/0005_v14_recording_protection.sql').read_text())
        before=self.fixture.snapshot(self.db)
        self.db.executescript(switch)
        self.db.executescript(switch)
        self.assertEqual(self.fixture.snapshot(self.db),before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('rehearsal_keep_three','rehearsal_locked_limit')").fetchone(),(0,))
        with self.assertRaisesRegex(sqlite3.IntegrityError,'protected'):
            self.db.execute("DELETE FROM rehearsal_files WHERE id='legacy-a-audio-0'")

    def test_install_guards_before_switch(self):
        before=self.fixture.snapshot(self.db)
        path=root/'migrations/0005_v14_recording_protection.sql'
        self.db.executescript(path.read_text())
        self.db.executescript(path.read_text())
        self.assertEqual(self.fixture.snapshot(self.db),before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('rehearsal_keep_three','rehearsal_locked_limit')").fetchone(),(2,))
        for rid in ('legacy-a-audio-0','legacy-a-audio-1'):
            for table,column in [('rehearsal_recordings','id'),('rehearsal_files','id'),
                                 ('rehearsal_recording_origins','recording_id'),('rehearsal_recording_release_refs','recording_id')]:
                with self.assertRaisesRegex(sqlite3.IntegrityError,'protected'):
                    self.db.execute(f'DELETE FROM {table} WHERE {column}=?',(rid,))
        self.db.execute("INSERT INTO rehearsal_audio_leases VALUES ('legacy-a','legacy-a-audio-2',9999999999999)")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'protected'):
            self.db.execute("DELETE FROM rehearsal_files WHERE id='legacy-a-audio-2'")
        self.db.execute("UPDATE rehearsal_audio_leases SET expires_at=0")
        self.db.execute("DELETE FROM rehearsal_files WHERE id='legacy-a-audio-2'")
        self.assertEqual(self.db.execute("SELECT count(*) FROM rehearsal_recordings WHERE project_id='legacy-a'").fetchone(),(2,))
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])
        self.db.execute("DELETE FROM rehearsal_projects WHERE id='legacy-a'")
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])
        self.assertEqual(self.db.execute("SELECT count(*) FROM rehearsal_recording_release_refs WHERE project_id='legacy-a'").fetchone(),(0,))

if __name__ == '__main__':
    unittest.main(verbosity=2)
