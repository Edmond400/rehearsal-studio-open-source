import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {cp,mkdtemp,readFile,readdir,rm,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {zipSync,unzipSync} from 'fflate';

const require=createRequire(import.meta.url),search=[dirname(require.resolve('wrangler/package.json'))];
const {build}=require(require.resolve('esbuild',{paths:search}));
const {Miniflare}=require(require.resolve('miniflare',{paths:search}));
const bin=await build({stdin:{contents:`
 import {apiCors} from './lib/http';
 import {handleProjects} from './lib/projects';
 import {handleRehearsal} from './lib/rehearsal/service';
 import {operationsOverview} from './lib/platform/operations';
 import {DEFAULT_CONFIG} from './lib/rehearsal/model';
 export default {fetch(request){
  const [,api,root,...parts]=new URL(request.url).pathname.split('/');
  if(root==='test-config')return Response.json(DEFAULT_CONFIG);
  if(root==='test-storage')return operationsOverview(new URLSearchParams()).then(x=>Response.json({storage:x.storage,fileBytes:x.fileBytes}));
  return apiCors(request,()=>root==='projects'?handleProjects(request,parts):handleRehearsal(request,parts));
 }};
`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',
 external:['cloudflare:workers','node:*']});
const temp=await mkdtemp(join(tmpdir(),'studio-r2-recovery-'));
const d1=join(temp,'db-live'),isolated=join(temp,'db-recovered');
const studio='https://studio.test',native='https://localhost',editor='r2-fixture-editor';
const MiB=1024*1024,partBytes=5*MiB,hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jpg=Buffer.from([255,216,255,224,1,2,3,4]);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const audio=Buffer.alloc(6*MiB);audio.set([0x1a,0x45,0xdf,0xa3]);
const bindings={STUDIO_PASSWORD_PEPPER:'5'.repeat(64),STUDIO_R2_READS:'on',NATIVE_APP_ORIGIN:native};
const options=(d1Persist,writes)=>({modules:true,script:bin.outputFiles[0].text,compatibilityDate:'2026-05-15',
 compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist,r2Buckets:['STUDIO_MEDIA'],
 bindings:{...bindings,STUDIO_R2_WRITES:writes}});
let mf=new Miniflare(options(d1,'on'));
let live=mf;
const call=(path,{project='pilot',secret=editor,body,bytes,extra={},method}={})=>mf.dispatchFetch(studio+'/api/'+path,{
 method:method??(body!==undefined||bytes?'POST':'GET'),
 headers:{Origin:native,'X-Studio-Transport':'bearer','X-Studio-Project':project,'X-Studio-Session':secret,
  ...(body!==undefined?{'Content-Type':'application/json'}:bytes?{'Content-Type':'application/octet-stream'}:{}),...extra},
 body:bytes??(body!==undefined?JSON.stringify(body):undefined)});
async function ok(res,status=200){
 assert.equal(res.status,status,await res.clone().text());return res.json();
}
const r2='rehearsal/r2-uploads';
const stages=new Map();
const begin=async(info,options)=>{
 const response=await call(r2,{...options,body:info});
 if(response.ok){const {id,session}=await response.clone().json();stages.set(id,session);}
 return response;
};
const withSession=(id,options)=>({...options,extra:{...(stages.get(id)?{'X-Rehearsal-Metadata':stages.get(id)}:{}),...options?.extra}});
const put=(id,index,bytes,options)=>call(r2+'/'+id+'/'+index,{...withSession(id,options),bytes});
const finish=(id,body,options)=>call(r2+'/'+id+'/finish',{...withSession(id,options),body});
const cancel=(id,options)=>call(r2+'/'+id+'/cancel',{...withSession(id,options),body:{}});
const deckInput=bytes=>({kind:'pptx',hash:hash(bytes),bytes:bytes.length});
const cleanDocument=({id,scriptVersion,deckVersion,algorithmVersion,updatedAt,...body})=>body;
async function download(route,bytes,options){
 const res=await call(route,options);assert.equal(res.status,200);
 const length=res.headers.get('Content-Length');
 if(length!==null)assert.equal(Number(length),bytes.length);
 const body=Buffer.from(await res.arrayBuffer());
 assert.equal(body.length,bytes.length);
 assert.equal(hash(body),hash(bytes));
}
async function upload(info,bytes,finishBody){
 const beginResult=await ok(await begin(info));
 for(let part=beginResult.next;part<Math.ceil(bytes.length/partBytes);part++){
  await ok(await put(beginResult.id,part,bytes.subarray(part*partBytes,(part+1)*partBytes)));
 }
 return ok(await finish(beginResult.id,finishBody));
}
try{
 const db=await mf.getD1Database('DB');
 async function migrate(name){
  const migration=await readFile(join('migrations',name),'utf8');
  for(const sql of migration.match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/gi)??[])await db.prepare(sql).run();
 }
 const e3Migration='0013_r2_uploads.sql', e35Migration='0014_r2_site_write_policy.sql';
 for(const name of (await readdir('migrations')).filter(f=>f.endsWith('.sql')&&f<e3Migration).sort())await migrate(name);
 const config=await ok(await call('test-config'));
 for(const project of ['pilot','plain']){
  const now=new Date().toISOString();
  const document={id:project,title:project,status:'draft',revision:0,scriptVersion:'s',deckVersion:'d',
   algorithmVersion:'a',updatedAt:now,config,theme:'',publishedAt:null,members:[],slides:[],blocks:[],overrides:{}};
  await db.batch([
   db.prepare("INSERT INTO rehearsal_projects (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at) VALUES (?,?,'draft',0,'s','d','a',?,?)").bind(project,project,JSON.stringify(document),now),
   db.prepare("INSERT INTO studio_sessions VALUES (?,?,'editor',0,?)").bind(hash(project==='pilot'?editor:'other'),project,Date.now()+600000),
   db.prepare('INSERT INTO studio_usage(project_id) VALUES (?)').bind(project),
  ]);
 }
 const legacy=await ok(await call('rehearsal/edit/slides',{bytes:jpg,extra:{'Content-Type':'image/jpeg'}}));
 await download('rehearsal/slides/'+legacy.id,jpg);
 await migrate(e3Migration);
 await migrate(e35Migration);
 await download('rehearsal/slides/'+legacy.id,jpg);
 assert.equal((await call(r2)).status,404);
 await db.prepare('INSERT INTO studio_r2_write_policy VALUES (?,?)').bind('pilot',20*MiB).run();
 assert.equal((await call(r2,{project:'plain',secret:'other'})).status,404);
 assert.equal((await call(r2,{secret:''})).status,401);
 assert.equal((await call(r2,{extra:{Origin:'https://evil.test',Cookie:'studio_session='+editor},body:{}})).status,403);
 await mkdir(join(temp,'pptx'));
 await mkdir(join(temp,'objects'));
 execFileSync('python',['-c',`from pptx import Presentation
from sys import argv
p=Presentation()
p.slides.add_slide(p.slide_layouts[0]).shapes.title.text='Isolated test'
p.save(argv[1])
`,join(temp,'pptx','base.pptx')]);
 const original=unzipSync(await readFile(join(temp,'pptx','base.pptx')));
 for(let i=0;i<4;i++)original['ppt/media/fixture'+i+'.jpg']=randomBytes(8*MiB);
 const deck=Buffer.from(zipSync(original,{level:0}));
 assert(deck.length>32*MiB&&deck.length<34*MiB);
 const info=deckInput(deck);
 assert.equal((await begin(info)).status,413);
 await db.batch([db.prepare('UPDATE studio_r2_site_policy SET max_deck_bytes=? WHERE id=1').bind(50*MiB),
  db.prepare('UPDATE studio_r2_write_policy SET max_deck_bytes=? WHERE project_id=?').bind(50*MiB,'pilot')]);
 assert.equal((await ok(await call(r2))).maxDeckBytes,50*MiB);
 const start=await ok(await begin(info)),id=start.id;
 assert.deepEqual(await ok(await begin(info)),start);
 assert.equal((await finish(id,{kind:'pptx'})).status,409);
 assert.equal((await put(id,1,deck.subarray(partBytes,2*partBytes))).status,409);
 assert.equal((await put(id,0,deck.subarray(0,partBytes-1))).status,400);
 const first=deck.subarray(0,partBytes);
 const raced=await Promise.all([put(id,0,first),put(id,0,first)]);
 assert(raced.some(res=>res.status===200));
 assert(raced.every(res=>[200,409].includes(res.status)));
 assert.equal((await ok(await begin(info))).next,1,'the server can resume after losing the first response');
 assert.equal((await ok(await put(id,0,first))).next,1);
 const changed=Buffer.from(first);changed[0]^=1;
 assert.equal((await put(id,0,changed)).status,409);
 for(let i=1;i<Math.ceil(deck.length/partBytes);i++)await ok(await put(id,i,deck.subarray(i*partBytes,(i+1)*partBytes)));
 assert.equal((await call('rehearsal/pptx/'+id)).status,404);
 await db.prepare("DELETE FROM studio_r2_write_policy WHERE project_id='pilot'").run();
 assert.equal((await finish(id,{kind:'pptx'})).status,404);
 await db.prepare('INSERT INTO studio_r2_write_policy VALUES (?,?)').bind('pilot',50*MiB).run();
 // R2 completes successfully, then D1 attach fails. A retry must reuse the
 // completed object and present exactly one logical media record.
 await db.prepare("CREATE TRIGGER test_fail_attach BEFORE INSERT ON studio_r2_media BEGIN SELECT RAISE(ABORT,'test attach'); END;").run();
 assert.equal((await finish(id,{kind:'pptx'})).status,500);
 assert.equal((await call('rehearsal/pptx/'+id)).status,404);
 await db.prepare('DROP TRIGGER test_fail_attach').run();
 const source=await ok(await finish(id,{kind:'pptx'}));
 assert.deepEqual(await ok(await finish(id,{kind:'pptx'})),source);
 assert.deepEqual(source.pages,['ppt/slides/slide1.xml']);
 assert.equal(source.bytes,deck.length);
 const r2Pptx='rehearsal/pptx/'+id;
 await download(r2Pptx,deck);
 const range=await call(r2Pptx,{extra:{Range:'bytes=5242877-5242889'}});
 assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),deck.subarray(5242877,5242890));
 assert.equal((await call(r2Pptx,{project:'plain',secret:'other'})).status,404);
 assert.equal((await call(r2Pptx,{secret:''})).status,401);
 const preview=await upload({kind:'slide',hash:hash(png),bytes:png.length,sourceId:source.sourceIds[0],mime:'image/png'},png,{kind:'slide'});
 await download('rehearsal/slides/'+preview.id,png);
 const draft=(await ok(await call('rehearsal/edit/draft'))).project;
 const document={...cleanDocument(draft),
  members:[{id:'speaker',name:'示例',enabled:true}],
  blocks:[{id:'speech',paragraphId:'speech',text:'E3验收。',memberId:'speaker',nonspoken:false,slideIndex:0,paragraphEnd:true}],
  slides:[{...preview,pageIndex:0,sourcePage:source.pages[0],sourceId:source.sourceIds[0]}],
  sourceDeck:{id,bytes:source.bytes,pages:source.pages},status:'published'};
 const p=(await ok(await call('rehearsal/edit',{body:document}))).project;
 const assembled=await build({stdin:{contents:"export {exportPptx} from './lib/rehearsal/pptx';",resolveDir:process.cwd()},
  bundle:true,format:'esm',platform:'node',write:false});
 const {exportPptx}=await import('data:text/javascript;base64,'+Buffer.from(assembled.outputFiles[0].text).toString('base64'));
 const downloaded=await call(r2Pptx);
 const exported=unzipSync(exportPptx(new Uint8Array(await downloaded.arrayBuffer()),p));
 assert(Object.keys(exported).some(name=>name.startsWith('ppt/notesSlides/')&&name.endsWith('.xml')));
 assert.deepEqual(Buffer.from(exported['ppt/media/fixture0.jpg']),Buffer.from(original['ppt/media/fixture0.jpg']));
 const recording={id:randomUUID(),memberId:'speaker',turnId:'turn-speech',scriptVersion:p.scriptVersion,deckVersion:p.deckVersion,
  algorithmVersion:p.algorithmVersion,durationMs:1000,mediaDurationMs:1000,clockDurationMs:1000,
  events:[{t_ms:0,slide_index:0,source:'start'}],hash:hash(audio)};
 const recordingInfo={kind:'audio',id:recording.id,mime:'audio/webm',bytes:audio.length,hash:recording.hash};
 const rec=await upload(recordingInfo,audio,{kind:'audio',mime:'audio/webm',recording});
 assert.equal((await ok(await finish(rec.id,{kind:'audio',mime:'audio/webm',recording}))).retried,true);
 await download('rehearsal/audio/'+rec.id,audio);
 const plain={project:'plain',secret:'other'};
 await db.prepare("UPDATE studio_r2_site_policy SET mode='all',max_deck_bytes=20971520 WHERE id=1").run();
 assert.equal((await ok(await call(r2,plain))).maxDeckBytes,20*MiB,'existing unlisted project receives the default without an allowlist entry');
 const allUpload=await ok(await begin({kind:'slide',bytes:png.length,hash:hash(png),sourceId:'90001',mime:'image/png'},plain));
 await ok(await put(allUpload.id,0,png,plain));
 await db.prepare("INSERT INTO studio_r2_write_blocks VALUES ('plain')").run();
 assert.equal((await finish(allUpload.id,{kind:'slide'},plain)).status,404,'project stop blocks an already started commit');
 assert.equal((await call(r2,plain)).status,404);
 await download('rehearsal/audio/'+rec.id,audio);
 await db.prepare("UPDATE studio_r2_site_policy SET mode='off' WHERE id=1").run();
 assert.equal((await call(r2)).status,404);
 await download(r2Pptx,deck);
 await db.prepare("UPDATE studio_r2_site_policy SET mode='pilot',max_deck_bytes=52428800 WHERE id=1").run();
 assert.equal((await db.prepare('SELECT count(*) AS n FROM rehearsal_file_chunks WHERE file_id IN (?,?,?)')
  .bind(id,preview.id,rec.id).first()).n,0);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM rehearsal_recording_release_refs WHERE recording_id=?')
  .bind(rec.id).first()).n,1);
 const budget=await ok(await call('test-storage'));
 assert.equal(budget.fileBytes,jpg.length+deck.length+png.length+audio.length);
 assert.equal(budget.storage.d1Files,1);assert.equal(budget.storage.r2Files,3);
 const wrong={kind:'slide',hash:'a'.repeat(64),bytes:png.length,sourceId:'99991',mime:'image/png'};
 const rejected=await ok(await begin(wrong));await ok(await put(rejected.id,0,png));
 assert.equal((await finish(rejected.id,{kind:'slide'})).status,422);
 assert.equal((await call('rehearsal/slides/'+rejected.id)).status,404);
 await ok(await cancel(rejected.id));
 await ok(await cancel(rejected.id));
 assert.equal((await ok(await begin(wrong))).next,0);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM studio_r2_upload_quarantine').first()).n,1);
 assert.equal((await cancel(rejected.id,{extra:{'X-Rehearsal-Metadata':rejected.session}})).status,409,'a repeat cancel cannot touch a newer upload');
 await db.prepare("UPDATE studio_r2_uploads SET expires_at=0 WHERE id=?").bind(rejected.id).run();
 assert.equal((await ok(await begin(wrong))).next,0);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM studio_r2_upload_quarantine').first()).n,2);
 const {results:manifest}=await db.prepare("SELECT v.* FROM studio_r2_verified v JOIN studio_r2_media m ON m.object_key=v.object_key ORDER BY m.file_id").all();
 const bucket=await mf.getR2Bucket('STUDIO_MEDIA');
 for(const object of manifest){
  const body=Buffer.from(await (await bucket.get(object.object_key)).arrayBuffer());
  assert.equal(hash(body),object.hash);assert.equal(body.length,object.bytes);
  await writeFile(join(temp,'objects',hash(object.object_key)),body);
 }
 await writeFile(join(temp,'manifest.json'),JSON.stringify(manifest));
 await mf.dispose();
 live=null;
 const dbFolder=join(d1,'miniflare-D1DatabaseObject');
 const snapshot=(await readdir(dbFolder)).find(entry=>entry.endsWith('.sqlite'));
 assert(snapshot);
 const verified=JSON.parse(execFileSync('python',['scripts/verify-studio-backup.py',
  join(dbFolder,snapshot),'--r2-objects',join(temp,'objects')],{encoding:'utf8'}));
 assert.equal(verified.integrity,'ok');assert.equal(verified.files.length,4);
 await cp(d1,isolated,{recursive:true});
 mf=new Miniflare(options(isolated,'off'));
 const restoreBucket=await mf.getR2Bucket('STUDIO_MEDIA');
 assert.equal((await restoreBucket.list()).objects.length,0);
 const backup=JSON.parse(await readFile(join(temp,'manifest.json'),'utf8'));
 for(const object of backup){
  const bytes=await readFile(join(temp,'objects',hash(object.object_key)));
  assert.equal(hash(bytes),object.hash);
  if(bytes.length<=partBytes)await restoreBucket.put(object.object_key,bytes,{sha256:object.hash});
  else{
   const mpu=await restoreBucket.createMultipartUpload(object.object_key),parts=[];
   for(let offset=0;offset<bytes.length;offset+=partBytes)parts.push(
    await mpu.uploadPart(parts.length+1,bytes.subarray(offset,offset+partBytes)));
   await mpu.complete(parts);
  }
  assert.equal((await restoreBucket.head(object.object_key)).etag,object.etag);
 }
 const restoredDb=await mf.getD1Database('DB');
 assert.equal((await restoredDb.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 assert.equal((await call(r2)).status,404);
 assert.equal((await begin(info)).status,404);
 await download('rehearsal/slides/'+legacy.id,jpg);
 await download(r2Pptx,deck);
 await download('rehearsal/slides/'+preview.id,png);
 await download('rehearsal/audio/'+rec.id,audio);
 await ok(await call('rehearsal/edit/slides',{bytes:png,extra:{'Content-Type':'image/png'}}));
 console.log('PASS R2: '+deck.length+' byte PPTX, full SHA-256, cross-part Range, 6 MiB audio, preview, authorization, resume, duplicate/concurrent part, D1 attach failure recovery, hash mismatch and cancellation');
 console.log('PASS isolated D1 + R2 recovery: 3 independent object copies, identical ETags, legacy file and 3 R2 files readable by protected API, writes off, D1 uploads available');
} finally {
 await mf.dispose();
 if(live&&live!==mf)await live.dispose();
 await rm(temp,{recursive:true,force:true});
}
