import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const origin='https://studio.example.invalid';
const endpoint=new URL(origin);
const scratch=await mkdtemp(join(tmpdir(),'studio-e3-production-'));
const settings={legacySample:join(scratch,'legacy.pptx'),scratch};
const sample=join(scratch,'multipart.pptx');
const bucket='rehearsal-studio-media';
const database='rehearsal-studio';
const productionD1='00000000-0000-4000-8000-000000000001';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const releaseSha=process.env.GITHUB_SHA ?? '';
const confirmation=process.env.E3_CONFIRMATION ?? '';
const [authority,version,...args]=confirmation.split(' ');
const consolePolicy=args.at(-1)==='D1-CONSOLE';
const projects=consolePolicy?args.slice(0,-1):args;
const operations=['V1.5-R2-SYNTHETIC','V1.5-R2-RESUME','V1.5-R2-PILOT','V1.5-R2-OFF','V1.5-R2-E35'];


const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeOrigin = 'https://localhost';
const r2 = '/api/rehearsal/r2-uploads';
const media = '/api/rehearsal/pptx';
const partBytes = 5 * 1024 * 1024;
const logs = [];
function sessionHeaders(project, transport = 'native') {
  return transport === 'native'
    ? { Origin: nativeOrigin, 'X-Studio-Transport': 'bearer', 'X-Studio-Session': project?.token ?? '' }
    : { Origin: endpoint.origin, Cookie: project ? 'studio_session=' + project.token : '' };
}
async function call(label, path, options = {}) {
  assert(/^\/api\/(?:projects|rehearsal)\b/.test(path));
  const { project, transport, method = 'GET', data, bytes, headers = {}, expected = [200] } = options;
  const sent = performance.now();
  const response = await fetch(endpoint.origin + path, {
    method, redirect:'error',
    headers: { ...sessionHeaders(project, transport), ...(project && { 'X-Studio-Project': project.id }),
      ...(data !== undefined && { 'Content-Type': 'application/json' }),
      ...(bytes && { 'Content-Type': 'application/octet-stream' }), ...headers },
    body: bytes ?? (data !== undefined ? JSON.stringify(data) : undefined),
    signal:AbortSignal.timeout(60_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  const ray = response.headers.get('cf-ray');
  const record = { label, status:response.status, ms:Math.round(performance.now()-sent), ray };
  logs.push(record);
  assert(ray, label + ' did not return a Cloudflare Ray ID');
  assert(expected.includes(response.status), label + ' HTTP ' + response.status);
  return { response, body, data: () => JSON.parse(body.toString()) };
}
async function create(title) {
  const { nonce, anonymous_token } = (await call('challenge','/api/projects/challenge',{
    method:'POST',data:{},
  })).data();
  let solution = 0;
  while(!hash(nonce + ':' + solution).startsWith('0000')) solution++;
  const password = 'Qa!'+randomBytes(20).toString('hex');
  const code = String(randomBytes(4).readUInt32LE() % 10000).padStart(4, '0');
  const { project_id:id } = (await call('create unlisted production synthetic project','/api/projects',{
    method:'POST', expected:[201], headers:{ 'X-Studio-Anonymous':anonymous_token },
    data:{ title, code, admin_password:password, seconds:900, visibility:'unlisted',
      challenge:nonce,solution:String(solution),request_id:randomBytes(32).toString('hex') },
  })).data();
  assert.match(id,/^[a-zA-Z0-9_-]+$/);
  const signed = (await call('APK session','/api/projects/'+id+'/session',{
    method:'POST',data:{password:code},
  })).data();
  const web = await call('cookie session','/api/projects/'+id+'/session',{
    method:'POST',data:{password:code},transport:'web',
  });
  const cookie = web.response.headers.getSetCookie().find(value=>value.startsWith('studio_session='));
  assert(cookie && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie));
  return {id,token:signed.session_token,cookieToken:cookie.split(';')[0].slice('studio_session='.length),code,password};
}
function cleanDocument({id,releaseId,scriptVersion,deckVersion,algorithmVersion,updatedAt,...document}) {return document;}

async function legacyPptx(control) {
  const legacyBytes=await readFile(settings.legacySample);
  assert(legacyBytes.length>0&&legacyBytes.length<=1024*1024,'Use a small synthetic PPTX for the actual D1 write');
  const legacyRoot='/api/rehearsal/uploads';
  const legacyInfo={kind:'pptx',bytes:legacyBytes.length,hash:hash(legacyBytes)};
  const legacy=(await call('ordinary D1 start after stop',legacyRoot,{
    method:'POST',data:legacyInfo,project:control,
  })).data();
  assert.equal(legacy.partBytes,256*1024);
  for(let index=legacy.next;index<Math.ceil(legacyBytes.length/legacy.partBytes);index++){
    await call('ordinary D1 part '+index,legacyRoot+'/'+legacy.id+'/'+index,{
      method:'POST',bytes:legacyBytes.subarray(index*legacy.partBytes,(index+1)*legacy.partBytes),project:control,
    });
  }
  const committed=(await call('ordinary D1 commit after stop',legacyRoot+'/'+legacy.id+'/finish',{
    method:'POST',data:{kind:'pptx'},project:control,
  })).data();
  assert.equal(committed.id,legacy.id);
  const old=await call('new D1 file read back',media+'/'+committed.id,{project:control});
  assert.equal(hash(old.body),legacyInfo.hash);
  return {id:committed.id,hash:legacyInfo.hash};
}


async function verifyCanary() {
  const project = settings.project;
  const control = settings.control;
  const web = { ...project, token: project.cookieToken };
  const webOptions = { project: web, transport: 'web' };
  assert(project?.id !== control?.id);
  const bytes=await readFile(sample);
  assert(bytes.length>partBytes && bytes.length<=20*1024*1024);
  const info={kind:'pptx',bytes:bytes.length,hash:hash(bytes)};
  await call('ordinary project R2 policy denied',r2,{project:control,expected:[404]});
  const policy=(await call('allowlisted production R2 enabled',r2,webOptions)).data();
  assert.equal(policy.maxDeckBytes,20*1024*1024);
  const post=(label,path,data,extra={})=>call(label,path,{...webOptions,method:'POST',data,...extra});
  const start=(await post('R2 begin',r2,info)).data();
  assert.equal(start.partBytes,partBytes);
  assert.equal(start.next,0,'Use a fresh isolated test file for this run');
  const target=r2+'/'+start.id;
  const put=(i,b,expected)=>call('R2 part '+i,target+'/'+i,{
    ...webOptions,method:'POST',bytes:b,expected,headers:{'X-Rehearsal-Metadata':start.session},
  });
  await put(0,bytes.subarray(0,partBytes));
  const resumed=(await post('R2 reopen after omitted acknowledgement',r2,info)).data();
  assert.equal(resumed.next,1);
  assert.equal(resumed.session,start.session);
  await put(0,bytes.subarray(0,partBytes));
  const modified=Buffer.from(bytes.subarray(0,partBytes));modified[0]^=1;
  await put(0,modified,[409]);
  for (let offset=partBytes;offset<bytes.length;offset+=partBytes) await put(offset/partBytes,bytes.subarray(offset,offset+partBytes));
  {
    await call('unauthenticated upload rejected',r2,{method:'POST',data:info,
      headers:{'X-Studio-Project':project.id},expected:[401,403]});
    await call('cross-project upload session rejected',target+'/0',{
      method:'POST',bytes:bytes.subarray(0,1),project:control,
      headers:{'X-Rehearsal-Metadata':start.session},expected:[401,403,404],
    });

  }
  const done=(await post('R2 finalize and server SHA-256',target+'/finish',{kind:'pptx'},{
    headers:{'X-Rehearsal-Metadata':start.session},
  })).data();
  assert.equal(done.id,start.id);
  assert.equal(done.bytes,bytes.length);
  const repeated=(await post('repeat production PPTX finalization',target+'/finish',{kind:'pptx'},{
    headers:{'X-Rehearsal-Metadata':start.session},
  })).data();
  assert.deepEqual(repeated,done);
  const cut=await call('Range crossing a partition',media+'/'+done.id,{
    ...webOptions,expected:[206],headers:{Range:'bytes=5242875-5242885'},
  });
  assert.deepEqual(cut.body,bytes.subarray(partBytes-5,partBytes+6));
  const file=await call('read back committed R2 content',media+'/'+done.id,webOptions);
  assert.equal(hash(file.body),info.hash);
  await call('cross-project media read rejected',media+'/'+done.id,{project:control,expected:[401,403,404]});
  const mediaEvidence=await verifyAdditionalMedia(project,done,file.body);
  const evidence={fileId:done.id,bytes:done.bytes,hash:info.hash,pages:done.pages,mediaEvidence};
  return evidence;
}


async function verifyAdditionalMedia(project, source, deck) {
  const web = { ...project, token: project.cookieToken };
  const webOptions = { project: web, transport: 'web' };
  const send = (label, path, data, options={}) => call(label, path, { ...webOptions, method:'POST', data, ...options });
  async function upload(info, bytes, finalData) {
    const start = (await send('begin '+info.kind, r2, info)).data();
    const path = r2+'/'+start.id;
    const headers = { 'X-Rehearsal-Metadata': start.session };
    await call('upload '+info.kind, path+'/0', { ...webOptions, method:'POST', bytes, headers });
    const final = await send('finish '+info.kind, path+'/finish', finalData, { headers });
    return { media:final.data(), retry:()=>send('repeat '+info.kind, path+'/finish', finalData, { headers }) };
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const { media:preview } = await upload({kind:'slide',hash:hash(png),bytes:png.length,sourceId:source.sourceIds[0],mime:'image/png'},png,{kind:'slide'});
  const draft = (await call('web draft for preview and recording','/api/rehearsal/edit/draft',webOptions)).data().project;
  const publication = {
    ...cleanDocument(draft),
    members:[{id:'speaker',name:'Synthetic speaker',enabled:true}],
    blocks:[{id:'speech',paragraphId:'speech',text:'Synthetic R2 verification.',memberId:'speaker',nonspoken:false,slideIndex:0,paragraphEnd:true}],
    slides:[{...preview,pageIndex:0,sourcePage:source.pages[0],sourceId:source.sourceIds[0]}],
    sourceDeck:{id:source.id,bytes:source.bytes,pages:source.pages},
    status:'published',
  };
  const published = (await send('publish synthetic deck', '/api/rehearsal/edit', publication)).data().project;
  const pngRead = await call('read web R2 slide preview','/api/rehearsal/slides/'+preview.id,webOptions);
  assert.deepEqual(pngRead.body,png);
  const audio = Buffer.from('T2dnUwACAAAAAAAAAADTOfF5AAAAABtWgsgBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAANM58XkBAAAABWzyEgE9T3B1c1RhZ3MMAAAATGF2ZjYxLjcuMTAzAQAAAB0AAABlbmNvZGVyPUxhdmM2MS4xOS4xMDEgbGlib3B1c09nZ1MAAIC7AAAAAAAA0znxeQIAAAAmmS4PMgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDuP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+uP/+T2dnUwAEuLwAAAAAAADTOfF5AwAAAJzuleEBA7j//g==','base64');
  const recording = {id:randomUUID(), memberId:'speaker', turnId:'turn-speech', scriptVersion:published.scriptVersion,
    deckVersion:published.deckVersion, algorithmVersion:published.algorithmVersion, durationMs:1000,mediaDurationMs:1000,
    clockDurationMs:1000,events:[{t_ms:0,slide_index:0,source:'start'}], hash:hash(audio)};
  const rec = await upload({kind:'audio',id:recording.id,mime:'audio/ogg',bytes:audio.length,hash:recording.hash},
    audio,{kind:'audio',mime:'audio/ogg',recording});
  assert.equal((await rec.retry()).data().retried,true);
  assert.deepEqual((await call('read web R2 recording','/api/rehearsal/audio/'+rec.media.id,webOptions)).body,audio);
  const [reference] = await productionSql('SELECT count(*) AS matches FROM rehearsal_recording_release_refs WHERE recording_id='+sqlId(rec.media.id));
  assert.equal(reference.matches,1);
  const { createRequire } = await import('node:module');
  const { dirname } = await import('node:path');
  const require = createRequire(import.meta.url);
  const { build } = require(require.resolve('esbuild',{ paths:[dirname(require.resolve('wrangler/package.json'))] }));
  const built = await build({stdin:{contents:"export {exportPptx} from './lib/rehearsal/pptx';",resolveDir:process.cwd()},
    bundle:true,format:'esm',platform:'node',write:false});
  const {exportPptx} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
  const {unzipSync,strFromU8} = await import('fflate');
  const exported = unzipSync(exportPptx(deck,published));
  const notes = Object.entries(exported).find(([path])=>/^ppt\/notesSlides\/[^/]+\.xml$/.test(path));
  assert(notes && strFromU8(notes[1]).includes('Synthetic R2 verification.'));
  const input=unzipSync(deck);
  for(const [path,asset] of Object.entries(input))if(path.startsWith('ppt/media/'))assert.deepEqual(exported[path],asset);
  return [
    {kind:'pptx', fileId:source.id, bytes:deck.length, hash:hash(deck)},
    {kind:'slide', fileId:preview.id, bytes:png.length, hash:hash(png)},
    {kind:'audio', fileId:rec.media.id, bytes:audio.length, hash:hash(audio)},
  ];
}


async function prepareFixture() {
  const {zipSync, strToU8}=await import('fflate');
  const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRel='http://schemas.openxmlformats.org/package/2006/relationships';
  const presentation='http://schemas.openxmlformats.org/presentationml/2006/main';
  const files=Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="'+packageRel+'"><Relationship Id="rId1" Type="'+rel+'/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml':'<p:presentation xmlns:p="'+presentation+'" xmlns:r="'+rel+'"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels':'<Relationships xmlns="'+packageRel+'"><Relationship Id="rId1" Type="'+rel+'/slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml':'<p:sld xmlns:p="'+presentation+'"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>',
  }).map(([name,xml])=>[name,strToU8(xml)]));
  await writeFile(settings.legacySample,zipSync(files));
  files['ppt/media/synthetic-qa.jpg']=randomBytes(6*1024*1024);
  await writeFile(sample,zipSync(files,{level:0}));
}

