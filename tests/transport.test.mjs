import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[dirname(require.resolve('wrangler/package.json'))]})),dir=mkdtempSync(tmpdir()+'/studio-transport-'),original=globalThis.fetch;
try{const result=await build({stdin:{contents:"export * from './lib/transport';export * from './lib/rehearsal/session';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});writeFileSync(dir+'/bundle.mjs',result.outputFiles[0].text);const t=await import(pathToFileURL(dir+'/bundle.mjs').href);let called;globalThis.fetch=async(url,options)=>{called={url,options};return new Response('{}')};
 assert.equal(t.apiUrl('/api/projects'),'/api/projects');assert.throws(()=>t.configureTransport({apiOrigin:'http://unsafe.test',native:true}));t.configureTransport({apiOrigin:'https://api.test',native:true});t.acceptAnonymous('a'.repeat(64));await t.apiFetch('/api/projects/challenge',{method:'POST'});assert.equal(called.url,'https://api.test/api/projects/challenge');assert.equal(called.options.credentials,'omit');assert.equal(called.options.headers.get('X-Studio-Transport'),'bearer');assert.equal(called.options.headers.get('X-Studio-Anonymous'),'a'.repeat(64));assert.equal(t.projectLink('project-a'),'https://api.test/p/project-a');
 t.selectRehearsal('a','b'.repeat(64));t.selectRehearsal('a');assert.equal(t.rehearsalHeaders()['X-Studio-Session'],'b'.repeat(64));t.selectRehearsal('b');assert(!t.rehearsalHeaders()['X-Studio-Session']);t.clearTransport();assert(!t.transportHeaders()['X-Studio-Anonymous']);
 console.log('PASS Web/native transport: explicit HTTPS API, credential-free native fetch, memory-only bearer state, project switch clears credentials, native invite uses backend URL.');
}finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true})}
