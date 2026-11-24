import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[dirname(require.resolve('wrangler/package.json'))]})),dir=mkdtempSync(tmpdir()+'/studio-create-');
try{
 const compiled=await build({stdin:{contents:"export * from './lib/creation-client';export {ApiError} from './lib/client';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
 writeFileSync(dir+'/bundle.mjs',compiled.outputFiles[0].text);
 const {CreationAttempt,ApiError,requireCreationCrypto}=await import(pathToFileURL(dir+'/bundle.mjs').href);
 const input={title:'甲组',seconds:900,code:'0001',admin_password:'Fixture#Admin800',visibility:'public'};
 let calls=[],nextId=0,responseLost=true,rejectStatus=0;
 const attempt=new CreationAttempt({requestId:()=>String(++nextId),solve:async()=> '123',request:async(path,body)=>{
  calls.push({path,body:structuredClone(body)});
  if(path.endsWith('/challenge'))return {nonce:'challenge-'+nextId};
  if(rejectStatus){const status=rejectStatus;rejectStatus=0;throw new ApiError(status,'创建被拒绝')}
  if(responseLost){responseLost=false;throw new TypeError('response lost')}
  return {project_id:'project-'+body.request_id,role:'owner'};
 }});
 await assert.rejects(attempt.submit(input,()=>{}),/response lost/);
 const first=calls.at(-1).body;
 await assert.rejects(attempt.submit({...input,title:'乙组'},()=>{}),/上一次创建结果尚未确认/);
 await assert.rejects(attempt.submit({...input,admin_password:'Changed#Admin800'},()=>{}),/上一次创建结果尚未确认/);
 await assert.rejects(attempt.submit({...input,visibility:'unlisted'},()=>{}),/上一次创建结果尚未确认/);
 assert.equal(calls.length,2,'changed input must not send a second creation');
 const recovered=await attempt.submit(input,()=>{});
 assert.equal(recovered.project_id,'project-1');
 assert.deepEqual(calls.at(-1).body,first,'lost-response retry must keep exact body and request ID');
 const second=await attempt.submit({...input,title:'乙组'},()=>{});
 assert.equal(second.project_id,'project-2','confirmed success must release the first request');
 assert.equal(calls.filter(c=>c.path.endsWith('/challenge')).length,2);
 for(const status of [400,403]){
  rejectStatus=status;
  await assert.rejects(attempt.submit(input,()=>{}),ApiError);
  const rejectedId=calls.at(-1).body.request_id;
  await attempt.submit({...input,title:'修正后的汇报'},()=>{});
  assert.notEqual(calls.at(-1).body.request_id,rejectedId,'rejected/expired attempt must allow new verification');
 }
 let simultaneousCalls=0;
 const simultaneous=new CreationAttempt({requestId:()=> 'simultaneous',solve:async()=> '123',request:async(path)=>{simultaneousCalls++;return path.endsWith('/challenge')?{nonce:'same'}:{project_id:'only-one'}}});
 const [one,two]=await Promise.all([simultaneous.submit(input,()=>{}),simultaneous.submit(input,()=>{})]);
 assert.deepEqual(one,two);assert.equal(simultaneousCalls,2,'double submission shares one challenge and creation');
 const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 try{Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true});assert.throws(requireCreationCrypto,/HTTPS 安全连接/)}finally{if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);else delete globalThis.crypto}
 console.log('PASS creation lifecycle: response-loss retry, changed-input refusal, new project per confirmed result, expired/invalid retry renewal, leading zeros and HTTPS guidance.');
}finally{rmSync(dir,{recursive:true,force:true})}
