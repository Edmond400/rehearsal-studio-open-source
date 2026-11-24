import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const wrangler = dirname(require.resolve('wrangler/package.json'));
const miniflare = require.resolve('miniflare', {paths:[wrangler]});
const { Miniflare } = require(miniflare);
const { build } = require(require.resolve('esbuild', {paths:[wrangler]}));
const compiled = await build({
  entryPoints: ['worker.ts'], bundle:true, platform:'neutral', format:'esm', write:false,
  external:['cloudflare:workers','node:*'],
  plugins:[{
    name:'synthetic-studio-routes',
    setup(builder) {
      builder.onResolve({filter:/^vinext\/server\/app-router-entry$/}, () => ({path:'router', namespace:'test'}));
      builder.onLoad({filter:/.*/, namespace:'test'}, () => ({
        contents:`export default {fetch(request) {
          if (request.method === 'POST') {
            if (new URL(request.url).pathname.endsWith('/uploads'))
              return Response.json({error:'存储容量不足。'}, {status:409});
            return Response.json({ok:true}, {headers:{'Set-Cookie':'studio_session=test; Path=/'}});
          }
          return new Response('ordinary studio');
        }};`,
      }));
    },
  }],
});
const issuer = 'https://test-studio.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const subject = 'test-admin-subject';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:2048});
const keyset = {keys:[{...publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256'}]};
const mf = new Miniflare({
  modules:true, script:compiled.outputFiles[0].text, compatibilityDate:'2026-05-15',
  compatibilityFlags:['nodejs_compat'], d1Databases:['DB'],
  outboundService(request) {
    if (new URL(request.url).pathname === '/cdn-cgi/access/certs') return Response.json(keyset);
    return new Response(null,{status:404});
  },
  bindings:{STUDIO_ACCESS_ISSUER:issuer,STUDIO_ACCESS_AUDIENCE:audience,
    STUDIO_PLATFORM_ADMIN_SUBJECTS:subject,STUDIO_OPS_TELEMETRY:'1'},
});
const origin = 'https://studio.example';
const clock = Math.floor(Date.now()/1000);
function jwt(overrides = {}, headerOverrides = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = encode({alg:'RS256',kid:'fixture',...headerOverrides}) + '.' +
    encode({iss:issuer, aud:[audience], sub:subject, email:'admin@example.test', type:'app',
      iat:clock-10, exp:clock+120,...overrides});
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
}
const get = (url, token, init = {}) => mf.dispatchFetch(origin+url, {...init,
  headers:{...(token?{'Cf-Access-Jwt-Assertion':token}:{}), ...init.headers}});
const admin = jwt();

try {
  const db = await mf.getD1Database('DB');
  const q = (sql,...values) => db.prepare(sql).bind(...values);
  for (const filename of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort()) {
    const sql = readFileSync('migrations/'+filename,'utf8').replace(/^--.*$/gm,'');
    for (const statement of sql.match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/gi) ?? [])
      await db.prepare(statement).run();
  }
  const now = new Date().toISOString();
  await q(`INSERT INTO rehearsal_projects (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at)
    VALUES ('private-fixture','<script>private title</script>','draft',0,'s','d','a','{"privateScript":"secret fixture"}',?)`,now).run();
  await q("INSERT INTO rehearsal_versions VALUES ('private-fixture',0,'{}',?)",now).run();
  await q("INSERT INTO studio_usage(project_id) VALUES ('private-fixture')").run();
  await q("INSERT INTO rehearsal_files VALUES ('file-private','private-fixture','pptx','application/zip',1024,?,?)",'a'.repeat(64),now).run();
  await q("INSERT INTO rehearsal_media_uploads (id,project_id,kind,mime,bytes,hash,expires_at) VALUES ('stage','private-fixture','audio','audio/webm',20,?,?)",
    'b'.repeat(64),Date.now()-10).run();

  for (const url of ['/admin','/api/admin','/api/admin/projects/private-fixture','/platform-admin','/api/platform-admin/media']) {
    assert.equal((await get(url)).status,401,url);
    assert.equal((await get(url,null,{headers:{Cookie:'studio_session=project-owner'}})).status,401,url);
  }
  for (const token of [jwt({iss:'https://wrong.cloudflareaccess.com'}),jwt({aud:['b'.repeat(64)]}),
    jwt({exp:clock-1}),jwt({type:'service'}),jwt({}, {alg:'none'}),admin.slice(0,-4)+'xxxx']) {
    assert.equal((await get('/api/admin',token)).status,401);
  }
  assert.equal((await get('/api/admin',jwt({sub:'someone-else'}))).status,403);
  const response = await get('/api/admin?visibility=unlisted&anomaly=with',admin);
  assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get('Cache-Control'),/no-store/);
  const overview = await response.json();
  assert.equal(overview.projects,1);
  assert.equal(overview.cumulativeProjects,1);
  assert.equal(overview.unlisted,1);
  assert.equal(overview.fileBytes,1024);
  assert.equal(overview.reservedBytes,20);
  assert.equal(overview.expiredUploads,1);
  assert.equal(overview.pptxWeek,1);
  assert.equal(overview.projectsPage[0].id,'private-fixture');
  assert.equal((await (await get('/api/admin?page=2',admin)).json()).projectsPage.length,0);
  const html = await (await get('/admin?project=private-fixture',admin)).text();
  assert.match(html,/&lt;script&gt;private title&lt;\/script&gt;/);
  assert.doesNotMatch(html,/secret fixture|file-private|<script>/);
  assert.equal((await get('/api/admin/projects/private-fixture/media',admin)).status,404);
  assert.equal((await get('/api/platform-admin/media',admin)).status,404);
  assert.equal((await get('/api/admin/projects/private-fixture',admin,{method:'DELETE'})).status,405);
  assert.equal(await (await get('/')).text(),'ordinary studio');
  const uploadFailure = await get('/api/projects/private-fixture/uploads',null,{method:'POST',headers:{Origin:origin}});
  assert.equal(uploadFailure.status,409);
  const success = await get('/api/projects/private-fixture/edit/draft',null,{method:'POST',headers:{Origin:origin}});
  assert.equal(success.status,200);
  const cookies = success.headers.getSetCookie().map(value=>value.split(';')[0]);
  assert.equal(cookies.length,3);
  const track = await get('/api/projects/private-fixture/edit/draft',null,{method:'POST',headers:{Origin:origin,Cookie:cookies.join('; ')}});
  assert.equal(track.headers.getSetCookie().length,2,'same browser reuses its device and session identifiers');
  const optedOut = await get('/api/projects/private-fixture/edit/draft',null,{method:'POST',headers:{Origin:origin,'Sec-GPC':'1'}});
  assert.equal(optedOut.headers.getSetCookie().length,1);
  for (let attempt=0; attempt<15; attempt++) {
    const data = await (await get('/api/admin',admin)).json();
    if (data.devicesToday===1 && data.health.some(row=>row.kind==='quota'&&row.count===1)) break;
    if (attempt===14) assert.fail('expected D1 telemetry');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  console.log('PASS operations Worker: Access signature and claims, legacy routes, private metadata, pagination, telemetry and cookie compatibility');
} finally {
  await mf.dispose();
}
