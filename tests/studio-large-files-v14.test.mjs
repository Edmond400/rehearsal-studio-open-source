import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {strToU8,zipSync} from 'fflate';

const require=createRequire(import.meta.url),search=[dirname(require.resolve('wrangler/package.json'))];
const {build}=require(require.resolve('esbuild',{paths:search})),{Miniflare}=require(require.resolve('miniflare',{paths:search}));
const temp=await mkdtemp(join(tmpdir(),'studio-large-fixture-'));
const fixture=process.argv[2]??join(temp,'limit.pptx');
if(!process.argv[2])execFileSync('python',['tests/generate-pptx-capacity-fixtures.py',temp],{stdio:'inherit'});
const bytes=await readFile(fixture),MiB=1024*1024,hash=body=>createHash('sha256').update(body).digest('hex');
assert.equal(bytes.length,20*MiB);
const binaryType='application/vnd.openxmlformats-officedocument.presentationml.presentation';
const meterSource=` import {AsyncLocalStorage} from 'node:async_hooks';
 import {env} from 'cloudflare:workers';
 export const scope=new AsyncLocalStorage(),metrics=new Map();
 export function metered(){
  const db=env.DB,stats=scope.getStore(),unwrapped=new WeakMap();
  const wrap=(stmt)=>{
   const proxy=new Proxy(stmt,{get(target,key){
    if(key==='bind')return (...values)=>wrap(target.bind(...values));
    if(['first','run','all','raw'].includes(key))return async (...values)=>{
     stats.statements++;stats.calls++;const r=await target[key](...values);
     stats.rowsRead+=r?.meta?.rows_read??0;return r;
    };
    return Reflect.get(target,key);
   }});unwrapped.set(proxy,stmt);return proxy;
  };
  return {prepare(sql){return wrap(db.prepare(sql))},async batch(entries){
   stats.statements+=entries.length;stats.calls++;const r=await db.batch(entries.map(e=>unwrapped.get(e)??e));
   for(const result of r)stats.rowsRead+=result.meta?.rows_read??0;
   return r;
  }};
 }
`;
const script=await build({stdin:{contents:`
 import {handleProjects} from './lib/projects';
 import {handleRehearsal} from './lib/rehearsal/service';
 import {scope,metrics} from 'test:meter';
 export default {fetch(request){
  const [_,api,root,...path]=new URL(request.url).pathname.split('/');
  if(root==='test-metrics')return Response.json(metrics.get(path[0]));
  const stats={statements:0,calls:0,rowsRead:0};
  metrics.set(request.headers.get('X-Test-Request'),stats);
  return scope.run(stats,()=>root==='projects'?handleProjects(request,path):handleRehearsal(request,path));
 }};
`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false,platform:'neutral',external:['cloudflare:workers','node:*'],plugins:[{name:'meter-d1',setup(bundler){
 bundler.onLoad({filter:/\/lib\/data\.ts$/},()=>({contents:"export {metered as database} from 'test:meter'"}));
 bundler.onResolve({filter:/^test:meter$/},()=>({path:'meter',namespace:'meter'}));
 bundler.onLoad({filter:/.*/,namespace:'meter'},()=>({contents:meterSource}));
}}]});
const profileEnabled=process.env.STUDIO_PROFILE==='1';
const mf=new Miniflare({...(profileEnabled?{inspectorPort:0}:{}),modules:true,script:script.outputFiles[0].text,compatibilityDate:'2026-05-15',
 compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{STUDIO_PASSWORD_PEPPER:'1'.repeat(64)}});
const origin='https://isolate.test';
let id='stress-project';
const secret=randomUUID();
const folder=process.argv[3];
const results={};
let profiler;
async function connectProfiler(){
 const inspector=await mf.getInspectorURL();
 const targets=await (await fetch('http://'+inspector.host+'/json/list')).json();
 const target=targets.find(t=>/user/i.test(t.title))??targets[0];
 assert(target?.webSocketDebuggerUrl,'Workerd inspector target missing');
 const socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 const pending=new Map();let seq=0;
 socket.onmessage=event=>{
  const response=JSON.parse(event.data),reply=pending.get(response.id);
  if(reply){pending.delete(response.id);response.error?reply.reject(Error(response.error.message)):reply.resolve(response.result);}
 };
 const send=(method,params)=>new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));
 });
 await send('Profiler.enable');
 await send('Profiler.setSamplingInterval',{interval:1000});
 return {socket,send,target:target.title};
}
async function call(label,method,path,body,extra={}){
 const profiled=profiler&&(/whole-file upload|full 20 MiB|^20 MiB (?:part 0|range 0|finish)$/.test(label));
 if(profiled)await profiler.send('Profiler.start');
 const requestId=randomUUID(),start=performance.now();
 const response=await mf.dispatchFetch(origin+path,{method,headers:{Origin:origin,Cookie:'studio_session='+secret,
  'X-Studio-Project':id,'X-Test-Request':requestId,...extra},body,...(body instanceof ReadableStream?{duplex:'half'}:{})});
 const data=Buffer.from(await response.arrayBuffer());
 const metrics=await (await mf.dispatchFetch(origin+'/api/test-metrics/'+requestId)).json();
 let v8;
 if(profiled){
  const {profile}=await profiler.send('Profiler.stop');
  const functions=new Map(profile.nodes.map(n=>[n.id,n.callFrame.functionName]));
  let jsSamples=0,programSamples=0,idleSamples=0;
  for(const id of profile.samples){
   const name=functions.get(id);
   if(name==='(program)')programSamples++;
   else if(name==='(idle)')idleSamples++;
   else jsSamples++;
  }
  v8={target:profiler.target,intervalUs:1000,jsSamples,programSamples,idleSamples};
 }
 results[label]={status:response.status,ms:Math.round(performance.now()-start),...metrics,...(v8?{v8}:{})};
 if(!/ (?:part|range) \d+$/.test(label)||profiled)console.log(label,JSON.stringify(results[label]));
 return {status:response.status,headers:response.headers,data,json:()=>JSON.parse(data),metrics};
}
try{
 const db=await mf.getD1Database('DB');
 for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()){
  const migration=await readFile(join('migrations',file),'utf8');
  for(const s of migration.match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/gi)??[])await db.prepare(s).run();
 }
 await db.batch([
  db.prepare("INSERT INTO rehearsal_projects (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at) VALUES (?,?,'draft',0,'s','d','a','{}','2026-11-05')").bind(id,id),
  db.prepare("INSERT INTO studio_sessions VALUES (?,?,'editor',0,?)").bind(hash(secret),id,Date.now()+600000),
  db.prepare('INSERT INTO studio_usage(project_id) VALUES (?)').bind(id)
 ]);
 if(profileEnabled)profiler=await connectProfiler();
 assert.equal((await db.prepare("SELECT hex(unhex('0001ff')) AS value").first()).value,'0001FF');
 console.log('PASS SQLite unhex BLOB round trip on local workerd/D1');
 const direct='/api/rehearsal/edit';
 const source={bytes:bytes.length,hash:hash(bytes)};
 const base='/api/rehearsal/uploads',partBytes=256*1024;
 const jsonType={'Content-Type':'application/json'};
 function deckOf(size,salt){
  const manifest={
   'ppt/presentation.xml':strToU8('<p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst>'),
   'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="slide" Type="schema/slide" Target="slides/slide1.xml"/></Relationships>'),
   'ppt/media/padding.bin':[new Uint8Array(0),{level:0}]
  };
  const padding=new Uint8Array(size-zipSync(manifest).length).fill(salt);
  manifest['ppt/media/padding.bin']=[padding,{level:0}];
  const pptx=Buffer.from(zipSync(manifest));
  assert.equal(pptx.length,size);
  return pptx;
 }
 const begin=async(label,body,declared=hash(body))=>call(label,'POST',base,JSON.stringify({
  kind:'pptx',bytes:body.length,hash:declared
 }),jsonType);
 const part=(label,upload,index,body)=>call(label,'POST',base+'/'+upload+'/'+index,body,{'Content-Type':'application/octet-stream'});
 const finish=(label,upload)=>call(label,'POST',base+'/'+upload+'/finish','{"kind":"pptx"}',jsonType);
 const checkStatus=(response,expected)=>assert.equal(response.status,expected,response.data.toString().slice(0,500));
 async function send(label,body,{interruption=false,race=false}={}){
  const start=performance.now(),started=await begin(label+' start',body);
  checkStatus(started,200);
  let {id:upload,next}=started.json();
  assert.equal(started.json().partBytes,partBytes);
  assert.equal(next,0);
  if(interruption){
   checkStatus(await finish(label+' premature finish',upload),409);
   checkStatus(await call(label+' hidden until commit','GET',direct+'/pptx/'+upload),404);
   checkStatus(await part(label+' out of order',upload,1,body.subarray(partBytes,2*partBytes)),409);
   checkStatus(await part(label+' short request',upload,0,body.subarray(0,100)),400);
   checkStatus(await call(label+' cross project','POST',base+'/'+upload+'/0',body.subarray(0,partBytes),
    {'X-Studio-Project':'another-project'}),401);
   const first=body.subarray(0,partBytes);
   checkStatus(await part(label+' part 0',upload,0,first),200);
   checkStatus(await part(label+' repeated exact part',upload,0,first),200);
   const different=Buffer.from(first);different[4]^=1;
   checkStatus(await part(label+' repeated wrong part',upload,0,different),409);
   const resumed=await begin(label+' resumed',body);
   checkStatus(resumed,200);assert.deepEqual(resumed.json(),{id:upload,next:1,partBytes});next=1;
  }
  for(let i=next;i<Math.ceil(body.length/partBytes);i++){
   const data=body.subarray(i*partBytes,(i+1)*partBytes);
   if(race&&i===0){
    const same=await Promise.all([part(label+' part 0a',upload,i,data),part(label+' part 0b',upload,i,data)]);
    for(const result of same){checkStatus(result,200);assert.equal(result.json().next,i+1);}
   }else{
    const result=await part(label+' part '+i,upload,i,data);checkStatus(result,200);assert.equal(result.json().next,i+1);
   }
  }
  const [ready,duplicate]=await Promise.all([finish(label+' finish',upload),...(race?[finish(label+' concurrent finish',upload)]:[])]);
  checkStatus(ready,200);
  if(duplicate){checkStatus(duplicate,200);assert.deepEqual(duplicate.json(),ready.json());}
  const saved=ready.json();assert.equal(saved.id,upload);assert.equal(saved.bytes,body.length);
  const actual=await db.prepare('SELECT COUNT(*) AS n FROM rehearsal_file_chunks WHERE file_id=?').bind(upload).first();
  assert.equal(actual.n,Math.ceil(body.length/(2*partBytes)));
  console.log(label+' upload total',JSON.stringify({bytes:body.length,parts:Math.ceil(body.length/partBytes),wallMs:Math.round(performance.now()-start)}));
  return saved;
 }
 async function fetchRanges(label,file,body){
  const start=performance.now(),received=[],hashOfFile=hash(body);
  for(let offset=0;offset<body.length;offset+=partBytes){
   const end=Math.min(body.length-1,offset+partBytes-1);
   const read=await call(label+' range '+(offset/partBytes),'GET',direct+'/pptx/'+file.id,undefined,{Range:'bytes='+offset+'-'+end});
   checkStatus(read,206);
   assert.equal(read.headers.get('Content-Range'),'bytes '+offset+'-'+end+'/'+body.length);
   assert.equal(read.headers.get('ETag'),'"sha256-'+hashOfFile+'"');
   received.push(read.data);
  }
  assert.equal(hash(Buffer.concat(received)),hashOfFile);
  console.log(label+' range total',JSON.stringify({parts:received.length,wallMs:Math.round(performance.now()-start)}));
 }
 const bodies=[1,5,10].map(size=>deckOf(size*MiB,size)).concat(bytes);
 const saved=[];
 for(const body of bodies){
  const label=body.length/MiB+' MiB';
  const file=await send(label,body,{interruption:body===bodies[0]});
  saved.push(file);
  await fetchRanges(label,file,body);
 }
 const replay=await finish('idempotent completed final commit',saved.at(-1).id);
 checkStatus(replay,200);assert.deepEqual(replay.json(),saved.at(-1));
 const copied=await begin('start already-committed original',bytes);
 assert.equal(copied.json().next,80);
 assert.equal(copied.json().id,saved.at(-1).id);
 // A caller may have a truncated local Blob but still declare the SHA-256 of
 // an already-committed original. The deterministic file ID must not permit
 // the resumable start endpoint to falsely claim that short Blob was uploaded.
 const truncatedOriginal=bytes.subarray(0,bytes.length-1);
 const wrongLength=await begin('existing original with wrong declared size',truncatedOriginal,hash(bytes));
 checkStatus(wrongLength,409);
 assert.equal((await db.prepare('SELECT count(*) n FROM rehearsal_media_uploads WHERE id=?').bind(saved.at(-1).id).first()).n,0);
 // A bad final part must not discard the first three verified parts.
 const recoveryBytes=deckOf(MiB,61),recoveryStart=await begin('recover last start',recoveryBytes);
 checkStatus(recoveryStart,200);
 const recoveryId=recoveryStart.json().id;
 for(let i=0;i<3;i++)checkStatus(await part('recover prefix part '+i,recoveryId,i,recoveryBytes.subarray(i*partBytes,(i+1)*partBytes)),200);
 const badLast=Buffer.from(recoveryBytes.subarray(3*partBytes));badLast[10]^=1;
 checkStatus(await part('recover corrupt last part',recoveryId,3,badLast),422);
 assert.deepEqual(await db.prepare('SELECT next_part,verified FROM rehearsal_media_uploads WHERE id=?').bind(recoveryId).first(),{next_part:3,verified:0});
 assert.equal((await db.prepare('SELECT count(*) n FROM rehearsal_media_parts WHERE upload_id=?').bind(recoveryId).first()).n,3);
 checkStatus(await call('recover staging invisible','GET',direct+'/pptx/'+recoveryId),404);
 const recoveryResume=await begin('recover last resumed',recoveryBytes);checkStatus(recoveryResume,200);
 assert.equal(recoveryResume.json().next,3);
 checkStatus(await part('recover correct last part',recoveryId,3,recoveryBytes.subarray(3*partBytes)),200);
 const recoveryDone=await finish('recover final commit',recoveryId);checkStatus(recoveryDone,200);
 assert.equal(recoveryDone.json().id,recoveryId);
 assert.deepEqual((await call('recover final full download','GET',direct+'/pptx/'+recoveryId)).data,recoveryBytes);
 const broken=deckOf(MiB,23),bad=await begin('wrong full SHA start',broken,'f'.repeat(64));
 for(let i=0;i<4;i++)checkStatus(await part('wrong full SHA part '+i,bad.json().id,i,broken.subarray(i*partBytes,(i+1)*partBytes)),i===3?422:200);
 checkStatus(await finish('wrong full SHA cannot be committed',bad.json().id),409);
 checkStatus(await call('wrong full SHA stays unpublished','GET',direct+'/pptx/'+bad.json().id),404);
 assert.equal((await db.prepare('SELECT next_part FROM rehearsal_media_uploads WHERE id=?').bind(bad.json().id).first()).next_part,3);
 await db.prepare('DELETE FROM rehearsal_media_uploads WHERE id=?').bind(bad.json().id).run();
 const invalidZip=Buffer.alloc(partBytes+1,7),badZip=await begin('valid digest with invalid ZIP start',invalidZip);
 checkStatus(await part('invalid ZIP part 0',badZip.json().id,0,invalidZip.subarray(0,partBytes)),200);
 checkStatus(await part('invalid ZIP part 1',badZip.json().id,1,invalidZip.subarray(partBytes)),200);
 checkStatus(await finish('valid digest does not authorize invalid ZIP',badZip.json().id),400);
 checkStatus(await call('invalid ZIP stays unpublished','GET',direct+'/pptx/'+badZip.json().id),404);
 await db.prepare('DELETE FROM rehearsal_media_uploads WHERE id=?').bind(badZip.json().id).run();

 const beforeConcurrent=performance.now();
 await Promise.all([
  send('concurrent A',deckOf(MiB,41),{race:true}),
  send('concurrent B',deckOf(5*MiB,42)),
  fetchRanges('concurrent 10 MiB GET',saved[2],bodies[2])
 ]);
 console.log('concurrent transfers verified',JSON.stringify({wallMs:Math.round(performance.now()-beforeConcurrent)}));
 const extra=deckOf(10*MiB,77),room=await begin('pending capacity reservation',extra);checkStatus(room,200);
 const filled=await begin('pending quota excludes another concurrent file',deckOf(10*MiB,78));checkStatus(filled,409);
 assert.equal((await db.prepare('SELECT sum(bytes) AS n FROM rehearsal_media_uploads').first()).n,10*MiB);
 await db.prepare('UPDATE rehearsal_media_uploads SET expires_at=0 WHERE id=?').bind(room.json().id).run();
 const replacement=await begin('expired reservation cleanup and replacement',deckOf(10*MiB,78));checkStatus(replacement,200);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM rehearsal_media_uploads').first()).n,1);
 await db.prepare('DELETE FROM rehearsal_media_uploads').run();
 const segmented=Object.entries(results).filter(([label])=>label.includes(' part ')||label.includes(' range '));
 console.log('bounded per-request meter',JSON.stringify({requests:segmented.length,maxStatements:Math.max(...segmented.map(([,m])=>m.statements)),
  maxCalls:Math.max(...segmented.map(([,m])=>m.calls))}));

 await db.prepare('DELETE FROM rehearsal_files WHERE project_id=?').bind(id).run();
 id='legacy-stress-project';
 const wrapped='/api/projects/'+id+'/edit';
 await db.batch([
  db.prepare("INSERT INTO rehearsal_projects (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at) VALUES (?,?,'draft',0,'s','d','a','{}','2026-11-05')").bind(id,id),
  db.prepare("UPDATE studio_sessions SET project_id=? WHERE token_hash=?").bind(id,hash(secret)),
  db.prepare('INSERT INTO studio_usage(project_id) VALUES (?)').bind(id)
 ]);
 const delay=Number(process.env.STUDIO_UPLOAD_DELAY_MS??60);
 const throttle=new ReadableStream({start(){this.offset=0},async pull(controller){
  if(this.offset>=bytes.length){controller.close();return;}
  const end=Math.min(bytes.length,this.offset+256*1024);
  await new Promise(resolve=>setTimeout(resolve,delay));
  controller.enqueue(bytes.subarray(this.offset,end));this.offset=end;
 }});
 const upload=await call('legacy 20 MiB whole-file upload','POST',wrapped+'/pptx',throttle,{'Content-Type':binaryType});
 assert.equal(upload.status,200,upload.data.toString().slice(0,500));
 const deck=upload.json();
 assert.equal(deck.pages.length,32);
 assert.equal(deck.bytes,bytes.length);
 assert.equal((await db.prepare('SELECT count(*) n FROM rehearsal_file_chunks WHERE file_id=?').bind(deck.id).first()).n,40);
 const download=await call('full 20 MiB original download','GET',wrapped+'/pptx/'+deck.id);
 assert.equal(download.status,200);
 assert.equal(hash(download.data),source.hash);
 const range=await call('range across chunk boundary','GET',wrapped+'/pptx/'+deck.id,undefined,{Range:'bytes=524286-524289'});
 assert.equal(range.status,206);assert.deepEqual(range.data,bytes.subarray(524286,524290));
 const retry=await call('identical original retry','POST',direct+'/pptx',bytes,{'Content-Type':binaryType});
 assert.equal(retry.status,200);assert.equal(retry.json().id,deck.id);
 const tooLarge=await call('20 MiB plus one byte','POST',direct+'/pptx',Buffer.concat([bytes,Buffer.from([0])]),{'Content-Type':binaryType});
 assert.equal(tooLarge.status,413);
 const overQuota=Buffer.from(bytes);overQuota[100000]^=1;
 await db.prepare('UPDATE studio_usage SET max_bytes=? WHERE project_id=?').bind(bytes.length,id).run();
 const refused=await call('20 MiB rejected by project quota','POST',wrapped+'/pptx',overQuota,{'Content-Type':binaryType});
 assert.equal(refused.status,409,refused.data.toString());
 assert.equal((await db.prepare('SELECT count(*) n FROM rehearsal_files WHERE project_id=?').bind(id).first()).n,1);
 await db.prepare('UPDATE studio_usage SET max_bytes=? WHERE project_id=?').bind(60*MiB,id).run();
 // Fill only fixture metadata to exercise the SQL site-limit predicate at exactly 180 MiB.
 const fill=['quota-fill-a','quota-fill-b','quota-fill-c'];
 await db.batch(fill.flatMap((pid,i)=>[
  db.prepare("INSERT INTO rehearsal_projects (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at) VALUES (?,?,'draft',0,'s','d','a','{}','2026-11-05')").bind(pid,pid),
  db.prepare('INSERT INTO studio_usage(project_id) VALUES (?)').bind(pid),
  ...Array.from({length:i===2?2:3},(_,j)=>db.prepare("INSERT INTO rehearsal_files VALUES (?,?,'pptx',?,?,?,'2026-11-05')")
   .bind(pid+'-'+j,pid,binaryType,20*MiB,source.hash))
 ]));
 assert.equal((await db.prepare('SELECT SUM(bytes) n FROM rehearsal_files').first()).n,180*MiB);
 const siteRefused=await call('180 MiB site quota rejection','POST',direct+'/preview-page',Buffer.from([255,216,255]),
  {'Content-Type':'image/jpeg','X-Rehearsal-Metadata':'256'});
 assert.equal(siteRefused.status,409);
 assert.equal((await db.prepare('SELECT SUM(bytes) n FROM rehearsal_files').first()).n,180*MiB);
 await db.prepare("DELETE FROM rehearsal_projects WHERE id IN ('quota-fill-a','quota-fill-b','quota-fill-c')").run();
 if(folder){
  const previews=await Promise.all(deck.sourceIds.map(async(sourceId,i)=>{
   const payload=await readFile(join(folder,'input-2-'+(i+1)+'.jpg'));
   return {sourceId,bytes:payload.length,hash:hash(payload),payload};
  }));
  const budget=await call('32-page upload preflight','POST',direct+'/preview-budget',
   JSON.stringify({source,pages:previews.map(({payload,...page})=>page)}),{'Content-Type':'application/json'});
  assert.equal(budget.status,200);assert.equal(budget.json().fits,true);
  const begin=performance.now(),pageMetrics=[];
  for(const [i,page] of previews.entries()){
   const uploaded=await call('preview page '+(i+1),'POST',direct+'/preview-page',page.payload,{'Content-Type':'image/jpeg','X-Rehearsal-Metadata':page.sourceId});
   assert.equal(uploaded.status,200);pageMetrics.push(uploaded.metrics.statements);
  }
  console.log('32 preview pages',JSON.stringify({totalBytes:previews.reduce((n,p)=>n+p.bytes,0),
   totalMs:Math.round(performance.now()-begin),maxStatements:Math.max(...pageMetrics)}));
 }
 for(const [label,m] of Object.entries(results))assert(m.calls<=50,label+' exceeds Free D1 invocation limit: '+m.calls);
}finally{profiler?.socket.close();await mf.dispose();await rm(temp,{recursive:true,force:true});}
