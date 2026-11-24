import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {zipSync,strToU8} from 'fflate';

// CPU time is NOT available from HTTP timings. Correlate the recorded cf-ray
// IDs with Cloudflare Workers observability/tail logs for actual CPU metrics.
// This test is intentionally unable to target a production domain or Worker.
const MiB=1024*1024,PART=256*1024,sha=b=>createHash('sha256').update(b).digest('hex');
const target=process.env.STUDIO_PERF_URL;
assert(target,'Set STUDIO_PERF_URL to the authorized test workers.dev URL');
const u=new URL(target);
assert(u.protocol==='https:'&&u.username===''&&u.password===''&&u.pathname==='/'&&!u.search&&!u.hash&&
 /^rehearsal-studio-v14-perf-test\.[a-z0-9-]+\.workers\.dev$/.test(u.hostname),
 'Refusing to run against a non-isolated Cloudflare Worker');
const path=resolve(process.env.STUDIO_PERF_REPORT||'docs/evidence/v1.4/cloud-perf-smoke.json');
const state={origin:u.origin,createdAt:new Date().toISOString(),cpuMeasured:false,
 cpuSource:'Cloudflare Workers observability / tail logs',requestCap:500,requests:0,checks:[],errors:[],entries:[]};
let anonymous='',project='',token='';
const auth=extra=>({'Origin':'https://localhost','X-Studio-Transport':'bearer',
 ...(anonymous?{'X-Studio-Anonymous':anonymous}:{}),
 ...(project?{'X-Studio-Project':project}:{}),
 ...(token?{'X-Studio-Session':token}:{}),...extra});
