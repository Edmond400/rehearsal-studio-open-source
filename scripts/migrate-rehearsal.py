#!/usr/bin/env python3
"""Read-only source rehearsal migration. Default dry-run; isolated SQLite target only.
Never connects to Cloudflare or mutates the source. Never imports class tables or
legacy sessions. Keep source snapshots and --credentials-out outside Git.
"""
import argparse, hashlib, json, os, secrets, sqlite3
from pathlib import Path

TABLES = ['rehearsal_projects','rehearsal_versions','rehearsal_members',
          'rehearsal_files','rehearsal_file_chunks','rehearsal_recordings',
          'rehearsal_estimates','rehearsal_turn_progress']

def connect_readonly(path):
    db=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    return db

def read_source(path):
    with connect_readonly(path) as db:
        names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not set(TABLES)<=names:
            raise ValueError('Source lacks required multi-report rehearsal tables')
        # Do not inspect unrelated class tables or their contents.
        data={t:[dict(r) for r in db.execute('SELECT * FROM '+t)] for t in TABLES}
    ids={r['id'] for r in data['rehearsal_projects']}
    members={r['id']:r['project_id'] for r in data['rehearsal_members']}
    files={r['id']:r for r in data['rehearsal_files']}
    chunks={}
    for c in data['rehearsal_file_chunks']:
        if c['file_id'] not in files: raise ValueError('Orphan file chunk')
        chunks.setdefault(c['file_id'],[]).append(c)
    for t in TABLES:
        for row in data[t]:
            if 'project_id' in row and row['project_id'] not in ids:
                raise ValueError('Orphan project reference in '+t)
    for f in files.values():
        parts=sorted(chunks.get(f['id'],[]),key=lambda c:c['chunk_index'])
        if [c['chunk_index'] for c in parts]!=list(range(len(parts))):
            raise ValueError('Missing or duplicated chunk index')
        h=hashlib.sha256();size=0
        for c in parts: h.update(c['data']);size+=len(c['data'])
        if size!=f['bytes'] or h.hexdigest()!=f['hash']:
            raise ValueError('File bytes/SHA-256 mismatch; migration refused')
    for r in data['rehearsal_recordings']:
        if r['id'] not in files or files[r['id']]['project_id']!=r['project_id'] or members.get(r['member_id'])!=r['project_id']:
            raise ValueError('Cross-project recording reference')
        snapshot=json.loads(r['snapshot_json'])
        for s in snapshot.get('slides',[]):
            if s['id'] not in files or files[s['id']]['project_id']!=r['project_id']:
                raise ValueError('Cross-project recording slide')
    docs=[]
    for p in data['rehearsal_projects']:
        docs.append((p['id'],p['document_json']))
        if p.get('published_json'):docs.append((p['id'],p['published_json']))
    docs += [(r['project_id'],r['document_json']) for r in data['rehearsal_versions']]
    for pid,raw in docs:
        doc=json.loads(raw)
        if doc.get('id')!=pid:raise ValueError('Document/project identity mismatch')
        slide_ids={s['id'] for s in doc.get('slides',[])}
        if doc.get('sourceDeck'):slide_ids.add(doc['sourceDeck']['id'])
        if any(s not in files or files[s]['project_id']!=pid for s in slide_ids):
            raise ValueError('Missing or cross-project document file')
        mids={m['id'] for m in doc.get('members',[])}
        for b in doc.get('blocks',[]):
            if b.get('memberId') and b['memberId'] not in mids:raise ValueError('Invalid document speaker')
            i=b.get('slideIndex')
            if i is not None and not 0<=i<len(doc.get('slides',[])):raise ValueError('Invalid slide mapping')
    return data

def summary(data):
    return {'mode':'validated-source','counts':{t:len(v) for t,v in data.items()},
            'file_bytes':sum(r['bytes'] for r in data['rehearsal_files']),
            'all_file_sha256_verified':True,
            'legacy_sessions_imported':False,'class_tables_imported':False}

