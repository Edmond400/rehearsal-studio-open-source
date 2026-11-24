import {testDeckStorage} from './rehearsal-deck-storage-v14.test.mjs';
import {testReleaseRecordings,testLegacyReleaseImport} from './rehearsal-recordings-v14.test.mjs';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname} from 'node:path';
const require=createRequire(import.meta.url),search=[dirname(require.resolve('wrangler/package.json'))],{build}=require(require.resolve('esbuild',{paths:search})),{Miniflare}=require(require.resolve('miniflare',{paths:search}));
const compiled=await build({stdin:{contents:`import {apiCors} from './lib/http';import {handleProjects} from './lib/projects';import {handleRehearsal} from './lib/rehearsal/service';export default{fetch(r){let p=new URL(r.url).pathname;return apiCors(r,()=>p.startsWith('/api/projects')?handleProjects(r,p.replace(/^\\/api\\/projects\\/?/,'').split('/').filter(Boolean)):handleRehearsal(r,p.replace(/^\\/api\\/rehearsal\\/?/,'').split('/').filter(Boolean)))}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'neutral',format:'esm',write:false,external:['cloudflare:workers','node:*']});
const mf=new Miniflare({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{NATIVE_APP_ORIGIN:'https://localhost',STUDIO_PASSWORD_PEPPER:'a'.repeat(64)}});
const origin='https://studio.test',nativeOrigin='https://localhost',adminPassword='Fixture#Admin800',nextPassword='Fixture#Admin802',hash=s=>createHash('sha256').update(s).digest('hex');let n=0;
const req=(path,body,token='',method=body===undefined?'GET':'POST',extra={})=>mf.dispatchFetch(origin+'/api/'+path,{method,headers:{Origin:nativeOrigin,'CF-Connecting-IP':'198.51.100.'+(++n),'X-Studio-Transport':'bearer',...(token?{'X-Studio-Session':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function ok(r,status=200){assert.equal(r.status,status,await r.clone().text());return r.json()}
try{
 const db=await mf.getD1Database('DB'),q=(sql,...args)=>db.prepare(sql).bind(...args).first();
 for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()){const sql=readFileSync('migrations/'+f,'utf8');for(const s of sql.match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/gi)||[])await db.prepare(s).run()}
 const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(x=>x.name);assert(!tables.some(t=>/student|birthday|administrator|incentive|funds/.test(t)));
 async function create(title){const c=await ok(await req('projects/challenge',{}));let solution=0;while(!hash(c.nonce+':'+solution).startsWith('0000'))solution++;const body={title,seconds:900,code:'0001',admin_password:adminPassword,challenge:c.nonce,solution:String(solution),request_id:randomBytes(32).toString('hex')};const extra={'X-Studio-Anonymous':c.anonymous_token};const r=await req('projects',body,'','POST',extra);const a=await ok(r,201);assert(/Secure; HttpOnly; SameSite=Strict/.test(r.headers.get('set-cookie')));assert(!a.owner_key);assert.match(a.project_id,/^[a-f0-9]{32}$/);return {...a,body,extra}}
 const a=await create('甲组'),b=await create('乙组');assert.notEqual(a.project_id,b.project_id);const pid=a.project_id;
 assert.equal((await q('SELECT count(*) n FROM rehearsal_projects')).n,2);
 assert.equal((await req('projects',{...a.body,title:'另一份汇报'},'','POST',a.extra)).status,409,'different fields cannot recover another creation');
 assert.equal((await req('projects',{...a.body,code:'0000'},'','POST',a.extra)).status,409,'different code cannot reuse a creation request');
 const retry=await ok(await req('projects',a.body,'','POST',a.extra));assert(retry.retried);assert(!retry.owner_key);assert.equal(retry.project_id,pid);assert.equal((await q('SELECT count(*) n FROM rehearsal_projects')).n,2);
 const oa=retry.session_token;
 const join=async(id,code='0001')=>ok(await req('projects/'+id+'/join',{secret:code}));let ea=(await join(pid)).session_token,eb=(await join(b.project_id)).session_token;
 const project=(id,token,path='',body)=>req('projects/'+id+path,body,token);
 assert.equal((await project(pid,'')).status,401);assert.equal((await project(pid,eb)).status,401);assert.equal((await project(b.project_id,oa)).status,401);
 assert.equal((await req('projects')).status,404);assert.equal((await req('rehearsal/projects')).status,404);
 assert.equal((await project(pid,ea,'/owner/status')).status,403);assert.equal((await project(pid,ea,'/owner/code',{code:'1111'})).status,403);
 assert.equal((await req('projects/'+pid+'/owner-session',{secret:'0001'})).status,401);
 let p=(await ok(await project(pid,ea,'/edit'))).project;assert.equal(p.status,'draft');assert.equal(p.config.hardLimitSeconds,900);
 const asBody=p=>{const {id,scriptVersion,deckVersion,algorithmVersion,updatedAt,...r}=p;return r};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const upload=(id,t)=>mf.dispatchFetch(origin+'/api/projects/'+id+'/edit/slides',{method:'POST',headers:{Origin:nativeOrigin,'X-Studio-Transport':'bearer','X-Studio-Session':t,'Content-Type':'image/png'},body:png});
 const slide=await ok(await upload(pid,ea));assert.equal((await project(b.project_id,eb,'/slides/'+slide.id)).status,404);assert.equal((await project(pid,eb,'/slides/'+slide.id)).status,401);
 p=(await ok(await project(pid,ea,'/edit',{...asBody(p),members:[{id:'a',name:'示例甲',enabled:true}],slides:[{...slide,pageIndex:0}],blocks:[{id:'block',paragraphId:'block',text:'示例讲稿。',memberId:'a',nonspoken:false,slideIndex:0,paragraphEnd:true}],status:'published'}))).project;
 assert.equal((await project(pid,ea,'/edit',{...asBody(p),revision:0})).status,409);
 const ranged=await mf.dispatchFetch(origin+'/api/projects/'+pid+'/slides/'+slide.id,{headers:{Origin:nativeOrigin,'X-Studio-Transport':'bearer','X-Studio-Session':ea,Range:'bytes=2-5'}});assert.equal(ranged.status,206);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),png.subarray(2,6));
 assert.equal((await project(pid,ea,'/edit/cleanup',{})).status,403);

 // E2 uses the real D1 API and two concurrent requests from the same revision.
 const draftBase=(await ok(await req('projects/'+pid+'/edit/draft',undefined,ea,'GET',{'X-Studio-Project':b.project_id}))).project;
 assert.equal(draftBase.id,pid,'the URL owns the scope for legacy routes');
 assert.equal((await req('projects/'+b.project_id+'/edit/draft',undefined,ea,'GET',{'X-Studio-Project':pid})).status,401);
 assert.deepEqual((await ok(await req('rehearsal/edit/draft',undefined,ea,'GET',{'X-Studio-Project':pid}))).project,draftBase);
 const draftMutation={base_revision:draftBase.revision,mutation_id:crypto.randomUUID(),document:{...asBody(draftBase),title:'自动保存稿',status:'draft'}};
 const race=await Promise.all([
  project(pid,ea,'/edit/draft',draftMutation),
  req('rehearsal/edit/draft',{...draftMutation,mutation_id:crypto.randomUUID(),document:{...draftMutation.document,title:'另一标签页'}},oa,'POST',{'X-Studio-Project':pid})
 ]);
 assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
 const afterRace=(await ok(await project(pid,ea,'/edit/draft'))).project;
 assert.equal(afterRace.revision,draftBase.revision+1);
 const saved=await ok(await project(pid,ea,'/edit/draft',{...draftMutation,base_revision:afterRace.revision,mutation_id:crypto.randomUUID()}));
 const saveToken={...draftMutation,base_revision:saved.project.revision,mutation_id:crypto.randomUUID()};
 const once=await ok(await project(pid,ea,'/edit/draft',saveToken));
 assert((await ok(await project(pid,ea,'/edit/draft',saveToken))).retried);
 assert.equal((await q('SELECT count(*) n FROM rehearsal_versions WHERE project_id=?',pid)).n,2);
 assert.equal((await q('SELECT count(*) n FROM rehearsal_draft_checkpoints WHERE project_id=?',pid)).n,1);
 assert.equal((await ok(await project(pid,ea))).project.title,'甲组');
 const publish={expected_draft_revision:once.project.revision,mutation_id:crypto.randomUUID()};
 const live=await ok(await project(pid,ea,'/edit/publish',publish));p=live.project;
 assert(live.releaseId);
 assert.equal((await ok(await project(pid,ea,'/edit/publish',publish))).releaseId,live.releaseId);
 assert.equal((await q('SELECT count(*) n FROM rehearsal_releases WHERE project_id=?',pid)).n,2);
 const audio=Buffer.alloc(10*1024*1024);audio.set([0x1a,0x45,0xdf,0xa3]);const rec={id:crypto.randomUUID(),memberId:'a',turnId:'turn-block',scriptVersion:p.scriptVersion,deckVersion:p.deckVersion,algorithmVersion:p.algorithmVersion,hash:hash(audio),durationMs:1000,mediaDurationMs:1000,clockDurationMs:1000,events:[{t_ms:0,slide_index:0,source:'start'}]};
 const uploaded=await mf.dispatchFetch(origin+'/api/projects/'+pid+'/recordings',{method:'POST',headers:{Origin:nativeOrigin,'X-Studio-Transport':'bearer','Content-Type':'audio/webm','X-Studio-Session':ea,'X-Rehearsal-Metadata':encodeURIComponent(JSON.stringify(rec))},body:audio});await ok(uploaded);
 // A completed upload must be idempotent only for the same audio content.
 const committedAudio={kind:'audio',id:rec.id,bytes:audio.length,hash:rec.hash,mime:'audio/webm'};
 const completed=await ok(await project(pid,ea,'/uploads',committedAudio));
 assert.equal(completed.next,40);
 const wrongRetry=await project(pid,ea,'/uploads',{...committedAudio,hash:'f'.repeat(64)});
 assert.equal(wrongRetry.status,409,'different audio with an existing UUID must not be acknowledged');
 assert.equal((await q('SELECT count(*) n FROM rehearsal_media_uploads WHERE id=?',rec.id)).n,0);
 // Expiry cleanup must roll back if a new reservation fails its quota guard.
 const expiredId=crypto.randomUUID(),pendingId=crypto.randomUUID();
 await db.prepare('INSERT INTO rehearsal_media_uploads (id,project_id,kind,mime,bytes,hash,expires_at) VALUES (?,?,?,?,?,?,?)')
  .bind(expiredId,pid,'audio','audio/webm',1024,rec.hash,Date.now()-1000).run();
 const stalePart=Buffer.from([1,2,3,4]);
 await db.prepare('INSERT INTO rehearsal_media_parts (upload_id,part,hash,data) VALUES (?,?,?,unhex(?))')
  .bind(expiredId,0,hash(stalePart),stalePart.toString('hex')).run();
 const previousLimit=(await q('SELECT max_bytes FROM studio_usage WHERE project_id=?',pid)).max_bytes;
 await db.prepare('UPDATE studio_usage SET max_bytes=0 WHERE project_id=?').bind(pid).run();
 const pendingAudio={kind:'audio',id:pendingId,bytes:1024,hash:rec.hash,mime:'audio/webm'};
 assert.equal((await project(pid,ea,'/uploads',pendingAudio)).status,409);
 assert.equal((await q('SELECT count(*) n FROM rehearsal_media_uploads WHERE id=?',expiredId)).n,1,
  'failed reservation must roll back expiry cleanup');
 assert.equal((await q('SELECT count(*) n FROM rehearsal_media_parts WHERE upload_id=?',expiredId)).n,1,
  'the failed cleanup must also preserve the staged file bytes');
 await db.prepare('UPDATE studio_usage SET max_bytes=? WHERE project_id=?').bind(previousLimit,pid).run();
 await ok(await project(pid,ea,'/uploads',pendingAudio));
 assert.equal((await q('SELECT count(*) n FROM rehearsal_media_uploads WHERE id=?',expiredId)).n,0);
 assert.equal((await q('SELECT count(*) n FROM rehearsal_media_parts WHERE upload_id=?',expiredId)).n,0);
 const streamed=await project(pid,ea,'/audio/'+rec.id);assert.equal(hash(Buffer.from(await streamed.arrayBuffer())),rec.hash);assert.equal((await project(b.project_id,eb,'/audio/'+rec.id)).status,404);assert.equal((await q('SELECT count(*) n FROM rehearsal_file_chunks WHERE file_id=?',rec.id)).n,20);
 assert.equal((await project(pid,ea,'/edit/recordings',{id:rec.id,action:'delete'})).status,403);
 const history=await ok(await project(pid,ea,'/versions'));assert(history.versions.length>=2);
 await ok(await project(pid,ea,'/restore',{revision:0,expected_revision:p.revision}));assert.equal((await ok(await project(pid,ea))).project.title,'自动保存稿');assert.equal((await ok(await project(pid,ea,'/edit'))).project.status,'draft');
 await ok(await project(pid,oa,'/owner/code',{password:adminPassword,code:'0000'}));assert.equal((await project(pid,ea)).status,401);assert.equal((await req('projects/'+pid+'/join',{secret:'0001'})).status,401);ea=(await join(pid,'0000')).session_token;
 const rotated=await ok(await project(pid,oa,'/owner/password',{password:adminPassword,new_password:nextPassword}));
 assert(!rotated.owner_key);assert.equal((await project(pid,oa)).status,401);assert.equal((await req('projects/'+pid+'/session',{password:adminPassword})).status,401);const owner=rotated.session_token;
 assert.equal((await req('projects',a.body,'','POST',a.extra)).status,403,'consumed creation nonce cannot recover after rotation');
 await ok(await project(pid,owner,'/owner/archive',{archived:true,password:nextPassword}));assert.equal((await project(pid,ea)).status,401);assert.equal((await req('projects/'+pid+'/join',{secret:'0000'})).status,401);assert.equal((await project(pid,owner,'/owner/status')).status,200);await ok(await project(pid,owner,'/owner/archive',{archived:false,password:nextPassword}));ea=(await join(pid,'0000')).session_token;
 const exported=await ok(await project(pid,owner,'/owner/export'));assert(!JSON.stringify(exported).includes(nextPassword));assert(!JSON.stringify(exported).includes('secret_digest'));assert(!('studio_sessions' in exported.tables));
 await db.prepare('UPDATE studio_usage SET max_bytes=0 WHERE project_id=?').bind(pid).run();const before=(await q('SELECT count(*) n FROM rehearsal_files')).n;assert((await upload(pid,ea)).status>=400);assert.equal((await q('SELECT count(*) n FROM rehearsal_files')).n,before,'quota cannot leave partial file');
 let blocked=false;for(let i=0;i<12;i++){const r=await req('projects/unknown/join',{secret:'9999'},'','POST',{'CF-Connecting-IP':'203.0.113.99'});if(r.status===429)blocked=true}assert(blocked);const stored=JSON.stringify((await db.prepare('SELECT * FROM studio_limits').all()).results);assert(!stored.includes('203.0.113.99'));
 const del={password:nextPassword,confirm:true};assert.equal((await req('projects/'+pid,del,ea,'DELETE')).status,403);assert.equal((await req('projects/'+pid,{...del,password:'Invalid#100'},owner,'DELETE')).status,403);
 await ok(await req('projects/'+pid,del,owner,'DELETE'));for(const table of ['rehearsal_versions','rehearsal_members','rehearsal_recordings','rehearsal_turn_progress','rehearsal_files','studio_sessions','studio_usage','studio_owner_credentials','studio_admin_passwords','studio_project_visibility','studio_audit'])assert.equal((await q(`SELECT count(*) n FROM ${table} WHERE project_id=?`,pid)).n,0);assert.equal((await q('SELECT count(*) n FROM rehearsal_file_chunks WHERE file_id=?',rec.id)).n,0);assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);assert.equal((await project(pid,owner)).status,401);assert.equal((await project(b.project_id,eb)).status,200);
 await testReleaseRecordings({
  db,ok,upload:()=>upload(b.project_id,eb),project:(path,body)=>project(b.project_id,eb,path,body),asBody,hash,
  sendAudio:(rec,audio)=>mf.dispatchFetch(origin+'/api/projects/'+b.project_id+'/recordings',{method:'POST',headers:{
   Origin:nativeOrigin,'X-Studio-Transport':'bearer','X-Studio-Session':eb,'Content-Type':'audio/webm','X-Rehearsal-Metadata':encodeURIComponent(JSON.stringify(rec))},body:audio})
 });
 const legacy=await create('旧版兼容样本'),legacyToken=(await join(legacy.project_id)).session_token;
 await testLegacyReleaseImport({db,ok,hash,upload:()=>upload(legacy.project_id,legacyToken),project:(path,body)=>project(legacy.project_id,legacyToken,path,body)});
 const e4=await create('PPTX 导入样本'),e4Token=(await join(e4.project_id)).session_token;
 const e4Owner=(await ok(await req('projects/'+e4.project_id+'/session',{password:adminPassword}))).session_token;
 await testDeckStorage({db,ok,hash,preview:png,projectId:e4.project_id,cleanup:()=>project(e4.project_id,e4Owner,'/edit/cleanup',{password:adminPassword}),request:(path,body,headers)=>{
  if(!headers)return project(e4.project_id,e4Token,path,body);
  return mf.dispatchFetch(origin+'/api/projects/'+e4.project_id+path,{method:'POST',headers:{
   Origin:nativeOrigin,'X-Studio-Transport':'bearer','X-Studio-Session':e4Token,...headers},body});
 }});
 const native=await req('projects/challenge',{},'','POST',{Origin:'https://localhost'});assert.equal(native.status,200);assert.equal(native.headers.get('Access-Control-Allow-Origin'),'https://localhost');const nc=await native.json();assert(nc.anonymous_token);
 const preflight=await req('projects/challenge',undefined,'','OPTIONS',{Origin:'https://localhost','Access-Control-Request-Headers':'content-type,x-studio-transport'});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://localhost');
 const cookieOnly=await req('projects/'+b.project_id,undefined,'','GET',{Origin:'https://localhost',Cookie:'studio_session='+eb});assert.equal(cookieOnly.status,401);
 const cross=await req('projects/challenge',{},'','POST',{Origin:'https://evil.test'});assert.equal(cross.status,403);
 console.log('PASS independent real-D1 API: create/PoW/idempotent recovery; 0000/0001; salted/peppered administrator password; HttpOnly cookie; owner/editor/file/Range isolation; conflict/history restore; credential revocation; archive; quota rollback; hashed brute-force limit; reauthenticated cascading delete; original class tables absent.');
}finally{await mf.dispose()}
