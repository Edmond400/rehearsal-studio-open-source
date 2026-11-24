import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const paths = [dirname(require.resolve('wrangler/package.json'))];
const { build } = require(require.resolve('esbuild', {paths}));
const { Miniflare } = require(require.resolve('miniflare', {paths}));
const compiled = await build({
  stdin:{contents:`
    import {handleProjects} from './lib/projects';
    import {getFile} from './lib/rehearsal/storage';
    import {mediaRange} from './lib/rehearsal/media-range';
    export default {fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture/inspect') return getFile('deck', 'pptx', 'a')
        .then(file => mediaRange(file, false, 2, 9)).then(data => new Response(data));
      return handleProjects(request, path.slice(1).split('/'));
    }};
  `,resolveDir:process.cwd(),loader:'ts'},
  bundle:true, platform:'neutral', format:'esm', write:false, external:['cloudflare:workers','node:*'],
});
const mf = new Miniflare({
  modules:true, script:compiled.outputFiles[0].text, compatibilityDate:'2026-05-15',
  compatibilityFlags:['nodejs_compat'], d1Databases:['DB'], r2Buckets:['STUDIO_MEDIA'],
  bindings:{STUDIO_R2_READS:'on',NATIVE_APP_ORIGIN:'https://localhost'},
});
const hash = data => createHash('sha256').update(data).digest('hex');
const deck = Buffer.from('example PPTX media bytes');
const audio = Buffer.from([0x1a,0x45,0xdf,0xa3,1,2,3,4,5,6]);
const root = 'https://fixture.example';
const get = (path, session, method = 'GET', extra = {}) => mf.dispatchFetch(root+path, {
  method, headers:{...extra,...(session?{Cookie:'studio_session='+session}:{})},
});
async function bytes(response, expected, status) {
  assert.equal(response.status,status);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
}

try {
  const db = await mf.getD1Database('DB');
  const q = (sql,...args) => db.prepare(sql).bind(...args).run();
  for (const filename of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort()) {
    const sql = readFileSync('migrations/'+filename,'utf8').replace(/^--.*$/gm,'');
    for (const statement of sql.match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/gi) ?? [])
      await q(statement);
  }
  const bucket = await mf.getR2Bucket('STUDIO_MEDIA');
  const now = new Date().toISOString();
  for (const id of ['a','b']) {
    await q(`INSERT INTO rehearsal_projects
      (id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at)
      VALUES (?,?,'draft',0,'s','d','a','{}',?)`,id,id,now);
    await q('INSERT INTO studio_usage (project_id) VALUES (?)',id);
    await q("INSERT INTO studio_sessions VALUES (?,?,'editor',0,?)",hash(id),id,Date.now()+60_000);
  }
  const putFile = (id,kind,mime,content) =>
    q("INSERT INTO rehearsal_files VALUES (?,'a',?,?,?,?,?)",id,kind,mime,content.length,hash(content),now);
  await putFile('deck','pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',deck);
  await q("INSERT INTO rehearsal_file_chunks VALUES ('deck',0,unhex(?))",deck.toString('hex'));
  await putFile('audio','audio','audio/webm',audio);
  await bucket.put('test-deck',deck,{sha256:hash(deck)});
  await bucket.put('test-audio',audio,{sha256:hash(audio)});
  await q("INSERT INTO studio_r2_media VALUES ('deck','test-deck','dual',?)",Date.now());
  await q("INSERT INTO studio_r2_media VALUES ('audio','test-audio','r2',?)",Date.now());

  const media = '/a/pptx/deck';
  const recording = '/a/audio/audio';
  await bytes(await get(media,'a'),deck,200);
  await bytes(await get('/fixture/inspect'),deck.subarray(2,9),200);
  const range = await get(recording,'a','GET',{Range:'bytes=2-5'});
  assert.equal(range.headers.get('Content-Range'),'bytes 2-5/'+audio.length);
  assert.equal(range.headers.get('ETag'),'"sha256-'+hash(audio)+'"');
  await bytes(range,audio.subarray(2,6),206);
  const head = await get(recording,'a','HEAD',{Range:'bytes=-3'});
  assert.equal(head.status,206);
  assert.equal(head.headers.get('Content-Length'),'3');
  assert.equal((await get(recording,'a','GET',{Range:'bytes=999-'})).status,416);
  assert.equal((await get(recording)).status,401);
  assert.equal((await get(recording,'b')).status,401);
  assert.equal((await get('/b/audio/audio','b')).status,404);

  await bucket.put('test-deck',Buffer.alloc(deck.length),{sha256:hash(Buffer.alloc(deck.length))});
  await bytes(await get(media,'a'),deck,200);
  await bytes(await get('/fixture/inspect'),deck.subarray(2,9),200);
  await bucket.delete('test-audio');
  assert.equal((await get(recording,'a')).status,503);
  assert.equal((await get('/test-deck','a')).status,401);
  console.log('PASS R2/D1 read compatibility: project authorization, SHA-256, range/HEAD, dual fallback and R2-only failure');
} finally {
  await mf.dispose();
}