def migrate(source,target,credentials_out,apply=False):
    data=read_source(source);report=summary(data)
    if not apply:return dict(report,mode='dry-run',source_modified=False,target_modified=False)
    target=Path(target).resolve();credentials=Path(credentials_out).resolve()
    if target==Path(source).resolve() or credentials in [target,Path(source).resolve()]:
        raise ValueError('Source, target and credential paths must differ')
    if credentials.exists():raise ValueError('Refusing to overwrite recovery credentials')
    if report['file_bytes']>180*1024*1024:raise ValueError('Global file quota exceeded')
    per_project={p['id']:sum(f['bytes'] for f in data['rehearsal_files'] if f['project_id']==p['id']) for p in data['rehearsal_projects']}
    if any(n>90*1024*1024 for n in per_project.values()):raise ValueError('Historical project exceeds maximum 90MiB quota')
    credentials.parent.mkdir(parents=True,exist_ok=True)
    fresh=not target.exists();db=sqlite3.connect(target);db.row_factory=sqlite3.Row
    private_keys=[];credential_written=False
    try:
        db.execute('PRAGMA foreign_keys=ON')
        if fresh:
            for sql in sorted((Path(__file__).resolve().parent.parent/'migrations').glob('*.sql')):
                db.executescript(sql.read_text())
        if db.execute('SELECT count(*) FROM rehearsal_projects').fetchone()[0]:
            raise ValueError('Target must be an empty isolated database; merge is refused')
        db.execute('BEGIN')
        # Preserve historical rows and keep the import outside live operations statistics.
        saved_triggers=list(db.execute("""SELECT name,sql FROM sqlite_master WHERE type='trigger'
            AND (name IN ('rehearsal_keep_three','rehearsal_mark_turn_submitted','rehearsal_locked_limit')
                 OR name GLOB 'studio_ops_*')"""))
        for tr in saved_triggers:db.execute('DROP TRIGGER '+tr['name'])
        for table in TABLES:
            for original in data[table]:
                row=dict(original)
                if table=='rehearsal_projects':
                    row['password_hash']=None # old scrypt/shared codes are never trusted in the new product
                    row['credential_version']=1
                    row['archived_at']=row.get('deleted_at');row['deleted_at']=None
                columns=list(row)
                db.execute('INSERT INTO '+table+'('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',[row[k] for k in columns])
                if table=='rehearsal_projects':
                    key=secrets.token_hex(32);pid=row['id'];private_keys.append({'project_id':pid,'owner_key':key,'code_requires_reset':True})
                    db.execute('INSERT INTO studio_owner_credentials VALUES (?,?,1)',[pid,hashlib.sha256(key.encode()).hexdigest()])
                    db.execute('INSERT INTO studio_usage VALUES (?,?)',[pid,max(60*1024*1024,per_project[pid])])
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_ops_start'").fetchone():
            db.execute('UPDATE studio_ops_start SET total_projects=(SELECT count(*) FROM rehearsal_projects) WHERE id=1')
        for tr in saved_triggers:db.execute(tr['sql'])
        if list(db.execute('PRAGMA foreign_key_check')):raise ValueError('Target foreign key check failed')
        db.execute('PRAGMA defer_foreign_keys=ON')
        # Verify byte-for-byte preservation, excluding credentials/archive adapter fields.
        for table in TABLES:
            columns=list(data[table][0]) if data[table] else []
            exclude={'password_hash','credential_version','deleted_at'} if table=='rehearsal_projects' else set()
            columns=[c for c in columns if c not in exclude]
            if not columns:continue
            before=sorted([tuple(repr(r[c]) for c in columns) for r in data[table]])
            after=sorted([tuple(repr(r[c]) for c in columns) for r in db.execute('SELECT * FROM '+table)])
            if before!=after:raise ValueError('Target content comparison failed: '+table)
        fd=os.open(credentials,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:
            json.dump({'warning':'Private once-only owner credentials. Never commit or publish.','projects':private_keys},f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
        credential_written=True
        db.commit()
    except Exception:
        db.rollback()
        if credential_written:credentials.unlink(missing_ok=True)
        raise
    finally:db.close()
    return dict(report,mode='isolated-target-migration',source_modified=False,target_modified=True,
                credential_file_created=True,source_target_rows_equal=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True);parser.add_argument('--target');parser.add_argument('--credentials-out');parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    if args.apply and (not args.target or not args.credentials_out):parser.error('--apply requires --target and --credentials-out')
    try:print(json.dumps(migrate(args.source,args.target,args.credentials_out,args.apply),ensure_ascii=False,indent=2))
    except (ValueError,sqlite3.Error,OSError) as e:parser.exit(1,'Migration refused: '+str(e)+'\n')
