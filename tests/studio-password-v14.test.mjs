import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {testDirectory} from './studio-directory-v14.test.mjs';

const require=createRequire(import.meta.url),search=[dirname(require.resolve('wrangler/package.json'))];
const {build}=require(require.resolve('esbuild',{paths:search})),{Miniflare}=require(require.resolve('miniflare',{paths:search}));
const code=await build({stdin:{contents:`
 import {apiCors} from './lib/http';
 import {handleProjects} from './lib/projects';
 import {newAdminCredential,verifyAdminPassword} from './lib/admin-password';
 export default {async fetch(r){
  const p=new URL(r.url).pathname.split('/').filter(Boolean).slice(2);
  if(p[0]==='test-kdf'){
   const record=await newAdminCredential('benchmark','Fixture#Bench2026');
   return Response.json({ok:await verifyAdminPassword('benchmark','Fixture#Bench2026',record),iterations:record.iterations});
  }
  return apiCors(r,()=>handleProjects(r,p));
 }}
`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'neutral',format:'esm',write:false,external:['cloudflare:workers','node:*']});
const site='https://studio.test',native='https://localhost',pepper='b'.repeat(64),legacySalt='d'.repeat(64);
const pass='Fixture#Admin731',legacyKey='e'.repeat(64),pid='fixture-legacy',hash=s=>createHash('sha256').update(s).digest('hex');
const makeMf=pepper=>new Miniflare({modules:true,script:code.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{NATIVE_APP_ORIGIN:native,...(pepper?{STUDIO_PASSWORD_PEPPER:pepper}:{})}});
async function schema(db){
 for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()){
  for(const statement of readFileSync('migrations/'+f,'utf8').match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/gi)||[])await db.prepare(statement).run();
 }
}
let ip=0;
function request(mf,path,body,token='',options={}){
 const mode=options.web?{}:{'X-Studio-Transport':'bearer',...(token?{'X-Studio-Session':token}:{})};
 return mf.dispatchFetch(site+'/api/projects'+path,{
  method:options.method??(body===undefined?'GET':'POST'),
  headers:{Origin:options.web?site:native,'CF-Connecting-IP':'192.0.2.'+(++ip%250),...mode,...(options.headers||{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})
 });
}
async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json()}
async function seedLegacy(db){
 const timestamp='2026-11-04T00:00:00.000Z';
 const document=JSON.stringify({id:pid,title:'旧项目不会进入公开目录',status:'draft',revision:0,scriptVersion:'s',deckVersion:'d',algorithmVersion:'a',config:{hardLimitSeconds:900}});
 const joinHash=createHmac('sha256',legacySalt).update('editor-code:'+pid+':0007').digest('hex');
 await db.batch([
  db.prepare("INSERT INTO studio_settings VALUES ('verifier-salt',?)").bind(legacySalt),
  db.prepare("INSERT INTO rehearsal_projects(id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at,password_hash,credential_version) VALUES (?,?,'draft',0,'s','d','a',?,?,?,1)").bind(pid,'旧项目不会进入公开目录',document,timestamp,joinHash),
  db.prepare('INSERT INTO studio_owner_credentials VALUES (?,?,1)').bind(pid,hash(legacyKey)),
  db.prepare('INSERT INTO studio_usage(project_id) VALUES (?)').bind(pid)
 ]);
}