function wrangler(args) {
  return execFileSync('pnpm',['exec','wrangler',...args],{encoding:'utf8',stdio:['ignore','pipe','inherit'],timeout:120_000,
    env:{...process.env,NO_COLOR:'1',WRANGLER_SEND_METRICS:'false'}});
}
async function productionSql(sql) {
  const result=JSON.parse(wrangler(['d1','execute',database,'--config','wrangler.json','--remote','--json','--command',sql]));
  assert.equal(result[0]?.success,true);
  return result[0].results;
}
function sqlId(id) {
  assert.match(id,/^[a-zA-Z0-9_-]{1,80}$/);
  return "'"+id+"'";
}
function inspectVersion(id, writes, message) {
  assert.match(id,uuid);
  const version=JSON.parse(wrangler(['versions','view',id,'--name',database,'--json']));
  const bindings=version.resources?.bindings;
  assert.equal(version.id,id);
  assert(Array.isArray(bindings));
  for(const name of ['STUDIO_PASSWORD_PEPPER','STUDIO_ACCESS_ISSUER','STUDIO_ACCESS_AUDIENCE','STUDIO_PLATFORM_ADMIN_SUBJECTS']) {
    assert(bindings.some(b=>b.name===name&&b.type==='secret_text'),'Missing required Access or application secret');
  }
  const d1=bindings.filter(b=>b.type==='d1');
  const r2=bindings.filter(b=>b.type==='r2_bucket');
  assert.equal(d1.length,1); assert.equal(d1[0].name,'DB'); assert.equal(d1[0].id,productionD1);
  assert.equal(r2.length,1); assert.equal(r2[0].name,'STUDIO_MEDIA'); assert.equal(r2[0].bucket_name,bucket);
  assert(bindings.some(b=>b.name==='STUDIO_R2_READS'&&b.type==='plain_text'&&b.text==='on'));
  const writeBinding=bindings.filter(b=>b.name==='STUDIO_R2_WRITES');
  if(writes)assert.deepEqual(writeBinding.map(b=>[b.type,b.text]),[['plain_text','on']]);
  else assert.equal(writeBinding.length,0);
  if(message!==undefined)assert.equal(version.annotations?.['workers/message'],message,'Worker version must be built from this protected release SHA');
  return version;
}
function assertRuntimeRelease(source) {
  assert(source,'Missing verified Worker release source');
  if(source===releaseSha)return;
  execFileSync('git',['merge-base','--is-ancestor',source,releaseSha],{stdio:'ignore'});
  const allowed=new Set(['scripts/rehearsal-e3-production.mjs','.github/workflows/v15-production.yml']);
  const changes=execFileSync('git',['diff','--name-only','--no-renames','-z',source,releaseSha],{encoding:'utf8'})
    .split('\0').filter(Boolean);
  assert(changes.length>0&&changes.every(path=>allowed.has(path)),'Production application or configuration differs from the verified release');
}
function inspectCompatibilityVersion(id) {
  const compatible=inspectVersion(id,false);
  assertRuntimeRelease(/^Guarded release ([a-f0-9]{40})$/.exec(compatible.annotations?.['workers/message']??'')?.[1]);
}
function inspectWriterVersion(id) {
  const writer=inspectVersion(id,true);
  assertRuntimeRelease(/^E3 R2 writes ([a-f0-9]{40})$/.exec(writer.annotations?.['workers/message']??'')?.[1]);
}
function assertCurrent(id) {
  const current=JSON.parse(wrangler(['deployments','status','--name',database,'--json'])).versions;
  assert(Array.isArray(current),'No active production Worker deployment result');
  assert.deepEqual(current.map(item=>[item.version_id,item.percentage]),[[id,100]],'Expected Worker must already serve 100% of production');
}
function promote(id) {
  wrangler(['versions','deploy',id+'@100','--name',database,'--yes']);
  assertCurrent(id);
}
async function verifyAvailability() {
  const home=await fetch(origin+'/',{signal:AbortSignal.timeout(20_000)});
  assert.equal(home.status,200);
  await home.body?.cancel();
  const protectedPaths=['/admin','/api/admin','/platform-admin','/api/platform-admin'];
  for(const path of protectedPaths) {
    const response=await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(20_000)});
    assert([302,303,401,403].includes(response.status),'Unexpected Access result at '+path);
    await response.body?.cancel();
  }
}
async function waitForConsolePolicy(projectId, enabledCount) {
  const id=sqlId(projectId);
  console.log(JSON.stringify({d1ConsolePolicy:{projectId,maxDeckBytes:20971520,enabledCount}}));
  const deadline=Date.now()+5*60_000;
  while(Date.now()<deadline){
    const [policy]=await productionSql("SELECT count(*) AS enabled,coalesce(max(CASE WHEN project_id="+id+
      " THEN max_deck_bytes END),0) AS deck_limit FROM studio_r2_write_policy");
    if(policy.enabled===enabledCount&&policy.deck_limit===20971520)return;
    assert(policy.enabled<=enabledCount&&[0,20971520].includes(policy.deck_limit),'Unexpected D1 policy scope or size');
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw new Error('Timed out waiting for the exact D1 console policy');
}
async function startSynthetic() {
  inspectCompatibilityVersion(version);
  assertCurrent(version);
  const [base]=await productionSql("SELECT (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS migration,(SELECT count(*) FROM studio_r2_write_policy) AS policies,(SELECT count(*) FROM studio_r2_media m LEFT JOIN rehearsal_files f ON f.id=m.file_id LEFT JOIN rehearsal_projects p ON p.id=f.project_id LEFT JOIN studio_project_visibility v ON v.project_id=p.id WHERE m.state='r2' AND (coalesce(p.title,'')<>'E3 R2 production synthetic verification' OR coalesce(v.visibility,'')<>'unlisted')) AS business_r2_files");
  assert.deepEqual(base,{migration:'0013_r2_uploads.sql',policies:0,business_r2_files:0});
  await verifyAvailability();
  await prepareFixture();
  const project=await create('E3 R2 production synthetic verification');
  const control=await create('E3 D1 production synthetic control');
  Object.assign(settings,{project,control});
  const legacy=await legacyPptx(control);
  const message='E3 R2 writes '+releaseSha;
  const result=wrangler(['versions','upload','--no-x-provision','--name',database,'--var','STUDIO_R2_WRITES:on','--message',message]);
  const candidate=result.match(/^Worker Version ID: ([a-f0-9-]+)$/m)?.[1] ?? '';
  inspectVersion(candidate,true,message);
  let completed=false;
  let policyMayExist=false;
  let trafficMayHaveChanged=false;
  try {
    policyMayExist=true;
    if(consolePolicy)await waitForConsolePolicy(project.id,1);
    else await productionSql('INSERT INTO studio_r2_write_policy VALUES ('+sqlId(project.id)+',20971520)');
    assertCurrent(version);
    trafficMayHaveChanged=true;
    promote(candidate);
    for(let attempt=0;;attempt++){
      const visible=await call('wait for production R2 allowlist at edge',r2,{project,expected:[200,404]});
      if(visible.response.ok)break;
      if(attempt===14)throw new Error('R2 version did not take effect at the edge');
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    const evidence=await verifyCanary();
    for(const media of evidence.mediaEvidence) {
      const id=sqlId(media.fileId);
      const [row]=await productionSql("SELECT m.state,m.object_key,v.bytes,v.hash,(SELECT count(*) FROM rehearsal_file_chunks WHERE file_id="+id+") AS chunks FROM studio_r2_media m JOIN studio_r2_verified v ON v.object_key=m.object_key WHERE m.file_id="+id);
      assert.equal(row.state,'r2'); assert.equal(row.bytes,media.bytes); assert.equal(row.hash,media.hash); assert.equal(row.chunks,0);
      assert.match(row.object_key,/^studio\/e3\/[a-zA-Z0-9/_-]+$/);
      const localPath=join(scratch,media.kind+'-object');
      wrangler(['r2','object','get',bucket+'/'+row.object_key,'--remote','--file',localPath]);
      const stored=await readFile(localPath);
      assert.equal(stored.length,media.bytes); assert.equal(hash(stored),media.hash);
      console.log(JSON.stringify({kind:media.kind,bytes:media.bytes,sha256:media.hash,d1Reference:'r2'}));
    }
    const old=await call('D1 control upload still readable with R2 writes on',media+'/'+legacy.id,{project:control});
    assert.equal(hash(old.body),legacy.hash);
    await verifyAvailability();
    completed=true;
    console.log(JSON.stringify({releaseSha,workerVersion:candidate,writeOffVersion:version,files:evidence.mediaEvidence.length,
      bytes:evidence.mediaEvidence.reduce((sum,file)=>sum+file.bytes,0),scope:'one unlisted synthetic project'}));
  } finally {
    if(!completed){
      try {
        if(trafficMayHaveChanged)promote(version);
      } finally {
        if(policyMayExist){
          if(consolePolicy)console.log(JSON.stringify({removeD1ConsolePolicy:project.id}));
          else await productionSql('DELETE FROM studio_r2_write_policy WHERE project_id='+sqlId(project.id));
        }
      }
    }
  }
}
async function admitPilot(projectId) {
  inspectWriterVersion(version);
  assertCurrent(version);
  const id=sqlId(projectId);
  const [state]=await productionSql("SELECT (SELECT count(*) FROM studio_r2_write_policy) AS enabled,(SELECT count(DISTINCT f.kind) FROM studio_r2_write_policy w JOIN rehearsal_projects p ON p.id=w.project_id JOIN studio_project_visibility v ON v.project_id=p.id JOIN rehearsal_files f ON f.project_id=p.id JOIN studio_r2_media m ON m.file_id=f.id WHERE p.title='E3 R2 production synthetic verification' AND v.visibility='unlisted' AND m.state='r2') AS r2_count");
  assert(state.enabled>=1&&state.enabled<=2&&state.r2_count>=3,'Prior production synthetic verification and bounded pilot required');
  const rows=await productionSql("SELECT project_id FROM studio_r2_write_policy WHERE project_id="+id);
  if(rows.length===0){
    const eligible=" FROM rehearsal_projects WHERE id="+id+" AND archived_at IS NULL AND deleted_at IS NULL AND title NOT LIKE 'E3 % production synthetic%' AND EXISTS(SELECT 1 FROM studio_d1_media WHERE project_id="+id+")";
    const projects=await productionSql('SELECT id'+eligible);
    assert.equal(projects.length,1,'Specify one active business project with existing media');
    if(consolePolicy)await waitForConsolePolicy(projects[0].id,state.enabled+1);
    else {
      const enrolled=await productionSql('INSERT INTO studio_r2_write_policy (project_id,max_deck_bytes) SELECT id,20971520'+eligible+' RETURNING project_id');
      assert.equal(enrolled.length,1,'The selected pilot project changed before admission');
    }
  }
  console.log(JSON.stringify({releaseSha,workerVersion:version,scope:'controlled pilot',expectedNextStep:'Observe an actual new business upload'}));
}

async function resumeVerifiedCanary() {
  const [writeOffVersion,projectId,pilotProjectId,confirmedDigest]=projects;
  assert(consolePolicy,'Resuming requires exact project policies in the D1 console');
  assert.notEqual(projectId,pilotProjectId);
  assert.match(confirmedDigest,/^[a-f0-9]{64}$/);
  inspectCompatibilityVersion(writeOffVersion);
  inspectWriterVersion(version);
  assertCurrent(writeOffVersion);
  const [state]=await productionSql("SELECT (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS migration,(SELECT count(*) FROM studio_r2_write_policy) AS policies,(SELECT count(*) FROM studio_r2_media WHERE state='r2') AS r2_files");
  assert.deepEqual(state,{migration:'0013_r2_uploads.sql',policies:0,r2_files:3});
  const files=await productionSql("SELECT f.kind,v.bytes,v.hash,m.object_key,(SELECT count(*) FROM rehearsal_file_chunks c WHERE c.file_id=f.id) AS d1_chunks FROM studio_r2_media m JOIN rehearsal_files f ON f.id=m.file_id JOIN studio_r2_verified v ON v.object_key=m.object_key JOIN rehearsal_projects p ON p.id=f.project_id JOIN studio_project_visibility visibility ON visibility.project_id=p.id WHERE p.id="+sqlId(projectId)+" AND p.title='E3 R2 production synthetic verification' AND p.archived_at IS NULL AND p.deleted_at IS NULL AND visibility.visibility='unlisted' AND m.state='r2' ORDER BY f.kind");
  assert.deepEqual(files.map(file=>file.kind),['audio','pptx','slide']);
  for(const file of files){
    assert.equal(file.d1_chunks,0);
    assert(Number.isSafeInteger(file.bytes)&&file.bytes>0);
    assert.match(file.hash,/^[a-f0-9]{64}$/);
    assert(file.object_key.startsWith('studio/e3/'+projectId+'/'));
  }
  const manifest=files.map(file=>[file.kind,file.bytes,file.hash,file.object_key]);
  assert.equal(hash(JSON.stringify(manifest)),confirmedDigest,'The tested R2 manifest differs from the confirmed console evidence');
  let trafficMayHaveChanged=false;
  try {
    await waitForConsolePolicy(projectId,1);
    assertCurrent(writeOffVersion);
    trafficMayHaveChanged=true;
    promote(version);
    await verifyAvailability();
    await admitPilot(pilotProjectId);
    console.log(JSON.stringify({releaseSha,workerVersion:version,writeOffVersion,files:files.length,
      bytes:files.reduce((total,file)=>total+file.bytes,0),confirmedDigest,pilotProjectId}));
  } catch(error) {
    try {
      if(trafficMayHaveChanged)promote(writeOffVersion);
    } finally {
      console.log(JSON.stringify({removeD1ConsolePolicies:[projectId,pilotProjectId]}));
    }
    throw error;
  }
}

async function waitFor(label, check, minutes=6) {
  const deadline=Date.now()+minutes*60_000;
  while(Date.now()<deadline){
    if(await check())return;
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw new Error('Timed out waiting for '+label);
}

async function e35State() {
  const [row]=await productionSql(`SELECT
    (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS migration,
    (SELECT count(*) FROM studio_r2_write_policy) AS grants,
    (SELECT count(*) FROM studio_r2_media) AS r2_files,
    (SELECT count(*) FROM studio_d1_media) AS d1_files,
    (SELECT coalesce(sum(length(data)),0) FROM rehearsal_file_chunks) AS d1_bytes,
    (SELECT coalesce(sum(bytes),0) FROM studio_r2_verified) AS r2_verified_bytes,
    (SELECT coalesce(sum(integrity),0) FROM studio_r2_upload_failures) AS integrity_failures,
    (SELECT count(*) FROM studio_r2_media m LEFT JOIN studio_r2_verified v USING(object_key)
      JOIN rehearsal_files f ON f.id=m.file_id WHERE m.object_key LIKE 'studio/e3/%'
       AND (v.object_key IS NULL OR v.hash<>f.hash OR min(v.bytes,20971520)<>f.bytes)) AS bad_refs`);
  assert(row&&row.bad_refs===0&&row.integrity_failures===0,'Unresolved media integrity alert');
  return row;
}

async function verifyE35Web(project, control) {
  const web={project:{...project,token:project.cookieToken},transport:'web'};
  const bytes=await readFile(settings.legacySample),sum=hash(bytes);
  const caps=(await call('site default on an unlisted project',r2,web)).data();
  assert.equal(caps.maxDeckBytes,20*1024*1024);
  const start=(await call('new site-default PPTX reservation',r2,{...web,method:'POST',
    data:{kind:'pptx',bytes:bytes.length,hash:sum}})).data();
  assert.equal(start.next,0);
  assert.equal(start.partBytes,partBytes);
  const headers={'X-Rehearsal-Metadata':start.session};
  await call('new site-default PPTX part',r2+'/'+start.id+'/0',{...web,method:'POST',headers,bytes});
  const file=(await call('new site-default PPTX commit',r2+'/'+start.id+'/finish',{
    ...web,method:'POST',headers,data:{kind:'pptx'},
  })).data();
  assert.equal(file.id,start.id);
  const read=await call('fresh PPTX full download',media+'/'+file.id,web);
  assert.equal(hash(read.body),sum);
  await call('cross-project PPTX read denied',media+'/'+file.id,{project:control,expected:[404]});
  const evidence=await verifyAdditionalMedia(project,file,read.body);
  for(const rec of evidence){
    const [row]=await productionSql(`SELECT m.state,v.bytes,v.hash,
      (SELECT count(*) FROM rehearsal_file_chunks WHERE file_id=f.id) AS chunks
      FROM rehearsal_files f JOIN studio_r2_media m ON m.file_id=f.id
      JOIN studio_r2_verified v ON v.object_key=m.object_key WHERE f.id=${sqlId(rec.fileId)}`);
    assert.deepEqual(row,{state:'r2',bytes:rec.bytes,hash:rec.hash,chunks:0});
  }
  return evidence.map(({kind,bytes})=>({kind,bytes}));
}

async function e35Cutover(writeOffVersion) {
  // The old writer and the verified reader must remain known good; unlike
  // the E3 allowlist helper they need not contain this new application SHA.
  inspectVersion(version,true);
  const reader=inspectVersion(writeOffVersion,false);
  assert.match(reader.annotations?.['workers/message']??'',/^Guarded release [a-f0-9]{40}$/);
  assertCurrent(version);
  const before=await e35State();
  const snapshot=JSON.parse(await readFile(join(process.env.RUNNER_TEMP,'studio-e35-d1','preflight-summary.json'),'utf8'));
  assert(snapshot.bookmarkUnchanged&&snapshot.offlineRestoreIntegrity==='ok'&&snapshot.offlineForeignKeys==='ok');
  assert.equal(before.migration,'0013_r2_uploads.sql');
  await prepareFixture();
  const project=await create('E3.5 R2 production synthetic pilot');
  const control=await create('E3.5 production synthetic D1 compatibility');
  const legacy=await legacyPptx(control);
  const message='E3.5 R2 guarded '+releaseSha;
  const result=wrangler(['versions','upload','--no-x-provision','--name',database,'--var','STUDIO_R2_WRITES:on','--message',message]);
  const candidate=result.match(/^Worker Version ID: ([a-f0-9-]+)$/m)?.[1]??'';
  inspectVersion(candidate,true,message);
  console.log(JSON.stringify({checkpoint:'verified-candidate-and-D1-restore; apply-0014-in-pilot',releaseSha,candidate,baseline:before,pilotSynthetic:project.id}));
  await waitFor('D1 migration 0014',async()=>(await e35State()).migration==='0014_r2_site_write_policy.sql');
  const [site]=await productionSql('SELECT mode,max_deck_bytes FROM studio_r2_site_policy WHERE id=1');
  assert.deepEqual(site,{mode:'pilot',max_deck_bytes:20971520});
  await waitFor('bounded pilot enrollment',async()=>{
    const [s]=await productionSql(`SELECT count(*) AS grants,
      count(CASE WHEN project_id=${sqlId(project.id)} THEN 1 END) AS synthetic,
      count(CASE WHEN project_id<>${sqlId(project.id)} AND project_id<>${sqlId(control.id)}
        AND EXISTS (SELECT 1 FROM rehearsal_projects p WHERE p.id=project_id
          AND p.title NOT LIKE '%production synthetic%' AND p.archived_at IS NULL AND p.deleted_at IS NULL) THEN 1 END) AS real
      FROM studio_r2_effective_policy`);
    assert(s.grants<=before.grants+2,'Pilot enrollment unexpectedly broad');
    return s.synthetic===1&&s.real>=2;
  });
  assertCurrent(version);
  let candidateMayServe=false;
  try{
    candidateMayServe=true;
    promote(candidate);
    await verifyAvailability();
    const checkD1=await call('existing D1 media still readable',media+'/'+legacy.id,{project:control});
    assert.equal(hash(checkD1.body),legacy.hash);
    const pilotWeb={project:{...project,token:project.cookieToken},transport:'web'};
    await call('expanded pilot R2 capability',r2,pilotWeb);
    await call('unlisted control still outside pilot',r2,{project:control,expected:[404]});
    const draft=await call('expanded pilot draft read', '/api/rehearsal/edit/draft',pilotWeb);
    assert(draft.data().project);
    await verifyE35Web(project,control);
    console.log(JSON.stringify({checkpoint:'pilot-live; change-mode-to-all',candidate,releaseSha}));
    await waitFor('default site R2 policy',async()=>{
      const [entry]=await productionSql('SELECT mode,max_deck_bytes FROM studio_r2_site_policy WHERE id=1');
      assert.equal(entry?.max_deck_bytes,20971520);
      return entry.mode==='all';
    });
    const ordinary=await create('E3.5 default R2 production synthetic verification');
    assert.equal((await productionSql(`SELECT project_id FROM studio_r2_write_policy WHERE project_id=${sqlId(ordinary.id)}`)).length,0);
    const evidence=await verifyE35Web(ordinary,control);
    const old=await call('legacy APK-written D1 content after site cutover',media+'/'+legacy.id,{project:control});
    assert.equal(hash(old.body),legacy.hash);
    await verifyAvailability();
    assertCurrent(candidate);
    console.log(JSON.stringify({releaseSha,workerVersion:candidate,writeOffVersion,mode:'all',media:evidence,after:await e35State()}));
  }catch(error){
    if(candidateMayServe){promote(writeOffVersion);await verifyAvailability();}
    throw error;
  }
}

try {
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.GITHUB_REPOSITORY,'Edmond400/rehearsal-studio');
  assert.equal(process.env.GITHUB_REF,'refs/heads/release/v1.5');
  assert.match(releaseSha,/^[a-f0-9]{40}$/);
  assert(operations.includes(authority)&&uuid.test(version??''));
  assert.equal(projects.length,authority==='V1.5-R2-PILOT'||authority==='V1.5-R2-E35'?1:authority==='V1.5-R2-RESUME'?4:0);
  execFileSync(process.execPath,['scripts/assert-independent-deploy.mjs'],{stdio:'inherit'});
  const config=JSON.parse(await readFile('wrangler.json','utf8'));
  assert.equal(config.vars?.STUDIO_R2_READS,'on');
  if(authority==='V1.5-R2-SYNTHETIC')await startSynthetic();
  if(authority==='V1.5-R2-RESUME')await resumeVerifiedCanary();
  if(authority==='V1.5-R2-PILOT')await admitPilot(projects[0]);
  if(authority==='V1.5-R2-E35'){
    assert(!consolePolicy&&uuid.test(projects[0]));
    await e35Cutover(projects[0]);
  }
  if(authority==='V1.5-R2-OFF'){
    inspectCompatibilityVersion(version);
    promote(version);
    await verifyAvailability();
    if(!consolePolicy)await productionSql('DELETE FROM studio_r2_write_policy');
    console.log(JSON.stringify({releaseSha,workerVersion:version,mode:'R2 reads enabled, writes off'}));
  }
} finally {
  for(const record of logs)console.log(JSON.stringify(record));
  await rm(scratch,{recursive:true,force:true});
}
