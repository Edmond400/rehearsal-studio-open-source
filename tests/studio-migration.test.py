import hashlib, importlib.util, json, os, sqlite3, subprocess, tempfile, unittest, io
from pptx import Presentation
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('migration',ROOT/'scripts/migrate-rehearsal.py');migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)

class Migration(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name);self.source=self.path/'source.sqlite';self.target=self.path/'target.sqlite';self.keys=self.path/'private/owners.json'
  db=sqlite3.connect(self.source)
  db.executescript((ROOT/'migrations/0001_rehearsal.sql').read_text())
  db.execute('CREATE TABLE birthday_private(name TEXT)');db.execute("INSERT INTO birthday_private VALUES ('MUST-NOT-BE-IMPORTED')")
  for pid in ['legacy-a','legacy-b']:
   doc={'id':pid,'title':'示例历史汇报','status':'published','members':[{'id':pid+'-speaker','name':'示例组员','enabled':True}],'slides':[{'id':pid+'-slide','pageIndex':0,'bytes':8,'mime':'image/png'}],'blocks':[{'id':'block','paragraphId':'block','text':'历史文字原样保留。','memberId':pid+'-speaker','slideIndex':0,'nonspoken':False,'paragraphEnd':True}],'revision':1,'scriptVersion':'s1','deckVersion':'d1','algorithmVersion':'a1','config':{},'overrides':{}}
   raw=json.dumps(doc,ensure_ascii=False)
   db.execute('INSERT INTO rehearsal_projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[pid,doc['title'],'published',1,'s1','d1','a1',raw,'before','legacy-scrypt-not-trusted',7,raw,None])
   db.execute('INSERT INTO rehearsal_versions VALUES (?,?,?,?)',[pid,1,raw,'before'])
   db.execute('INSERT INTO rehearsal_members VALUES (?,?,?,1)',[pid+'-speaker',pid,'示例组员'])
   deck=Presentation();deck.slides.add_slide(deck.slide_layouts[6]);stream=io.BytesIO();deck.save(stream)
   for kind,content in [('slide',b'12345678'),('audio',b'\x1a\x45\xdf\xa3audio'),('pptx',stream.getvalue())]:
    fid=pid+'-'+kind;db.execute('INSERT INTO rehearsal_files VALUES (?,?,?,?,?,?,?)',[fid,pid,kind,'image/png' if kind=='slide' else 'application/vnd.openxmlformats-officedocument.presentationml.presentation' if kind=='pptx' else 'audio/webm',len(content),hashlib.sha256(content).hexdigest(),'before']);db.execute('INSERT INTO rehearsal_file_chunks VALUES (?,0,?)',[fid,content])
   snapshot=json.dumps({'slides':doc['slides']});db.execute('INSERT INTO rehearsal_recordings(id,project_id,member_id,turn_id,script_version,deck_version,algorithm_version,duration_ms,submitted_at,predicted_seconds,snapshot_json,events_json,metadata_json,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[pid+'-audio',pid,pid+'-speaker','turn-block','s1','d1','a1',1000,'before',1,snapshot,'[{"t_ms":0,"slide_index":0,"source":"start"}]','{}','hash'])
   db.execute('INSERT INTO rehearsal_estimates VALUES (?,?,?,?,?,?)',[pid+'-estimate',pid,1,'a1','{"exact":"历史测算"}','before'])
   db.execute('INSERT INTO rehearsal_access_sessions VALUES (?,?,?,?)',[pid+'-old-session',pid,7,9999999999999])
  db.commit();db.close();self.source_hash=hashlib.sha256(self.source.read_bytes()).hexdigest()
 def tearDown(self):self.temp.cleanup()
 def test_dry_run_and_full_roundtrip(self):
  r=migration.migrate(self.source,None,None);self.assertEqual(r['mode'],'dry-run');self.assertFalse(self.target.exists());self.assertEqual(r['counts']['rehearsal_recordings'],2)
  r=migration.migrate(self.source,self.target,self.keys,True);self.assertTrue(r['source_target_rows_equal']);self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(),self.source_hash)
  db=sqlite3.connect(self.target);names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")};self.assertNotIn('birthday_private',names);self.assertEqual(db.execute('SELECT count(*) FROM rehearsal_access_sessions').fetchone()[0],0);self.assertEqual(db.execute('SELECT count(*) FROM studio_sessions').fetchone()[0],0)
  self.assertEqual(db.execute('SELECT count(*) FROM rehearsal_turn_progress').fetchone()[0],2);self.assertEqual(db.execute('SELECT count(*) FROM rehearsal_recordings').fetchone()[0],2);self.assertEqual(list(db.execute('PRAGMA foreign_key_check')),[])
  keys=json.loads(self.keys.read_text())['projects'];self.assertEqual(len(keys),2);self.assertEqual(os.stat(self.keys).st_mode&0o777,0o600)
  for k in keys:
   self.assertEqual(len(k['owner_key']),64);self.assertEqual(db.execute('SELECT secret_digest FROM studio_owner_credentials WHERE project_id=?',[k['project_id']]).fetchone()[0],hashlib.sha256(k['owner_key'].encode()).hexdigest());self.assertIsNone(db.execute('SELECT password_hash FROM rehearsal_projects WHERE id=?',[k['project_id']]).fetchone()[0])
  db.close()
 def test_corruption_refused_without_target(self):
  db=sqlite3.connect(self.source);db.execute("UPDATE rehearsal_file_chunks SET data=X'00' WHERE file_id='legacy-a-audio'");db.commit();db.close()
  with self.assertRaisesRegex(ValueError,'SHA-256'):migration.migrate(self.source,self.target,self.keys,True)
  self.assertFalse(self.target.exists());self.assertFalse(self.keys.exists())
 def test_cross_project_slide_refused(self):
  db=sqlite3.connect(self.source);row=db.execute("SELECT document_json FROM rehearsal_projects WHERE id='legacy-a'").fetchone();doc=json.loads(row[0]);doc['slides'][0]['id']='legacy-b-slide';db.execute("UPDATE rehearsal_projects SET document_json=? WHERE id='legacy-a'",[json.dumps(doc)]);db.commit();db.close()
  with self.assertRaisesRegex(ValueError,'cross-project'):migration.migrate(self.source,self.target,self.keys,True)
  self.assertFalse(self.keys.exists())
 def test_existing_target_and_same_source_refused(self):
  with self.assertRaises(ValueError):migration.migrate(self.source,self.source,self.keys,True)
  migration.migrate(self.source,self.target,self.keys,True)
  with self.assertRaises(ValueError):migration.migrate(self.source,self.target,self.path/'other-keys.json',True)
  self.assertFalse((self.path/'other-keys.json').exists())

if __name__=='__main__':unittest.main(verbosity=2)
