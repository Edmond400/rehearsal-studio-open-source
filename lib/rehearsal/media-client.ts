'use client';
import {apiFetch} from '../transport';
import {rehearsalHeaders} from './session';
import {MEDIA_PART_BYTES,MEDIA_RANGE_BYTES,MAX_R2_DECK_BYTES,R2_PART_BYTES} from './media-transfer';

export async function mediaDigest(bytes:BufferSource) {
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
 return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}

type UploadProgress={id:string;next:number;partBytes:number;session?:string|null};
type UploadInput={kind:'pptx';hash:string}|{kind:'audio';hash:string;id:string;mime:string};
type PreviewInput={kind:'slide';hash:string;sourceId:string;mime:string};

export async function r2MediaCapability() {
 const response=await apiFetch('/api/rehearsal/r2-uploads',{headers:rehearsalHeaders()});
 if(!response.ok)return null;
 const {maxDeckBytes}=await responseJson<{maxDeckBytes:number}>(response);
 return Number.isSafeInteger(maxDeckBytes)&&maxDeckBytes>=20*1024*1024&&maxDeckBytes<=MAX_R2_DECK_BYTES?maxDeckBytes:null;
}

async function responseJson<T>(response:Response):Promise<T> {
 if(!response.ok){
  const body=await response.json().catch(()=>null) as {error?:string}|null;
  throw new Error(body?.error??'上传未完成。请保留文件后重试。');
 }
 try{
  const body=await response.json() as T;
  if(body===null||typeof body!=='object')throw new Error('上传响应格式无效，请保留文件后重试。');
  return body;
 }catch(error){
  // A dropped body stream can reject with TypeError after HTTP 200 headers
  // have arrived. Preserve it so the idempotent request can be retried.
  if(error instanceof TypeError)throw error;
  throw new Error('上传响应格式无效，请保留文件后重试。');
 }
}

export async function uploadMedia<T>(blob:Blob,input:UploadInput,recording?:unknown,signal?:AbortSignal,onProgress?:(bytes:number)=>void) {
 return await transferMedia<T>('/api/rehearsal/r2-uploads',R2_PART_BYTES,blob,input,recording,signal,onProgress)
  ?? await transferMedia<T>('/api/rehearsal/uploads',MEDIA_PART_BYTES,blob,input,recording,signal,onProgress);
}
export function uploadR2Preview<T>(blob:Blob,input:PreviewInput,signal:AbortSignal,enabled:boolean) {
 return enabled?transferMedia<T>('/api/rehearsal/r2-uploads',R2_PART_BYTES,blob,input,undefined,signal):Promise.resolve(null);
}
async function transferMedia<T>(base:string,expectedPartBytes:number,blob:Blob,input:UploadInput|PreviewInput,
 recording?:unknown,signal?:AbortSignal,onProgress?:(bytes:number)=>void) {
 const headers=rehearsalHeaders();
 // Prevent indefinitely pending uploads on mobile networks. A timed-out
 // request may have committed remotely, so retry only through idempotent APIs.
 const withDeadline=async <T>(send:(requestSignal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;cancel();},60000);
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  try{return await send(controller.signal);}
  catch(error){
   if(timedOut&&!signal?.aborted)throw new TypeError('上传请求超时');
   throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 };
 const onceMoreOnNetworkLoss=async <T>(send:(requestSignal:AbortSignal)=>Promise<T>):Promise<T>=>{
  try{return await withDeadline(send);}
  catch(error){
   // Only network failures or our internal deadline trigger a single retry.
   // Server-side validation failures and user cancellation never retry.
   if(signal?.aborted||!(error instanceof TypeError))throw error;
   return withDeadline(send);
  }
 };
 const post=(path:string,body:unknown,requestSignal:AbortSignal,session?:string|null)=>apiFetch(path,{
  method:'POST',headers:{...headers,'Content-Type':'application/json',...(session?{'X-Rehearsal-Metadata':session}:{})},body:JSON.stringify(body),signal:requestSignal
 });
 const started=await onceMoreOnNetworkLoss(async requestSignal=>{
  const response=await post(base,{...input,bytes:blob.size},requestSignal);
  // Rollback builds still handle the previous, whole-file protocol.
  if(response.status===404||response.status===405){
   if(input.kind==='pptx'&&blob.size>20*1024*1024)throw new Error('当前只接收不超过 20 MiB 的 PPTX，文件已保留。');
   return null;
  }
  return responseJson<UploadProgress>(response);
 });
 if(started===null)return null;
 const {id,partBytes,session}=started;
 if(typeof id!=='string'||!id||partBytes!==expectedPartBytes)throw new Error('上传协议与服务器不兼容。');
 const total=Math.ceil(blob.size/partBytes);
 let next=started.next;
 if(!Number.isSafeInteger(next)||next<0||next>total)throw new Error('上传进度不完整，请重试。');
 onProgress?.(Math.min(blob.size,next*partBytes));
 while(next<total){
  const part=blob.slice(next*partBytes,Math.min(blob.size,(next+1)*partBytes));
  const saved=await onceMoreOnNetworkLoss(async requestSignal=>responseJson<UploadProgress>(await apiFetch(base+'/'+encodeURIComponent(id)+'/'+next,{
   method:'POST',headers:{...headers,'Content-Type':'application/octet-stream',...(session?{'X-Rehearsal-Metadata':session}:{})},body:part,signal:requestSignal
  })));
  if(saved.id!==id||!Number.isSafeInteger(saved.next)||saved.next<=next||saved.next>total){
   throw new Error('上传进度已变化，请重新尝试。');
  }
  next=saved.next;
  onProgress?.(Math.min(blob.size,next*partBytes));
 }
 return onceMoreOnNetworkLoss(async requestSignal=>responseJson<T>(await post(base+'/'+encodeURIComponent(id)+'/finish',
  input.kind==='audio'?{kind:'audio',mime:input.mime,recording}:{kind:input.kind},requestSignal,session)));
}