const mf=makeMf(pepper);
try{
 const db=await mf.getD1Database('DB');await schema(db);await seedLegacy(db);
 const req=(...a)=>request(mf,...a),q=(sql,...a)=>db.prepare(sql).bind(...a).first();
 const legacy=await ok(await req('/'+pid+'/session',{password:legacyKey}));
 assert(legacy.legacy_upgrade_required);
 const editor=await ok(await req('/'+pid+'/session',{password:'0007'}));
 assert.equal(editor.role,'editor');
 assert.equal((await req('/'+pid+'/owner/upgrade',{owner_key:legacyKey,admin_password:pass},editor.session_token)).status,403);
 assert.equal((await req('/'+pid+'/owner/upgrade',{owner_key:'a'.repeat(64),admin_password:pass},legacy.session_token)).status,403);
 assert.equal((await req('/'+pid+'/owner/upgrade',{owner_key:legacyKey,admin_password:'1234567'},legacy.session_token)).status,400);
 await db.prepare("CREATE TRIGGER test_fail_upgrade BEFORE DELETE ON studio_owner_credentials BEGIN SELECT RAISE(ABORT,'injected'); END;").run();
 assert.equal((await req('/'+pid+'/owner/upgrade',{owner_key:legacyKey,admin_password:pass},legacy.session_token)).status,409);
 assert.equal(await q('SELECT 1 FROM studio_admin_passwords WHERE project_id=?',pid),null);
 await ok(await req('/'+pid+'/owner/status',undefined,legacy.session_token));
 assert((await ok(await req('/'+pid+'/session',{password:legacyKey}))).legacy_upgrade_required);
 await db.prepare('DROP TRIGGER test_fail_upgrade').run();
 const upgrade=await ok(await req('/'+pid+'/owner/upgrade',{owner_key:legacyKey,admin_password:pass},legacy.session_token));
 assert(!upgrade.owner_key);assert.equal((await req('/'+pid+'/owner/status',undefined,legacy.session_token)).status,401);
 assert.equal((await req('/'+pid+'/owner-session',{secret:legacyKey})).status,401);
 assert.equal((await req('/'+pid+'/session',{password:legacyKey})).status,401);
 assert.equal((await ok(await req('/'+pid+'/session',{password:pass}))).role,'owner');
 assert.equal((await ok(await req('/'+pid+'/owner/status',undefined,upgrade.session_token))).visibility,'unlisted');
 assert.equal((await q('SELECT count(*) n FROM studio_owner_credentials WHERE project_id=?',pid)).n,0);
 assert.equal((await q('SELECT credential_version FROM studio_admin_passwords WHERE project_id=?',pid)).credential_version,2);
 assert.equal((await req('/'+pid+'/owner/archive',{archived:true,password:'incorrect'},upgrade.session_token)).status,403);
 assert.equal((await req('/'+pid+'/edit/cleanup',{password:'incorrect'},upgrade.session_token)).status,403);
 assert.equal((await req('/'+pid+'/owner/code',{code:'0010',password:'0007'},editor.session_token)).status,403);
 assert.equal((await req('/'+pid+'/owner/visibility',{visibility:'public',password:pass},editor.session_token)).status,403);
 await ok(await req('/'+pid+'/owner/password',{password:pass,new_password:'12345678'},upgrade.session_token));
  assert.equal((await ok(await req('/'+pid+'/session',{password:'12345678'}))).role,'owner');
  const numericOwner=await ok(await req('/'+pid+'/session',{password:'12345678'}));
  await ok(await req('/'+pid+'/owner/password',{password:'12345678',new_password:pass},numericOwner.session_token));
  const restoredOwner=await ok(await req('/'+pid+'/session',{password:pass}));
  await ok(await req('/'+pid+'/owner/code',{code:'0010',password:pass},restoredOwner.session_token));
 assert.equal((await req('/'+pid,undefined,editor.session_token)).status,401);
 assert.match((await q('SELECT password_hash FROM rehearsal_projects WHERE id=?',pid)).password_hash,/^v14:[a-f0-9]{64}$/);
 assert.equal((await ok(await req('/'+pid+'/session',{password:'0010'}))).role,'editor');

 const create=async(title,visibility)=>{
  const challenge=await ok(await req('/challenge',{}));
  let solution=0;while(!hash(challenge.nonce+':'+solution).startsWith('0000'))solution++;
  const body={title,seconds:120,code:'0000',admin_password:pass,...(visibility?{visibility}:{}),challenge:challenge.nonce,solution:String(solution),request_id:randomBytes(32).toString('hex')};
  const headers={'X-Studio-Anonymous':challenge.anonymous_token};
  const response=await req('',body,'',{headers}),created=await ok(response,201);
  assert.match(response.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict; Max-Age=604800/);
  assert(!created.owner_key);
  assert.equal((await req('',{...body,admin_password:'Other#Admin2026'},'',{headers})).status,409);
  assert.equal((await req('',{...body,visibility:visibility==='unlisted'?'public':'unlisted'},'',{headers})).status,409);
  assert.equal((await ok(await req('',body,'',{headers}))).project_id,created.project_id);
  return created;
 };
 const publicProject=await create('V14 公开样本'),hiddenProject=await create('V14 隐藏样本','unlisted');
 const a=await q('SELECT * FROM studio_admin_passwords WHERE project_id=?',publicProject.project_id),b=await q('SELECT * FROM studio_admin_passwords WHERE project_id=?',hiddenProject.project_id);
 assert.notEqual(a.salt,b.salt);assert.notEqual(a.verifier,b.verifier);assert(!JSON.stringify(a).includes(pass));assert.notEqual(a.verifier,hash(pass));
 assert.equal((await req('/'+publicProject.project_id+'/edit',undefined,hiddenProject.session_token)).status,401);
 const webLogin=await req('/'+publicProject.project_id+'/session',{password:'0000'},'',{web:true,headers:{'X-Studio-Transport':'bearer'}});
 const cookie=webLogin.headers.get('Set-Cookie').split(';')[0];
 assert.equal((await ok(webLogin)).session_token,undefined);
 assert.equal((await req('/'+publicProject.project_id+'/edit',undefined,'',{web:true,headers:{Cookie:cookie}})).status,200);
 assert.equal((await req('/'+publicProject.project_id+'/edit',undefined,'',{web:true,headers:{'X-Studio-Session':publicProject.session_token}})).status,401);
 assert.equal((await req('/'+publicProject.project_id+'/edit',undefined,'',{headers:{Cookie:cookie}})).status,401);
 await testDirectory({db,req,ok,publicProject,hiddenProject,pid,pass});
 assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);

 const timings=[];
 for(let i=0;i<13;i++){
  const start=performance.now(),result=await ok(await req('/test-kdf'));
  assert(result.ok);assert.equal(result.iterations,16000);
  if(i)timings.push(performance.now()-start);
 }
 timings.sort((a,b)=>a-b);
 console.log('Workerd local wall time for two KDF derivations plus dispatch: p50='+timings[5].toFixed(2)+' ms, p95='+timings[11].toFixed(2)+' ms (not production CPU).');
 console.log('PASS V1.4 dual credentials, fail-closed upgrade rollback, role/project isolation, code rehash and session revocation, metadata directory, cookies and Native Bearer.');
}finally{await mf.dispose()}

const misconfigured=makeMf(undefined);
try{
 const db=await misconfigured.getD1Database('DB');await schema(db);await seedLegacy(db);
 const legacy=await ok(await request(misconfigured,'/'+pid+'/session',{password:legacyKey}));
 assert.equal((await request(misconfigured,'/'+pid+'/owner/upgrade',{owner_key:legacyKey,admin_password:pass},legacy.session_token)).status,503);
 assert(!!await db.prepare('SELECT 1 FROM studio_owner_credentials WHERE project_id=?').bind(pid).first());
 assert.equal(await db.prepare('SELECT 1 FROM studio_admin_passwords WHERE project_id=?').bind(pid).first(),null);
 console.log('PASS missing Worker pepper fails closed and preserves the old administrator credential.');
}finally{await misconfigured.dispose()}
