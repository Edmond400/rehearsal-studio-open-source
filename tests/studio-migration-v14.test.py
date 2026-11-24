import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('verify_backup', ROOT / 'scripts/verify-studio-backup.py')
verify_backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_backup)
MIGRATION = (ROOT / 'migrations/0004_v14_foundation.sql').read_text()


class FoundationMigration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.db = self.connect('before.sqlite')
        for f in sorted((ROOT / 'migrations').glob('000[123]*.sql')):
            self.db.executescript(f.read_text())
        self.seed('legacy-a', True)
        self.seed('legacy-b', False)
        self.db.commit()

    def connect(self, name):
        db = sqlite3.connect(self.path / name)
        db.execute('PRAGMA foreign_keys=ON')
        self.addCleanup(db.close)
        return db

    def seed(self, pid, published):
        p = {'id': pid, 'title': 'Synthetic rehearsal', 'status': 'published' if published else 'draft',
             'members': [{'id': pid + '-member', 'name': 'Synthetic', 'enabled': True}],
             'slides': [], 'blocks': [], 'config': {'hardLimitSeconds': 900}}
        document = json.dumps(p)
        self.db.execute("""INSERT INTO rehearsal_projects
            (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at,published_json)
            VALUES (?,?,?,1,'s','d','a',?,'2026-11-04',?)""",
            (pid,p['title'],p['status'],document,document if published else None))
        self.db.execute('INSERT INTO rehearsal_versions VALUES (?,1,?,?)', (pid,document,'2026-11-04'))
        self.db.execute('INSERT INTO studio_usage(project_id) VALUES (?)', (pid,))
        self.db.execute('INSERT INTO studio_owner_credentials VALUES (?,?,1)', (pid,'synthetic-digest'))
        self.db.execute('INSERT INTO rehearsal_members VALUES (?,?,?,1)', (pid+'-member',pid,'Synthetic'))
        for i in range(3 if published else 1):
            fid = f'{pid}-audio-{i}'
            content = b'\x1a\x45\xdf\xa3' + f'synthetic-{i}'.encode()
            self.db.execute("INSERT INTO rehearsal_files VALUES (?,?,'audio','audio/webm',?,?,?)",
                            (fid,pid,len(content),hashlib.sha256(content).hexdigest(),'2026-11-04'))
            self.db.execute('INSERT INTO rehearsal_file_chunks VALUES (?,0,?)',(fid,content))
            self.db.execute("""INSERT INTO rehearsal_recordings
                (id,project_id,member_id,turn_id,script_version,deck_version,algorithm_version,duration_ms,submitted_at,
                 locked,predicted_seconds,snapshot_json,events_json,metadata_json,request_hash)
                VALUES (?,?,?,'turn-synthetic',?,'d','a',1000,'2026-11-04',1,1,'{}','[]','{}','synthetic')""",
                (fid,pid,pid+'-member',f's{i}'))

    def snapshot(self, db):
        return {t: db.execute(f'SELECT * FROM {t} ORDER BY 1,2').fetchall() for t in
                ['rehearsal_projects','rehearsal_versions','rehearsal_members','rehearsal_recordings','rehearsal_files',
                 'rehearsal_file_chunks','rehearsal_turn_progress','studio_owner_credentials']}

    def test_backup_restore_migrate_and_reenter(self):
        before = self.snapshot(self.db)
        manifest = verify_backup.verify(self.path/'before.sqlite')
        backup = self.connect('isolated-backup.sqlite')
        self.db.backup(backup)
        restored = self.connect('rehearsed.sqlite')
        backup.backup(restored)
        self.assertEqual(self.snapshot(restored),before)
        restored.executescript(MIGRATION)
        restored.executescript(MIGRATION)
        self.assertEqual(self.snapshot(restored),before)
        self.assertEqual(verify_backup.verify(self.path/'rehearsed.sqlite')['files'],manifest['files'])
        self.assertEqual(verify_backup.verify(self.path/'before.sqlite'),manifest)
        self.assertEqual(restored.execute('SELECT count(*) FROM studio_project_visibility').fetchone(),(0,))
        self.assertEqual(restored.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('rehearsal_keep_three','rehearsal_locked_limit')").fetchone(),(2,))
        self.assertEqual(restored.execute('SELECT count(*) FROM rehearsal_recordings WHERE locked=1').fetchone(),(4,))
        # Roll back by restoring into a separate file, preserving both copies.
        rollback = self.connect('rollback.sqlite')
        backup.backup(rollback)
        self.assertEqual(self.snapshot(rollback),before)

    def test_transaction_failure_and_foreign_keys(self):
        original = self.snapshot(self.db)
        with self.assertRaises(sqlite3.OperationalError):
            self.db.executescript('BEGIN;\n'+MIGRATION+'\nSELECT * FROM intentionally_missing;\nCOMMIT;')
        self.db.rollback()
        self.assertIsNone(self.db.execute("SELECT name FROM sqlite_master WHERE name='studio_admin_passwords'").fetchone())
        self.assertEqual(self.snapshot(self.db),original)
        self.db.executescript(MIGRATION)
        for pid in ['legacy-a','legacy-b']:
            self.db.execute("INSERT INTO rehearsal_releases VALUES (?, 'r1',1,1,'{}','2026-11-04',NULL)",(pid,))
            self.db.execute("INSERT INTO rehearsal_release_turns VALUES (?, 'r1','t1',0,?,?,'[]','[]')",(pid,pid+'-member','a'*64))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO rehearsal_recording_origins VALUES ('legacy-b','legacy-a-audio-0','r1','t1')")
        self.db.execute("INSERT INTO rehearsal_recording_origins VALUES ('legacy-a','legacy-a-audio-0','r1','t1')")
        self.db.execute("INSERT INTO rehearsal_recording_release_refs VALUES ('legacy-a','r1','t1','legacy-a-audio-0','2026-11-04')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO rehearsal_playback_choices VALUES ('legacy-b','r1','t1','legacy-a-audio-0',1,'2026-11-04')")
        self.db.execute("INSERT INTO rehearsal_releases VALUES ('legacy-a','r2',2,1,'{}','2026-11-04',NULL)")
        self.db.execute("INSERT INTO rehearsal_release_turns VALUES ('legacy-a','r2','t1',0,'legacy-a-member',?,'[]','[]')",('b'*64,))
        with self.assertRaisesRegex(sqlite3.IntegrityError,'reference_incompatible'):
            self.db.execute("INSERT INTO rehearsal_recording_release_refs VALUES ('legacy-a','r2','t1','legacy-a-audio-0','2026-11-04')")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'immutable'):
            self.db.execute("UPDATE rehearsal_releases SET snapshot_json='{\"changed\":1}' WHERE project_id='legacy-a'")
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_verifier_detects_corrupt_chunk(self):
        self.db.execute("UPDATE rehearsal_file_chunks SET data=X'01' WHERE file_id='legacy-a-audio-0'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'):
            verify_backup.verify(self.path/'before.sqlite')


if __name__ == '__main__':
    unittest.main(verbosity=2)