async function rangeResponse(path:string,headers:Headers,signal:AbortSignal|undefined,start:number,end:number,size:number) {
 const controller=new AbortController();
 const abort=()=>controller.abort();
 let timedOut=false;
 // Small media without Range is still subject to the same network deadline.
 const timer=setTimeout(()=>{timedOut=true;abort();},20000);
 signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted)abort();
 try{
  const response=await apiFetch(path,{headers,signal:controller.signal});
  if(!response.ok){
   if(response.status===401||response.status===403)throw new Error('会话已失效，请重新验证汇报密码。');
   if(response.status===404)throw new Error('文件已不存在，请刷新后重试。');
   throw new Error('文件读取失败（'+response.status+'）');
  }
  const range=headers.has('Range')&&response.status===206;
  const expected=range?end-start+1:size;
  if(Number(response.headers.get('Content-Length'))>expected){
   await response.body?.cancel();
   throw new Error('文件长度与预期不符。');
  }
  return {response,bytes:new Uint8Array(await response.arrayBuffer())};
 }catch(error){
  // A timed-out range is a recoverable transport failure, unlike a caller
  // cancellation. Let downloadMedia retry only this range once.
  if(timedOut&&!signal?.aborted)throw new TypeError('文件分段读取超时');
  throw error;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export async function downloadMedia(path:string,size:number,signal?:AbortSignal,knownHash?:string) {
 if(!Number.isSafeInteger(size)||size<1||size>MAX_R2_DECK_BYTES)throw new Error('文件长度无效。');
 const headers=new Headers(rehearsalHeaders()),out=new Uint8Array(size);
 const segmented=size>MEDIA_RANGE_BYTES;
 let etag:string|null|undefined;
 for(let start=0;start<size;start+=MEDIA_RANGE_BYTES){
  if(signal?.aborted)throw new DOMException('已取消','AbortError');
  const end=Math.min(size-1,start+MEDIA_RANGE_BYTES-1);
  if(segmented)headers.set('Range',`bytes=${start}-${end}`);
  let result;
  try{result=await rangeResponse(path,headers,signal,start,end,size);}
  catch(error){
   // Both 256 KiB ranges and small whole-file GETs are idempotent.
   // Retry only transport failure or our own deadline, not user cancellation.
   if(signal?.aborted||!(error instanceof TypeError))throw error;
   result=await rangeResponse(path,headers,signal,start,end,size);
  }
  const {response,bytes}=result;
  const tag=response.headers.get('ETag');
  // Some consumers (notably PPTX export) know the expected size but not the
  // SHA-256. Never silently accept unchecked bytes if a proxy drops the ETag.
  if(!knownHash&&!/^"sha256-[a-f0-9]{64}"$/.test(tag??'')){
   throw new Error('文件缺少可靠的 SHA-256 校验信息，请重新下载。');
  }
  if(etag===undefined)etag=tag;
  else if(etag!==tag)throw new Error('读取期间文件版本已变化，请重试。');
  if(response.status===200&&start===0&&bytes.length===size){out.set(bytes);break;}
  if(response.status!==206||response.headers.get('Content-Range')!==`bytes ${start}-${end}/${size}`||
    bytes.length!==end-start+1)throw new Error('文件没有读取完整，请重新加载。');
  out.set(bytes,start);
 }
 const transportHash=/^"sha256-([a-f0-9]{64})"$/.exec(etag??'')?.[1];
 const expected=knownHash||transportHash;
 if(knownHash&&transportHash&&knownHash!==transportHash||expected&&await mediaDigest(out)!==expected){
  throw new Error('文件 SHA-256 校验失败，请重新加载。');
 }
 return out;
}