async function call(name,method,endpoint,body,headers={},timeout=30000){
 assert(++state.requests<=state.requestCap,'Request budget exceeded');
 const started=performance.now(),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeout);
 let status=0;
 try{
  const response=await fetch(u.origin+endpoint,{method,headers:auth(headers),body,signal:abort.signal});
  status=response.status;
  const data=Buffer.from(await response.arrayBuffer());
  state.entries.push({name,status,wallMs:Math.round(performance.now()-started),
   ...(response.headers.get('cf-ray')?{ray:response.headers.get('cf-ray')}: {})});
  if(!response.ok)throw new Error(name+' HTTP '+status+': '+data.toString('utf8').slice(0,220));
  return {data,headers:response.headers,json:()=>JSON.parse(data.toString('utf8'))};
 }catch(e){
  if(!status)state.entries.push({name,status:0,wallMs:Math.round(performance.now()-started),error:String(e).slice(0,220)});
  throw e;
 }finally{clearTimeout(timer)}
}
const post=(name,endpoint,body)=>call(name,'POST',endpoint,JSON.stringify(body),{'Content-Type':'application/json'});
function pptx(size,salt){
 const files={
  'ppt/presentation.xml':strToU8('<p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst>'),
  'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="slide" Type="schema/slide" Target="slides/slide1.xml"/></Relationships>'),
  'ppt/media/padding.bin':[new Uint8Array(),{level:0}]
 };
 files['ppt/media/padding.bin']=[new Uint8Array(size-zipSync(files).length).fill(salt),{level:0}];
 const file=Buffer.from(zipSync(files));assert.equal(file.length,size);return file;
}
async function createFixture(){
 const challenge=(await post('challenge','/api/projects/challenge',{})).json();
 anonymous=challenge.anonymous_token;
 assert(/^[a-f0-9]{64}$/.test(anonymous));
 let solution=0;
 while(!sha(Buffer.from(challenge.nonce+':'+solution)).startsWith('0000'))solution++;
 const created=(await post('create','/api/projects',{
  title:'Isolated V1.4 perf '+Date.now(),seconds:900,code:'0001',
  admin_password:'Fixture#Admin800',visibility:'unlisted',
  challenge:challenge.nonce,solution:String(solution),
  request_id:randomBytes(32).toString('hex')
 })).json();
 project=created.project_id;token=created.session_token;
 assert(project&&token,'Synthetic owner session not returned');
 state.checks.push('Created synthetic unlisted test project');
}
async function transfer(name,bytes,kind,metadata){
 const digest=sha(bytes),base='/api/rehearsal/uploads';
 const id=kind==='audio'?metadata.id:undefined;
 const started=(await post(name+' start',base,{kind,hash:digest,bytes:bytes.length,
  ...(id?{id,mime:'audio/webm'}:{})})).json();
 assert.equal(started.partBytes,PART);assert.equal(started.next,0);
 for(let offset=0;offset<bytes.length;offset+=PART){
  const i=offset/PART;
  const piece=bytes.subarray(offset,Math.min(bytes.length,offset+PART));
  const step=(await call(name+' part '+i,'POST',base+'/'+encodeURIComponent(started.id)+'/'+i,
   piece,{'Content-Type':'application/octet-stream'})).json();
  assert.equal(step.id,started.id);assert.equal(step.next,i+1);
 }
 const finished=(await post(name+' finish',base+'/'+encodeURIComponent(started.id)+'/finish',
  kind==='audio'?{kind:'audio',mime:'audio/webm',recording:metadata}:{kind:'pptx'})).json();
 assert.equal(finished.id,started.id);
 state.checks.push(name+' final SHA-256 '+digest);
 return {id:started.id,hash:digest};
}
async function verify(name,endpoint,bytes,digest){
 const parts=[];
 for(let offset=0;offset<bytes.length;offset+=PART){
  const end=Math.min(bytes.length-1,offset+PART-1);
  const x=await call(name+' range '+offset/PART,'GET',endpoint,undefined,
   {'Range':'bytes='+offset+'-'+end});
  assert.equal(x.headers.get('content-range'),'bytes '+offset+'-'+end+'/'+bytes.length);
  assert.equal(x.headers.get('etag'),'"sha256-'+digest+'"');
  assert.equal(x.data.length,end-offset+1);parts.push(x.data);
 }
 assert.equal(sha(Buffer.concat(parts)),digest);
 state.checks.push(name+' '+parts.length+' ranged responses verified');
}
async function publishedProject(){
 const prefix='/api/projects/'+project;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const slide=(await call('slide fixture','POST',prefix+'/edit/slides',png,{'Content-Type':'image/png'})).json();
 const p=(await call('draft fixture','GET',prefix+'/edit')).json().project;
 const {id,scriptVersion,deckVersion,algorithmVersion,updatedAt,...input}=p;
 const published=(await post('publish fixture',prefix+'/edit',{...input,status:'published',
  members:[{id:'perf-member',name:'合成测试成员',enabled:true}],
  slides:[{...slide,pageIndex:0}],
  blocks:[{id:'perf-block',paragraphId:'perf-block',text:'合成汇报讲稿。',memberId:'perf-member',
   nonspoken:false,slideIndex:0,paragraphEnd:true}]
 })).json().project;
 assert.equal(published.status,'published');return published;
}
async function run(){
 await createFixture();
 let legacyMedia=null;
 for(const n of [1,5,10,20]){
  const bytes=pptx(n*MiB,n),name='PPTX '+n+' MiB';
  const file=await transfer(name,bytes,'pptx');
  const endpoint='/api/rehearsal/edit/pptx/'+encodeURIComponent(file.id);
  await verify(name,endpoint,bytes,file.hash);
  if(n===20&&process.env.STUDIO_PERF_INCLUDE_LEGACY==='1')legacyMedia={endpoint,hash:file.hash};
 }
 const p=await publishedProject();
 const audio=Buffer.alloc(10*MiB,0x21);audio.set([0x1a,0x45,0xdf,0xa3]);
 const id=randomUUID(),meta={id,memberId:'perf-member',turnId:'turn-perf-block',
  scriptVersion:p.scriptVersion,deckVersion:p.deckVersion,algorithmVersion:p.algorithmVersion,
  hash:sha(audio),durationMs:1000,mediaDurationMs:1000,clockDurationMs:1000,
  events:[{t_ms:0,slide_index:0,source:'start'}]};
 const saved=await transfer('synthetic audio 10 MiB',audio,'audio',meta);
 await verify('synthetic audio 10 MiB','/api/rehearsal/edit/audio/'+encodeURIComponent(id),audio,saved.hash);
 state.checks.push('Synthetic audio verifies transport only; bytes are not playable WebM');
 // Run the potentially CPU-heavy legacy path only after all new-path evidence
 // has been collected, so a 1102 here cannot hide the segmented test results.
 if(legacyMedia){
  const old=await call('legacy full 20 MiB GET','GET',legacyMedia.endpoint,undefined,{},90000);
  assert.equal(sha(old.data),legacyMedia.hash);
  state.checks.push('Legacy whole-file download hash verified');
 }
}
try{await run();state.passed=true;}catch(error){
 state.passed=false;state.errors.push(String(error?.stack||error).slice(0,1700));
}finally{
 state.finishedAt=new Date().toISOString();
 await mkdir(dirname(path),{recursive:true});
 await writeFile(path,JSON.stringify(state,null,2)+'\n');
 console.log('V1.4 isolated performance '+(state.passed?'PASS':'FAIL')+
  '; requests='+state.requests+'; report='+path);
 if(!state.passed){console.error(state.errors.join('\n'));process.exitCode=1;}
}