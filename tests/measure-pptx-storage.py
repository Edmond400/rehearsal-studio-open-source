"""Measure physical SQLite pages using actual generated PPTX and browser JPEG bytes."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

root = Path(sys.argv[1])
results = json.loads((root / 'browser-results.json').read_text())
now = '2026-11-05T07:00:00.000Z'
with tempfile.TemporaryDirectory() as directory:
    db = sqlite3.connect(Path(directory) / 'measurement.sqlite')
    db.execute('PRAGMA foreign_keys=ON')
    for migration in sorted(Path('migrations').glob('*.sql')):
        db.executescript(migration.read_text())
    def physical():
        db.commit()
        return db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0]
    db.execute("""INSERT INTO rehearsal_projects
        (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at)
        VALUES ('sample','synthetic','draft',0,'s','d','a','{}',?)""", (now,))
    db.execute("INSERT INTO studio_usage VALUES ('sample',62914560)")
    baseline = physical()
    total = {'pptx': 0, 'slide': 0}
    docs = []
    for deck_no, deck in enumerate(results['results'], 1):
        slides = []
        source = deck['name']
        def add(path, kind, file_id, mime):
            data = path.read_bytes()
            total[kind] += len(data)
            db.execute("INSERT INTO rehearsal_files VALUES (?,'sample',?,?,?,?,?)",
                       (file_id,kind,mime,len(data),hashlib.sha256(data).hexdigest(),now))
            for offset in range(0, len(data), 524288):
                db.execute('INSERT INTO rehearsal_file_chunks VALUES (?,?,?)',
                           (file_id,offset//524288,data[offset:offset+524288]))
            return len(data)
        source_bytes = add(root/'fixtures'/source, 'pptx', f'file-{deck_no}', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
        for i, p in enumerate(deck['pages']):
            slide_id = f'preview-{deck_no}-{i}'
            payload = add(root/(source.replace('.pptx','')+f'-{i+1}.jpg'), 'slide', slide_id, 'image/jpeg')
            slides.append({'id': slide_id, 'pageIndex': i,'sourcePage':p['path'],'sourceId':p['sourceId'],'bytes':payload,'mime':'image/jpeg'})
        document = dict(id='sample',title='测试工作稿',slides=slides,sourceDeck=dict(id=f'file-{deck_no}',pages=[s['sourcePage'] for s in slides],bytes=source_bytes),
                        blocks=[dict(id=f'p{i}',paragraphId=f'p{i}',text='独立测试讲稿与版面核对。'*6,slideIndex=i%len(slides),memberId='a',paragraphEnd=True,nonspoken=False) for i in range(120)])
        docs.append(json.dumps(document,ensure_ascii=False,separators=(',',':')))
    media_physical = physical()-baseline
    for n,doc in enumerate(docs,1):
        db.execute('INSERT INTO rehearsal_versions VALUES (?,?,?,?)', ('sample',n,doc,now))
        db.execute('INSERT INTO rehearsal_releases VALUES (?,?,?,?,?,?,?)', ('sample',f'r{n}',n,n,doc,now,None))
        db.execute('INSERT INTO rehearsal_draft_checkpoints VALUES (?,?,?,?,?,?)', ('sample',f'c{n}',n,doc,'test',now))
    print(json.dumps({'decks':len(docs),'originalPptxBytes':total['pptx'],'previewBytes':total['slide'],
                      'filePageDeltaBytes':media_physical,'snapshotRows':len(docs)*3,'snapshotJsonBytes':sum(len(d.encode()) for d in docs)*3,
                      'snapshotPageDeltaBytes':physical()-baseline-media_physical,'pageSizeBytes':db.execute('PRAGMA page_size').fetchone()[0]},indent=2))
