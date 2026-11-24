import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,statSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {strToU8,zipSync} from 'fflate';

const root=process.cwd(),require=createRequire(import.meta.url);
const wrangler=require.resolve('wrangler/package.json'),paths=[dirname(wrangler)];
const {Miniflare}=require(require.resolve('miniflare',{paths}));
const {build}=require(require.resolve('esbuild',{paths}));
const temp=mkdtempSync(join(tmpdir(),'studio-release-rehearsal-'));
const source=join(temp,'source'),candidate=join(temp,'candidate'),restore=join(temp,'restore');
const dbId=randomUUID(),base=process.env.STUDIO_LEGACY_SHA??'fe0cd796ca825da48390e89e8a0f64f50c208b2f';
const priorCandidate='b5217365860fba546960b7a18fdb2b1719968aac';
const compatible=process.env.STUDIO_COMPATIBLE_SHA??(canRead(priorCandidate)?priorCandidate:'f8586c6');
const largeFixture=process.env.STUDIO_RESTORE_PPTX;
const partSize=256*1024;
const password='IsolatedFixture#AdminV14',code='0042',pepper='4b'.repeat(32),wrong='9a'.repeat(32);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const wave=Buffer.from([0x1a,0x45,0xdf,0xa3,1,2,3,4,5,6]),hash=body=>createHash('sha256').update(body).digest('hex');
const origin='https://studio-isolated.test',native='https://localhost';
let active;
function canRead(sha){
 try{execFileSync('git',['cat-file','-e',sha+'^{tree}'],{stdio:'ignore'});return true;}catch{return false;}
}
function archive(sha,name){
 const path=join(temp,name);mkdirSync(path);
 execFileSync('tar',['-xf','-','-C',path],{input:execFileSync('git',['archive',sha],{maxBuffer:80*1024*1024})});
 return path;
}
async function compile(location){
 const compiled=await build({stdin:{contents:`
  import {apiCors} from './lib/http';
  import {handleProjects} from './lib/projects';
  export default{fetch(request){
   const path=new URL(request.url).pathname.split('/').slice(3);
   return apiCors(request,()=>handleProjects(request,path));
  }};
 `,resolveDir:location,loader:'ts'},nodePaths:[join(root,'node_modules')],bundle:true,write:false,format:'esm',
  platform:'neutral',external:['cloudflare:workers','node:*']});
 return compiled.outputFiles[0].text;
}
function config(migrations){
 const path=join(temp,'wrangler.json');
 writeFileSync(path,JSON.stringify({name:'studio-e6-isolated-fixture',compatibility_date:'2026-05-15',
  d1_databases:[{binding:'DB',database_name:'studio-e6-isolated-fixture',database_id:dbId,migrations_dir:migrations}]}));
 return path;
}
function cli(path,db,...args){
 mkdirSync(db,{recursive:true});
 const isolatedConfig=join(db,'wrangler.json');copyFileSync(path,isolatedConfig);
 return execFileSync(process.execPath,[join(dirname(wrangler),'bin/wrangler.js'),'d1',...args,'--local','--config',isolatedConfig],
  {env:{...process.env,CI:'1',WRANGLER_SEND_METRICS:'false'},encoding:'utf8',maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
}
function start(dir,workers){
 active=new Miniflare({d1Persist:join(dir,'.wrangler','state','v3','d1'),workers:workers.map(([name,script,secret])=>({
  name,script,modules:true,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
  d1Databases:{DB:dbId},bindings:{NATIVE_APP_ORIGIN:native,...(secret?{STUDIO_PASSWORD_PEPPER:secret}:{})}
 }))});
 return active;
}
async function stop(){await active?.dispose();active=undefined;}
function api(worker){
 let ip=1;
 return (path,value,token='',headers={})=>worker.fetch(origin+'/api/projects'+path,{method:value===undefined?'GET':'POST',headers:{
  Origin:native,'X-Studio-Transport':'bearer','CF-Connecting-IP':'198.51.100.'+(ip++%250+1),
  ...(token?{'X-Studio-Session':token}:{}),...(value===undefined?{}:{'Content-Type':'application/json'}),...headers},
  ...(value===undefined?{}:{body:Buffer.isBuffer(value)?value:JSON.stringify(value)})});
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function create(request,modern=false){
 const challenge=await ok(await request('/challenge',{}));let solution=0;
 while(!hash(challenge.nonce+':'+solution).startsWith('0000'))solution++;
 return ok(await request('',{title:modern?'Modern acceptance':'Legacy acceptance',seconds:900,code,
  ...(modern?{admin_password:password,visibility:'unlisted'}:{code_confirmation:code}),
  request_id:hash(randomUUID()),challenge:challenge.nonce,solution:String(solution)},'',{'X-Studio-Anonymous':challenge.anonymous_token}),201);
}
function inspectFile(path){
 return JSON.parse(execFileSync('python',['scripts/verify-studio-backup.py',path],{encoding:'utf8'}));
}
function inspect(dir){
 const path=join(dir,'.wrangler','state','v3','d1','miniflare-D1DatabaseObject');
 const db=readdirSync(path).find(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');
 assert(db,'fixture SQLite file missing');
 return inspectFile(join(path,db));
}
const recording=(p,id,releaseId)=>({id,memberId:p.members[0].id,turnId:'turn-legacy-block',
 ...(releaseId?{releaseId}:{}),scriptVersion:p.scriptVersion,deckVersion:p.deckVersion,algorithmVersion:p.algorithmVersion,
 hash:hash(wave),durationMs:1000,clockDurationMs:1000,mediaDurationMs:1000,events:[{t_ms:0,slide_index:0,source:'start'}]});
const audioHeaders=metadata=>({'Content-Type':'audio/webm','X-Rehearsal-Metadata':encodeURIComponent(JSON.stringify(metadata))});
try{
 const before=archive(base,'previous-tree'),fallback=archive(compatible,'compatible-tree');
 const [oldScript,script,fallbackScript]=await Promise.all([compile(before),compile(root),compile(fallback)]);
 const oldMigrations=join(temp,'legacy-migrations');mkdirSync(oldMigrations);
 for(const filename of readdirSync('migrations').filter(name=>/^000[1-3]/.test(name)))copyFileSync(join(root,'migrations',filename),join(oldMigrations,filename));
 const oldConfig=config(oldMigrations);
 cli(oldConfig,source,'migrations','apply','DB');
 const initial=start(source,[['legacy',oldScript]]);
 const legacy=api(await initial.getWorker('legacy'));
 const created=await create(legacy);
 const pid='/'+created.project_id,editor=(await ok(await legacy(pid+'/join',{secret:code}))).session_token;
 const initialProject=(await ok(await legacy(pid+'/edit',undefined,editor))).project;
 const firstSlide=await ok(await legacy(pid+'/edit/slides',png,editor,{'Content-Type':'image/png'}));
 const original=Buffer.from(zipSync({
  'ppt/presentation.xml':strToU8('<p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst>'),
  'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="slide" Type="schema/slide" Target="slides/slide1.xml"/></Relationships>')
 }));
 const originalDeck=await ok(await legacy(pid+'/edit/pptx',original,editor,{'Content-Type':'application/vnd.openxmlformats-officedocument.presentationml.presentation'}));
 const {id,scriptVersion,deckVersion,algorithmVersion,updatedAt,...document}=initialProject;
 const speaker={id:'legacy-speaker',name:'测试组员',enabled:true};
 const published=(await ok(await legacy(pid+'/edit',{...document,status:'published',members:[speaker],
  slides:[{...firstSlide,pageIndex:0,sourcePage:originalDeck.pages[0]}],sourceDeck:originalDeck,
  blocks:[{id:'legacy-block',paragraphId:'legacy-block',text:'保存既有录音。',memberId:speaker.id,nonspoken:false,slideIndex:0,paragraphEnd:true}]},editor))).project;
 const priorTake=randomUUID(),priorMetadata=recording(published,priorTake);
 await ok(await legacy(pid+'/recordings',wave,editor,audioHeaders(priorMetadata)));
 await stop();
 const originalManifest=inspect(source);
 assert.equal(originalManifest.files.length,3);
 const backup=join(temp,'before.sql');
 cli(oldConfig,source,'export','DB','--output',backup);
 cli(oldConfig,candidate,'execute','DB','--file',backup,'--yes');
 assert.deepEqual(inspect(candidate).files,originalManifest.files);
 assert.deepEqual(inspect(candidate).counts,originalManifest.counts);
 assert.deepEqual(inspect(candidate).row_sha256,originalManifest.row_sha256);
 console.log('PASS Wrangler --local SQL export and restore: identical row hashes and SHA-256 for legacy slide, PPTX and audio; PRAGMA integrity and foreign keys OK');

 // Verify the old deployment on a separate restored pre-migration copy.
 cli(oldConfig,restore,'execute','DB','--file',backup,'--yes');
 const restored=start(restore,[['legacy',oldScript]]);
 const restoredOld=api(await restored.getWorker('legacy'));
 const restoredKey=await ok(await restoredOld(pid+'/owner-session',{secret:created.owner_key}));
 const restoredAudio=await restoredOld(pid+'/audio/'+priorTake,undefined,restoredKey.session_token);
 assert.equal(restoredAudio.status,200);assert.equal(hash(Buffer.from(await restoredAudio.arrayBuffer())),hash(wave));
 await stop();
 console.log('PASS pre-write rollback: old API reauthenticates the original key and reads the byte-exact audio after restoring the pre-migration backup');

 const newConfig=config(join(root,'migrations'));
 cli(newConfig,candidate,'migrations','apply','DB');
 cli(newConfig,candidate,'migrations','apply','DB');
 const migrated=inspect(candidate);
 assert.deepEqual(migrated.files,originalManifest.files);
 for(const [table,digest] of Object.entries(originalManifest.row_sha256)){
  if(table!=='d1_migrations')assert.equal(migrated.row_sha256[table],digest,table);
 }
 const after=start(candidate,[['candidate',script,pepper],['compatible',fallbackScript,pepper],['legacy',oldScript],['wrong',script,wrong],['missing',script]]);
 const db=await after.getD1Database('DB','candidate');
 const ledger=(await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(r=>r.name);
 assert.deepEqual(ledger,readdirSync('migrations').sort());
 const triggers=(await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('rehearsal_keep_three','rehearsal_locked_limit','rehearsal_protect_recording','rehearsal_protect_recording_origin','rehearsal_protect_release_reference')").all()).results.map(r=>r.name).sort();
 assert.deepEqual(triggers,['rehearsal_protect_recording','rehearsal_protect_recording_origin','rehearsal_protect_release_reference']);
 const v14=api(await after.getWorker('candidate'));
 const legacyUpgraded=(await ok(await v14(pid+'/session',{password:created.owner_key})));
 assert.equal(legacyUpgraded.legacy_upgrade_required,true);
 const legacyEditor=(await ok(await v14(pid+'/session',{password:code}))).session_token;
 const historical=await ok(await v14(pid,undefined,legacyEditor));
 assert.equal(historical.recordings[0].id,priorTake);
 await db.prepare("UPDATE rehearsal_recordings SET locked=1 WHERE id=?").bind(priorTake).run();
 await assert.rejects(db.prepare('DELETE FROM rehearsal_files WHERE id=?').bind(priorTake).run(),/protected/);
 const modern=await create(v14,true),mid='/'+modern.project_id;
 const upgraded=await ok(await v14(pid+'/owner/upgrade',{owner_key:created.owner_key,admin_password:password},legacyUpgraded.session_token));
 assert.equal(upgraded.role,'owner');
 const current=await ok(await v14(pid+'/releases/'+historical.project.releaseId,undefined,legacyEditor));
 const take=randomUUID(),metadata=recording(historical.project,take,historical.project.releaseId);
 const longWave=Buffer.concat([wave,Buffer.alloc(1024*1024-wave.length,17)]);
 metadata.hash=hash(longWave);
 const audioStart=await ok(await v14(pid+'/uploads',{kind:'audio',id:take,bytes:longWave.length,
  hash:metadata.hash,mime:'audio/webm'},legacyEditor));
 assert.equal(audioStart.partBytes,partSize);
 for(let i=0;i<longWave.length/partSize;i++){
  const sent=await ok(await v14(pid+'/uploads/'+take+'/'+i,longWave.subarray(i*partSize,(i+1)*partSize),
   legacyEditor,{'Content-Type':'application/octet-stream'}));
  assert.equal(sent.next,i+1);
 }
 const audioFinish={kind:'audio',mime:'audio/webm',recording:metadata};
 await ok(await v14(pid+'/uploads/'+take+'/finish',audioFinish,legacyEditor));
 assert.equal((await ok(await v14(pid+'/uploads/'+take+'/finish',audioFinish,legacyEditor))).retried,true);
 await ok(await v14(pid+'/playback/choice',{release_id:historical.project.releaseId,turn_uid:current.turns[0].uid,recording_id:take,selection_revision:0},legacyEditor));
 const newToken=(await ok(await v14(mid+'/session',{password:code}))).session_token;
 let stressFile,largeSaved,pending;
 if(largeFixture){
  stressFile=readFileSync(largeFixture);
  assert.equal(stressFile.length,20*1024*1024);
  const start=await ok(await v14(mid+'/uploads',{kind:'pptx',bytes:stressFile.length,hash:hash(stressFile)},newToken));
  for(let i=0;i<stressFile.length/partSize;i++){
   const sent=await ok(await v14(mid+'/uploads/'+start.id+'/'+i,stressFile.subarray(i*partSize,(i+1)*partSize),
    newToken,{'Content-Type':'application/octet-stream'}));
   assert.equal(sent.next,i+1);
  }
  largeSaved=await ok(await v14(mid+'/uploads/'+start.id+'/finish',{kind:'pptx'},newToken));
  pending=await ok(await v14(mid+'/uploads',{kind:'pptx',bytes:2*partSize,hash:'0'.repeat(64)},newToken));
  await ok(await v14(mid+'/uploads/'+pending.id+'/0',stressFile.subarray(0,partSize),newToken,{'Content-Type':'application/octet-stream'}));
 }
 const originalCredentialCount=(await db.prepare('SELECT count(*) AS n FROM studio_admin_passwords').first()).n;
 const other=api(await after.getWorker('wrong')),missing=api(await after.getWorker('missing'));
 for(const p of [password,code]){
  assert.equal((await other(mid+'/session',{password:p})).status,401);
  const response=await missing(mid+'/session',{password:p});
  assert(response.status>=400&&!(await response.clone().text()).includes(pepper));
 }
 assert.equal((await db.prepare('SELECT count(*) AS n FROM studio_admin_passwords').first()).n,originalCredentialCount);
 assert.equal((await v14(mid+'/edit/draft',undefined,newToken)).status,200);
 const unsafeOld=api(await after.getWorker('legacy'));
 assert.equal((await unsafeOld(pid+'/owner-session',{secret:created.owner_key})).status,401);
 assert.equal((await unsafeOld(mid+'/join',{secret:code})).status,401);
 const compat=api(await after.getWorker('compatible'));
 for(const p of [pid,mid])await ok(await compat(p+'/session',{password}));
 const compatToken=(await ok(await compat(pid+'/session',{password:code}))).session_token;
 const manifest=await ok(await compat(pid+'/playback/session',{release_id:historical.project.releaseId},compatToken));
 assert.equal(manifest.recordings[0].id,take);
 for(const t of [take,priorTake]){
  const file=await compat(pid+'/audio/'+t,undefined,compatToken);
  assert.equal(file.status,200);assert.equal(hash(Buffer.from(await file.arrayBuffer())),hash(t===take?longWave:wave));
 }
 if(largeSaved&&pending){
  const older=await compat(mid+'/edit/pptx/'+largeSaved.id,undefined,newToken);
  assert.equal(older.status,200);
  assert.equal(hash(Buffer.from(await older.arrayBuffer())),hash(stressFile));
  assert.equal((await compat(mid+'/edit/pptx/'+pending.id,undefined,newToken)).status,404);
 }
 await assert.rejects(db.prepare('DELETE FROM rehearsal_files WHERE id=?').bind(take).run(),/protected/);
 await stop();
 const afterManifest=inspect(candidate);
 assert.equal(afterManifest.files.length,largeSaved?5:4);
 const afterBackup=join(temp,'after.sql'),postRestore=join(temp,'post-restore'),normalized=join(temp,'after-restore.sql');
 cli(newConfig,candidate,'export','DB','--output',afterBackup);
 let restoredManifest;
 if(largeSaved){
  const sqlite=join(temp,'offline-restored.sqlite'),start=performance.now();
  execFileSync('python',['scripts/prepare-studio-d1-restore.py',afterBackup,normalized,'--sqlite-out',sqlite]);
  restoredManifest=inspectFile(sqlite);
  assert.equal(restoredManifest.counts.rehearsal_media_parts,1);
  console.log('PASS large post-0007 SQL export and offline SQLite restore',JSON.stringify({
   sqlBytes:statSync(afterBackup).size,verifyWallMs:Math.round(performance.now()-start),pptxBytes:stressFile.length
  }));
 }else{
  assert.throws(()=>cli(newConfig,join(temp,'raw-import-refused'),'execute','DB','--file',afterBackup,'--yes'),
   error=>/foreign key mismatch/.test(error.stderr??''));
  execFileSync('python',['scripts/prepare-studio-d1-restore.py',afterBackup,normalized]);
  cli(newConfig,postRestore,'execute','DB','--file',normalized,'--yes');
  restoredManifest=inspect(postRestore);
 }
 assert.deepEqual(restoredManifest.files,afterManifest.files);
 assert.deepEqual(restoredManifest.counts,afterManifest.counts);
 assert.deepEqual(restoredManifest.row_sha256,afterManifest.row_sha256);
 assert.deepEqual(inspect(source),originalManifest);
 console.log('PASS 0004 → 0005 → 0006 → 0007 with re-entry, legacy release/audio retained, modern Secret positive and wrong/missing Secret fail closed');
 console.log('PASS compatible V1.4 API rollback on the same migrated database: modern and upgraded owners, post-upgrade audio and selected take preserved');
 console.log('PASS post-migration SQL export and restore: identical table row hashes and file SHA-256; pre-migration database still byte-identical; legacy Worker authentication rejected after upgrade as expected');
}finally{await stop();if(process.env.STUDIO_KEEP_REHEARSAL==='1')console.log('Fixture only:',temp);else rmSync(temp,{recursive:true,force:true});}
