import hashlib
from importlib import import_module
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path('scripts').resolve()))
copy = import_module('rehearsal-r2-copy-batch')
SPAY = b'original D1 fixture contents'
SUM = hashlib.sha256(SPAY).hexdigest()
ETAG = hashlib.md5(SPAY).hexdigest()


class Migrate(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute('PRAGMA foreign_keys=ON')
        self.now = 10000
        self.db.create_function('unixepoch', 0, lambda: self.now)
        for path in sorted(Path('migrations').glob('*.sql')):
            self.db.executescript(path.read_text())
        document = json.dumps({'sourceDeck': {'id': 'legacy'}, 'slides': []})
        self.db.execute("""INSERT INTO rehearsal_projects
         (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at)
         VALUES('p','p','draft',0,'s','d','a',?,'now')""", (document,))
        self.db.execute("INSERT INTO studio_usage(project_id) VALUES('p')")
        self.db.execute("INSERT INTO rehearsal_files VALUES('legacy','p','pptx','test',?,?, 'first')", (len(SPAY), SUM))
        self.db.execute("INSERT INTO rehearsal_file_chunks VALUES('legacy',0,?)", (SPAY,))
        self.key = 'studio/e3/p/e4-legacy-' + SUM[:16]

    def reserve(self):
        self.db.execute("""INSERT INTO studio_r2_migration_jobs(file_id,project_id,object_key,bytes,hash,source_created_at,reserved_at)
         VALUES('legacy','p',?,?,?,'first',unixepoch()*1000)""", (self.key, len(SPAY), SUM))

    def test_immutable_backup_and_resume(self):
        self.reserve()
        self.assertEqual(self.db.execute('SELECT bytes FROM studio_r2_accounted_bytes').fetchone()[0], len(SPAY))
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'rehearsal_chunk_protected'):
            self.db.execute("DELETE FROM rehearsal_file_chunks WHERE file_id='legacy'")
        receipt = [{'id': 'legacy', 'etag': ETAG}]
        attached = copy.compile_update(receipt, 'attach')
        self.assertEqual(len(self.db.execute(attached).fetchall()), 1)
        self.assertEqual(len(self.db.execute(attached).fetchall()), 0)
        self.assertEqual(self.db.execute('SELECT state FROM studio_r2_media').fetchone()[0], 'dual')
        self.assertEqual(self.db.execute('SELECT bytes FROM studio_r2_accounted_bytes').fetchone()[0], len(SPAY))
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'recovery_required'):
            self.db.execute("UPDATE studio_r2_migration_jobs SET state='reclaimed'")
        files, other = copy.inventory.media_inventory(self.db)
        self.assertEqual(files[0].refs, {'current-draft': 1})
        self.assertEqual(copy.inventory.summary(files, other)['d1ChunkBytes'], len(SPAY))
        with tempfile.TemporaryDirectory() as directory:
            # Restore the entire independent SQLite snapshot + R2 copy and
            # validate them before providing a recovery digest to the ledger.
            path = Path(directory)
            restored = sqlite3.connect(path/'restore.sqlite')
            restored.executescript('\n'.join(self.db.iterdump()))
            restored.close()
            obj = path / hashlib.sha256(self.key.encode()).hexdigest()
            obj.write_bytes(SPAY)
            recovery = copy.joint.verifier.verify(path/'restore.sqlite', path)
            self.assertEqual(recovery['integrity'], 'ok')
            reclaim = copy.compile_update(receipt, 'reclaim', recovery['backup_sha256'])
        self.assertFalse(self.db.execute(reclaim).fetchall(), 'no D1 deletion within the safety window')
        self.now += 301
        document = self.db.execute('SELECT document_json FROM rehearsal_projects').fetchone()[0]
        self.assertEqual(len(self.db.execute(reclaim).fetchall()), 1)
        self.assertEqual(len(self.db.execute(reclaim).fetchall()), 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM rehearsal_file_chunks').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT state FROM studio_r2_media').fetchone()[0], 'r2')
        self.assertEqual(self.db.execute('SELECT document_json FROM rehearsal_projects').fetchone()[0], document)
        self.assertEqual(tuple(self.db.execute('SELECT id,project_id,hash FROM rehearsal_files').fetchone()),
                         ('legacy', 'p', SUM))
        self.assertFalse(self.db.execute('PRAGMA foreign_key_check').fetchall())

    def test_concurrent_legacy_removal_keeps_reservation(self):
        self.reserve()
        self.db.execute("DELETE FROM rehearsal_files WHERE id='legacy'")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'source_changed'):
            self.db.execute(copy.compile_update([{'id':'legacy', 'etag':ETAG}], 'attach'))
        self.assertEqual(self.db.execute('SELECT count(*) FROM studio_r2_media').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT bytes FROM studio_r2_accounted_bytes').fetchone()[0], len(SPAY))


if __name__ == '__main__':
    unittest.main()
