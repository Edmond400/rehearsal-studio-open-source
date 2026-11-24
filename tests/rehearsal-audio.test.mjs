import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[dirname(require.resolve('wrangler/package.json'))]})),dir=mkdtempSync(resolve(tmpdir(),'rehearsal-audio-')),originalFetch=globalThis.fetch;
try{
 await build({stdin:{contents:`export * from './lib/rehearsal/audio-cache';export * from './lib/rehearsal/media-client';export * from './lib/rehearsal/session';export * from './lib/rehearsal/audio-media';export * from './lib/rehearsal/webm-duration';export * from './lib/rehearsal/media-priority';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:resolve(dir,'audio.mjs')});
 const a=await import(pathToFileURL(resolve(dir,'audio.mjs')).href);
 const bytes=Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x80,0x18,0x53,0x80,0x67,0x01,255,255,255,255,255,255,255,0x15,0x49,0xa9,0x66,0x87,0x2a,0xd7,0xb1,0x83,0x0f,0x42,0x40,0x1f,0x43,0xb6,0x75,0x01,255,255,255,255,255,255,255]);
 const original=new Uint8Array(bytes),patched=a.withWebmDuration(bytes,12345);assert.deepEqual(bytes,original);assert.equal(patched.length,bytes.length+11);assert.equal(patched[21],0x92);assert.equal(new DataView(patched.buffer).getFloat64(32),12345);assert.equal(a.withWebmDuration(patched,9999),patched);assert.deepEqual(a.withWebmDuration(new Uint8Array([1,2]),123),new Uint8Array([1,2]));
 const indexed=new Uint8Array([...bytes.slice(0,17),0x11,0x4d,0x9b,0x74,0x80,...bytes.slice(17)]);assert.equal(a.withWebmDuration(indexed,123),indexed);
 const lateIndex=new Uint8Array([...bytes.slice(0,29),0x11,0x4d,0x9b,0x74,0x80,...bytes.slice(29)]);assert.equal(a.withWebmDuration(lateIndex,123),lateIndex);
 const requests=[];let failure=false,slow=false,active=0,maxActive=0,aborts=0;
 globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{
  requests.push({url,options});active++;maxActive=Math.max(maxActive,active);let finished=false;
  const finish=()=>{if(finished)return false;finished=true;active--;clearTimeout(timer);options.signal.removeEventListener('abort',abort);return true};
  const abort=()=>{if(finish()){aborts++;reject(new DOMException('cancelled','AbortError'))}};
  const timer=setTimeout(()=>{if(finish())resolve(new Response(failure?'failed':bytes,{status:failure?503:200,headers:{'Content-Type':'audio/webm'}}))},slow?100:1);
  options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
 });
 const rec=id=>({id,hash:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime:'audio/webm',durationMs:12345});
 const [one,two]=await Promise.all([a.readAudioBlob(rec('same')),a.readAudioBlob(rec('same'))]);assert.equal(one,two);assert.equal(requests.length,1);await a.readAudioBlob(rec('same'));assert.equal(requests.length,1);await a.readAudioBlob(rec('same'),true);assert.equal(requests.length,2);assert(requests[1].url.startsWith('/api/rehearsal/edit/'));
 failure=true;await assert.rejects(a.readAudioBlob(rec('failed')),/503/);failure=false;await a.readAudioBlob(rec('failed'));assert.equal(requests.filter(r=>r.url.endsWith('/failed')).length,2);
 slow=true;const controller=new AbortController(),cancelled=a.readAudioBlob(rec('cancelled'),false,controller.signal);controller.abort();await assert.rejects(cancelled,{name:'AbortError'});await a.readAudioBlob(rec('cancelled'));assert.equal(requests.filter(r=>r.url.endsWith('/cancelled')).length,2);
 a.prefetchAudio([rec('background-a'),rec('background-b')]);await new Promise(r=>setTimeout(r,5));await a.readAudioBlob(rec('foreground'));assert(aborts>=3);assert(maxActive<=2);
 slow=false;for(let i=0;i<7;i++)await a.readAudioBlob(rec('lru-'+i));await a.readAudioBlob(rec('same'));assert.equal(requests.filter(r=>r.url==='/api/rehearsal/audio/same').length,2);
 a.selectRehearsal('project-a','a'.repeat(64));await a.readAudioBlob(rec('scoped'));a.selectRehearsal('project-b','b'.repeat(64));await a.readAudioBlob(rec('scoped'));assert.equal(requests.filter(r=>r.url.endsWith('/scoped')).length,2);assert.deepEqual(requests.filter(r=>r.url.endsWith('/scoped')).map(r=>new Headers(r.options.headers).get('X-Studio-Project')),['project-a','project-b']);a.leaveRehearsal();
 const bad={...rec('truncated'),bytes:10000};await assert.rejects(a.readAudioBlob(bad),/没有读取完整/);
 class Media extends EventTarget{
  readyState=0;error=null;seeking=false;src='';time=0;loads=0;seeks=0;
  get currentTime(){return this.time}set currentTime(n){this.seeks++;this.time=n}
  getAttribute(){return this.src}
  load(){this.loads++;queueMicrotask(()=>{this.readyState=2;this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('loadeddata'))})}
  play(){return Promise.resolve()}
 }
 const media=new Media(),signal=new AbortController();await a.prepareAudio(media,'blob:test',0,signal.signal);assert.equal(media.seeks,0);await a.prepareAudio(media,'blob:test',5,signal.signal);assert.equal(media.loads,1);assert.equal(media.currentTime,5);
 const waiting=new Media();waiting.load=()=>{};const abort=new AbortController(),pending=a.prepareAudio(waiting,'blob:pending',0,abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});
 await a.playAudio(media,signal.signal);media.play=()=>Promise.reject(new DOMException('blocked','NotAllowedError'));await assert.rejects(a.playAudio(media,signal.signal),{name:'NotAllowedError'});assert(a.playbackError(new DOMException('blocked','NotAllowedError')).includes('无需等待权限弹窗'));assert(!a.playbackError(new Error('音频读取超时')).includes('浏览器阻止'));
 const originalTimer=globalThis.setTimeout;let trigger;
 globalThis.setTimeout=(fn,ms,...args)=>{if(ms===20000)trigger=fn;return originalTimer(fn,ms,...args)};
 globalThis.fetch=(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')),{once:true}));
 try{const timeout=a.readAudioBlob(rec('timeout'));assert(trigger);trigger();await assert.rejects(timeout,/音频读取超时/)}finally{globalThis.setTimeout=originalTimer}
 const large=new Uint8Array(512*1024+11).fill(81),largeHash=createHash('sha256').update(large).digest('hex');
 const requested=[];let disconnected=false,corrupt=false,replaceTag=false;
 globalThis.fetch=async(_url,options)=>{
  const [start,end]=new Headers(options.headers).get('Range').slice(6).split('-').map(Number);
  requested.push(start);
  if(start===256*1024&&!disconnected){disconnected=true;throw new TypeError('Connection lost');}
  const payload=large.slice(start,end+1);
  if(corrupt&&start===256*1024)payload[0]^=1;
  return new Response(payload,{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${large.length}`,
   'ETag':'"sha256-'+(replaceTag&&start? 'a'.repeat(64):largeHash)+'"'}});
 };
 assert.deepEqual(await a.downloadMedia('/api/media',large.length,undefined,largeHash),large);
 assert.deepEqual(requested,[0,256*1024,256*1024,512*1024]);
 corrupt=true;await assert.rejects(a.downloadMedia('/api/media',large.length),/SHA-256/);
 corrupt=false;replaceTag=true;await assert.rejects(a.downloadMedia('/api/media',large.length),/版本已变化/);
 // An internal Range timeout must retry only that range, preserving the already
 // downloaded data. A caller cancellation must never be silently retried.
 replaceTag=false;
 const nativeSetTimeout=globalThis.setTimeout;
 let rangeDeadline,expired=false;
 const timeoutRequests=[];
 globalThis.setTimeout=(fn,ms,...args)=>{
  if(ms===20000)rangeDeadline=fn;
  return nativeSetTimeout(fn,ms,...args);
 };
 globalThis.fetch=async(_url,options)=>{
  const [start,end]=new Headers(options.headers).get('Range').slice(6).split('-').map(Number);
  timeoutRequests.push(start);
  if(start===256*1024&&!expired){
   expired=true;
   queueMicrotask(()=>rangeDeadline());
   return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('timed out','AbortError')),{once:true}));
  }
  return new Response(large.slice(start,end+1),{status:206,headers:{
   'Content-Range':`bytes ${start}-${end}/${large.length}`,
   'ETag':'"sha256-'+largeHash+'"'
  }});
 };
 try {
  assert.deepEqual(await a.downloadMedia('/api/media',large.length,undefined,largeHash),large);
  assert.deepEqual(timeoutRequests,[0,256*1024,256*1024,512*1024]);
  const cancelledByCaller=new AbortController();
  const previousCount=timeoutRequests.length;
  cancelledByCaller.abort();
  await assert.rejects(a.downloadMedia('/api/media',large.length,cancelledByCaller.signal,largeHash),{name:'AbortError'});
  assert.equal(timeoutRequests.length,previousCount,'caller cancellation must not issue another range');
  // PPTX exports do not always have an expected hash in their project model:
  // accept the server's SHA-256 ETag, never unverified bytes. Recordings with
  // an independently known hash can still verify a response without an ETag.
  globalThis.fetch=async(_url,options)=>{
   const [start,end]=new Headers(options.headers).get('Range').slice(6).split('-').map(Number);
   return new Response(large.slice(start,end+1),{status:206,headers:{
    'Content-Range':`bytes ${start}-${end}/${large.length}`
   }});
  };
  await assert.rejects(a.downloadMedia('/api/media',large.length),/缺少可靠的 SHA-256/);
  assert.deepEqual(await a.downloadMedia('/api/media',large.length,undefined,largeHash),large);
  // Small, non-Range downloads need the same 20s deadline and one retry.
  const small=new Uint8Array(131).fill(46),smallHash=createHash('sha256').update(small).digest('hex');
  let shortCalls=0,smallDeadline;
  globalThis.setTimeout=(fn,ms,...args)=>{
   if(ms===20000)smallDeadline=fn;
   return nativeSetTimeout(fn,ms,...args);
  };
  globalThis.fetch=async(_url,options)=>{
   shortCalls++;
   if(shortCalls===1){
    queueMicrotask(()=>smallDeadline());
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('stalled','AbortError')),{once:true}));
   }
   return new Response(small,{status:200,headers:{'Content-Length':String(small.length),'ETag':'"sha256-'+smallHash+'"'}});
  };
  assert.deepEqual(await a.downloadMedia('/api/media',small.length,undefined,smallHash),small);
  assert.equal(shortCalls,2,'short media timeout must retry once');
  const cancelSmall=new AbortController();let cancelledCalls=0;
  globalThis.fetch=async(_url,options)=>{
   cancelledCalls++;queueMicrotask(()=>cancelSmall.abort());
   return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));
  };
  await assert.rejects(a.downloadMedia('/api/media',small.length,cancelSmall.signal,smallHash),{name:'AbortError'});
  assert.equal(cancelledCalls,1,'user-cancelled short media must not retry');
 }finally{globalThis.setTimeout=nativeSetTimeout;}
 const r2Endpoint='/api/rehearsal/r2-uploads';
 const uploadId='12345678-1234-4234-8234-123456789abc',uploadContent=new Uint8Array(256*1024+17).fill(21);
 const uploadPayload={kind:'audio',id:uploadId,mime:'audio/webm',hash:createHash('sha256').update(uploadContent).digest('hex')};
 const uploadProgress=[],uploadCalls={start:0,part0:0,part1:0,finish:0};
 let serverNext=0,serverCommitted=false;
 globalThis.fetch=async(url,_options)=>{
  const path=String(url);
  if(path.endsWith(r2Endpoint))return new Response(null,{status:404});
  if(path.endsWith('/api/rehearsal/uploads')){
   uploadCalls.start++;
   if(uploadCalls.start===1)throw new TypeError('start response dropped');
   return Response.json({id:uploadId,next:serverNext,partBytes:256*1024});
  }
  if(path.endsWith('/'+uploadId+'/0')){
   uploadCalls.part0++;serverNext=1;
   if(uploadCalls.part0===1)throw new TypeError('part response dropped after commit');
   return Response.json({id:uploadId,next:serverNext,partBytes:256*1024});
  }
  if(path.endsWith('/'+uploadId+'/1')){
   uploadCalls.part1++;serverNext=2;
   return Response.json({id:uploadId,next:serverNext,partBytes:256*1024});
  }
  if(path.endsWith('/'+uploadId+'/finish')){
   uploadCalls.finish++;serverCommitted=true;
   if(uploadCalls.finish===1)throw new TypeError('final response dropped after commit');
   return Response.json({ok:true,id:uploadId,retried:true});
  }
  throw new Error('Unexpected media endpoint: '+path);
 };
 const savedUpload=await a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId},undefined,n=>uploadProgress.push(n));
 assert.equal(savedUpload.id,uploadId);assert(serverCommitted);
 assert.deepEqual(uploadCalls,{start:2,part0:2,part1:1,finish:2});
 assert.deepEqual(uploadProgress,[0,256*1024,uploadContent.length]);
 const cancelUpload=new AbortController();let cancelledAttempts=0;
 globalThis.fetch=async()=>{cancelledAttempts++;cancelUpload.abort();throw new TypeError('upload cancelled');};
 await assert.rejects(a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId},cancelUpload.signal),/upload cancelled/);
 assert.equal(cancelledAttempts,1,'caller cancellation must not retry an upload');
 // The server may successfully process a request even when the HTTP 200 body
 // fails to stream. A second identical request must recover the result.
 const badBody=(value)=>{
  const response=Response.json(value);
  response.json=async()=>{throw new TypeError('response stream interrupted');};
  return response;
 };
 const bodyLossCalls={start:0,part0:0,part1:0,finish:0};
 let bodyLossNext=0;
 globalThis.fetch=async(url)=>{
  const path=String(url);
  if(path.endsWith(r2Endpoint))return new Response(null,{status:404});
  if(path.endsWith('/api/rehearsal/uploads')){
   bodyLossCalls.start++;
   const payload={id:uploadId,next:bodyLossNext,partBytes:256*1024};
   return bodyLossCalls.start===1?badBody(payload):Response.json(payload);
  }
  if(path.endsWith('/'+uploadId+'/0')){
   bodyLossCalls.part0++;bodyLossNext=1;
   const payload={id:uploadId,next:bodyLossNext,partBytes:256*1024};
   return bodyLossCalls.part0===1?badBody(payload):Response.json(payload);
  }
  if(path.endsWith('/'+uploadId+'/1')){
   bodyLossCalls.part1++;bodyLossNext=2;
   return Response.json({id:uploadId,next:bodyLossNext,partBytes:256*1024});
  }
  if(path.endsWith('/'+uploadId+'/finish')){
   bodyLossCalls.finish++;
   const payload={ok:true,id:uploadId,retried:true};
   return bodyLossCalls.finish===1?badBody(payload):Response.json(payload);
  }
  throw new Error('Unexpected media endpoint: '+path);
 };
 const bodyLossResult=await a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId});
 assert.equal(bodyLossResult.id,uploadId);
 assert.deepEqual(bodyLossCalls,{start:2,part0:2,part1:1,finish:2});
 // A well-formed HTTP 4xx must never be retried as a dropped response.
 let rejectedRequests=0;
 globalThis.fetch=async()=>{rejectedRequests++;return Response.json({error:'stored hash mismatch'},{status:409});};
 await assert.rejects(a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId}),/stored hash mismatch/);
 assert.equal(rejectedRequests,1);
 // A mobile connection can hang indefinitely without rejecting fetch.
 // Simulate the internal 60-second deadline immediately, and confirm only
 // the affected chunk is replayed with a fresh AbortSignal.
 const originalUploadTimer=globalThis.setTimeout;
 let uploadDeadline;
 const timedCalls={start:0,part0:0,part1:0,finish:0};
 globalThis.setTimeout=(fn,ms,...args)=>{
  if(ms===60000)uploadDeadline=fn;
  return originalUploadTimer(fn,ms,...args);
 };
 globalThis.fetch=async(url,options)=>{
  const route=String(url);
  if(route.endsWith(r2Endpoint))return new Response(null,{status:404});
  if(route.endsWith('/api/rehearsal/uploads')){
   timedCalls.start++;return Response.json({id:uploadId,next:0,partBytes:256*1024});
  }
  if(route.endsWith('/'+uploadId+'/0')){
   timedCalls.part0++;
   if(timedCalls.part0===1){
    queueMicrotask(()=>uploadDeadline());
    return new Promise((_resolve,reject)=>{
     options.signal.addEventListener('abort',()=>reject(new DOMException('stalled request','AbortError')),{once:true});
    });
   }
   return Response.json({id:uploadId,next:1,partBytes:256*1024});
  }
  if(route.endsWith('/'+uploadId+'/1')){
   timedCalls.part1++;return Response.json({id:uploadId,next:2,partBytes:256*1024});
  }
  if(route.endsWith('/'+uploadId+'/finish')){
   timedCalls.finish++;return Response.json({ok:true,id:uploadId});
  }
  throw new Error('Unexpected timed upload route '+route);
 };
 try{
  const timed=await a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId});
  assert.equal(timed.id,uploadId);
  assert.deepEqual(timedCalls,{start:1,part0:2,part1:1,finish:1});
 }finally{globalThis.setTimeout=originalUploadTimer;}
 const r2Session='32145678-1234-4234-8234-123456789abc',r2Calls=[];
 globalThis.fetch=async(url,options)=>{
  const path=String(url);
  r2Calls.push(path);
  if(path===r2Endpoint)return Response.json({id:uploadId,next:0,partBytes:5*1024*1024,session:r2Session});
  assert.equal(new Headers(options.headers).get('X-Rehearsal-Metadata'),r2Session);
  if(path===r2Endpoint+'/'+uploadId+'/0'){
   assert.equal(options.body.size,uploadContent.length);
   return Response.json({id:uploadId,next:1,partBytes:5*1024*1024,session:r2Session});
  }
  if(path===r2Endpoint+'/'+uploadId+'/finish')return Response.json({id:uploadId});
  assert.fail('R2 upload must keep using its selected protocol: '+path);
 };
 assert.equal((await a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId})).id,uploadId);
 assert.equal(r2Calls.length,3);
 globalThis.fetch=async(url)=>{
  const path=String(url);
  if(path===r2Endpoint)return Response.json({id:uploadId,next:0,partBytes:5*1024*1024,session:r2Session});
  assert.equal(path,r2Endpoint+'/'+uploadId+'/0');
  return Response.json({error:'upload generation revoked'},{status:409});
 };
 await assert.rejects(a.uploadMedia(new Blob([uploadContent]),uploadPayload,{id:uploadId}),/upload generation revoked/);
 console.log('PASS R2 audio client: generation metadata, disabled-mode fallback and no fallback after a partial upload');
 console.log('PASS media upload: 60s internal timeout retries only the affected chunk once');
 console.log('PASS media upload client: dropped HTTP 200 response body retried, HTTP 409 never retried');
 console.log('PASS media upload client: lost begin/part/finish response replays once; user cancellation stops retries');
 console.log('PASS media Range client: retry only the interrupted range, final SHA-256 rejection and changed ETag rejection');
 const owner=Symbol();a.setPlaybackBusy(owner,true);let idle=false;const pause=a.waitForPlaybackIdle().then(()=>{idle=true});await Promise.resolve();assert.equal(idle,false);a.setPlaybackBusy(owner,false);await pause;assert.equal(idle,true);
 console.log('PASS audio: duration repair without source mutation/index damage; shared cache, project/token and protected/public separation, cancellation/retry, foreground priority, 2-request concurrency and bounded LRU, truncated response rejection, local media preparation, cancellation, truthful timeout errors and PDF scheduling');
}finally{globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true})}
