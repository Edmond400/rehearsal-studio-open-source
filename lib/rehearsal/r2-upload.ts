import { env } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { database } from '../data';
import { HttpError, readBytes } from '../http';
import { guard, sessionGuard } from '../security';
import { deckMime, MAX_DECK_BYTES, originalId, previewId, sourceIdSchema } from './deck-storage';
import { MAX_AUDIO_BYTES, MAX_PAGE_BYTES } from './model';
import { detectMime, getFile, sha256, type FileMetadata } from './storage';
import { MAX_R2_DECK_BYTES, R2_PART_BYTES } from './media-transfer';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const asset = { hash, bytes: z.number().int().positive() };
const audioMime = z.enum(['audio/webm','audio/mp4','audio/ogg']);
const slideMime = z.enum(['image/png','image/jpeg','image/webp']);
export const r2UploadSchema = z.discriminatedUnion('kind', [
 z.object({ ...asset, kind:z.literal('pptx'), bytes:asset.bytes.max(MAX_R2_DECK_BYTES) }).strict(),
 z.object({ ...asset, kind:z.literal('slide'), bytes:asset.bytes.max(MAX_PAGE_BYTES), sourceId:sourceIdSchema, mime:slideMime }).strict(),
 z.object({ ...asset, kind:z.literal('audio'), bytes:asset.bytes.max(MAX_AUDIO_BYTES), id:z.string().uuid(), mime:audioMime }).strict(),
]);
export const r2Id = z.string().regex(/^(?:[a-f0-9-]{36}|(?:deck|preview)-[a-f0-9]{64})$/);
type UploadInput = z.infer<typeof r2UploadSchema>;
type Upload = FileMetadata & {
 object_key:string; upload_id:string|null; lease:string|null; lease_until:number; expires_at:number;
 status:'open'|'cancelled'|'committing'; source_id:string|null;
};
type Part = {part:number; hash:string; etag:string|null};

const reservationMs = 72 * 3600_000;
const leaseMs = 120_000;

export async function r2WritePolicy(projectId:string) {
 if (env.STUDIO_R2_WRITES !== 'on') return null;
 const policy=await database().prepare('SELECT max_deck_bytes FROM studio_r2_effective_policy WHERE project_id=?')
  .bind(projectId).first<{max_deck_bytes:number}>();
 if(policy&&(env.STUDIO_R2_READS!=='on'||!env.STUDIO_MEDIA))throw new HttpError(503,'媒体上传暂不可用。');
 return policy;
}

const progress = (file:FileMetadata,next:number,session:string|null=null) => ({id:file.id,next,partBytes:R2_PART_BYTES,session});
const sessionFor = (upload:Upload) => upload.object_key.split('/').at(-1)!;
const requestedSession = (request:Request) => z.string().uuid().parse(request.headers.get('X-Rehearsal-Metadata'));
const numParts = (file:FileMetadata) => Math.ceil(file.bytes/R2_PART_BYTES);
const lookup = (projectId:string,id:string) => database().prepare(
 'SELECT * FROM studio_r2_uploads WHERE id=? AND project_id=?').bind(id,projectId).first<Upload>();
function parts(upload:Upload) {
 return database().prepare('SELECT part,hash,etag FROM studio_r2_upload_parts WHERE file_id=? ORDER BY part')
  .bind(upload.id).all<Part>().then(result=>result.results);
}
function firstMissing(upload:Upload, completed:Part[]) {
 let next=0;
 while (next<numParts(upload) && completed[next]?.part===next && completed[next].etag) next++;
 return next;
}
function assertIdentity(file:FileMetadata, expected:FileMetadata) {
 if (file.bytes!==expected.bytes || file.hash!==expected.hash || file.kind!==expected.kind || file.mime!==expected.mime)
  throw new HttpError(409,'上传标识已关联其他文件。');
}

export async function startR2Upload(request:Request,projectId:string,input:UploadInput,maxDeckBytes:number) {
 if(input.kind==='pptx'&&input.bytes>maxDeckBytes)throw new HttpError(413,'PPTX 超过当前上传上限。');
 const id=input.kind==='pptx'?originalId(projectId,input.hash):input.kind==='slide'?
  previewId(projectId,input.sourceId,input.hash):input.id;
 const file={id,project_id:projectId,kind:input.kind,mime:input.kind==='pptx'?deckMime:input.mime,bytes:input.bytes,hash:input.hash};
 const existing=await getFile(id,input.kind,projectId);
 if(existing){assertIdentity(existing,file);return progress(file,numParts(file));}
 let stage=await lookup(projectId,id);
 if(stage)assertIdentity(stage,file);
 const now=Date.now();
 if(!stage||(stage.status==='cancelled'||stage.expires_at<=now)&&stage.lease_until<=now) {
  const db=database();
  try {
   if(stage)await db.batch([sessionGuard(request,projectId),
    db.prepare(`INSERT INTO studio_r2_upload_quarantine
     SELECT object_key,project_id,upload_id,bytes,? FROM studio_r2_uploads
     WHERE id=? AND project_id=? AND object_key=? AND lease_until<=? AND (status='cancelled' OR expires_at<=?)`)
     .bind(now,id,projectId,stage.object_key,now,now),
    db.prepare('DELETE FROM studio_r2_uploads WHERE id=? AND object_key=? AND object_key IN (SELECT object_key FROM studio_r2_upload_quarantine)')
     .bind(id,stage.object_key)]);
   await db.batch([sessionGuard(request,projectId),
    db.prepare(`INSERT INTO studio_r2_uploads(id,project_id,kind,mime,bytes,hash,object_key,expires_at,source_id)
     SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rehearsal_files WHERE id=?)`)
     .bind(id,projectId,file.kind,file.mime,file.bytes,file.hash,
     'studio/e3/'+projectId+'/'+crypto.randomUUID(),now+reservationMs,input.kind==='slide'?input.sourceId:null,id)]);
  } catch(error) {
   stage=await lookup(projectId,id);
   if(!stage) {
    if(error instanceof Error&&error.message.includes('studio_quota_exceeded'))throw new HttpError(409,'存储容量不足或 R2 上传已暂停。');
    const committed=await getFile(id,input.kind,projectId);
    if(committed){assertIdentity(committed,file);return progress(file,numParts(file));}
    throw error;
   }
  }
  stage=await lookup(projectId,id);
  if(!stage){
   const committed=await getFile(id,input.kind,projectId);
   if(committed){assertIdentity(committed,file);return progress(file,numParts(file));}
  }
 }
 if(!stage)throw new HttpError(409,'上传状态已变化，请重试。');
 assertIdentity(stage,file);
 if(stage.status!=='open'||stage.expires_at<=Date.now())throw new HttpError(409,'原上传已取消或过期，等待清理后可重新上传。');
 return progress(stage,firstMissing(stage,await parts(stage)),sessionFor(stage));
}

async function withLease<T>(request:Request,projectId:string,id:string,
 apply:(upload:Upload,lease:string,bucket:R2Bucket)=>Promise<T>) {
 const db=database(), now=Date.now(), lease=crypto.randomUUID();
 const key='studio/e3/'+projectId+'/'+requestedSession(request);
 const [_, acquired]=await db.batch<Upload>([sessionGuard(request,projectId),
  db.prepare(`UPDATE studio_r2_uploads SET lease=?,lease_until=?
   WHERE id=? AND project_id=? AND object_key=? AND status='open' AND expires_at>? AND lease_until<=?
   AND EXISTS(SELECT 1 FROM studio_r2_effective_policy p WHERE p.project_id=studio_r2_uploads.project_id
   AND (studio_r2_uploads.kind<>'pptx' OR studio_r2_uploads.bytes<=p.max_deck_bytes)) RETURNING *`)
   .bind(lease,now+leaseMs,id,projectId,key,now,now)]);
 const upload=acquired.results[0];
 if(!upload)throw new HttpError(409,'上传已结束、过期或正在处理，请稍后重试。');
 try {
  return await apply(upload,lease,env.STUDIO_MEDIA!);
 } finally {
  try {
   await db.prepare('UPDATE studio_r2_uploads SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(id,lease).run();
  } catch { console.warn('studio-r2-release-lease-failed'); }
 }
}

export async function cancelR2Upload(request:Request,projectId:string,id:string) {
 const stage=await lookup(projectId,id);
 if(stage?.status==='cancelled'&&sessionFor(stage)===requestedSession(request))return {ok:true};
 return withLease(request,projectId,id,async(upload,lease)=>{
  // Tombstone first. An interrupted abort, or a previously completed object,
  // remains accounted for and unavailable through all content endpoints.
  await database().prepare("UPDATE studio_r2_uploads SET status='cancelled' WHERE id=? AND lease=?")
   .bind(upload.id,lease).run();
  return {ok:true};
 });
}

export async function putR2Part(request:Request,projectId:string,id:string,index:number) {
 return withLease(request,projectId,id,async(upload,lease,bucket)=>{
  if(index>=numParts(upload))throw new HttpError(400,'分段号超出范围。');
  const size=Math.min(R2_PART_BYTES,upload.bytes-index*R2_PART_BYTES);
  const bytes=await readBytes(request,size);
  if(bytes.length!==size)throw new HttpError(400,'分段长度不符。');
  const sum=await sha256(bytes), db=database();
  const completed=await parts(upload), next=firstMissing(upload,completed);
  if(index>next)throw new HttpError(409,'请从下一待上传分段继续。');
  const prior=completed.find(part=>part.part===index);
  if(prior&&prior.hash!==sum)throw new HttpError(409,'该分段已绑定其他内容。');
  if(index<next)return progress(upload,next,sessionFor(upload));
  const fenced=()=>guard(`EXISTS(SELECT 1 FROM studio_r2_uploads u JOIN studio_r2_effective_policy p ON p.project_id=u.project_id
   WHERE u.id=? AND u.lease=? AND u.lease_until>? AND u.expires_at>? AND u.status='open'
   AND (u.kind<>'pptx' OR u.bytes<=p.max_deck_bytes))`,id,lease,Date.now(),Date.now());
  await db.batch([fenced(),db.prepare('INSERT OR IGNORE INTO studio_r2_upload_parts VALUES(?,?,?,NULL)').bind(id,index,sum)]);
  let etag:string;
  if(numParts(upload)===1) {
   const result=await bucket.put(upload.object_key,bytes,{sha256:sum,onlyIf:{etagDoesNotMatch:'*'}});
   const object=result??await bucket.head(upload.object_key);
   if(!object||object.size!==size||!object.checksums.sha256||Buffer.from(object.checksums.sha256).toString('hex')!==sum)
    throw new HttpError(409,'已有对象与分段摘要不一致。');
   etag=object.etag;
  } else {
   let uploadId=upload.upload_id;
   if(!uploadId) {
    const created=await bucket.createMultipartUpload(upload.object_key);
    try {
     await db.batch([fenced(),db.prepare('UPDATE studio_r2_uploads SET upload_id=? WHERE id=? AND lease=?')
      .bind(created.uploadId,id,lease)]);
    } catch(error) {
     await created.abort().catch(()=>{});
     throw error;
    }
    uploadId=created.uploadId;
   }
   ({etag}=await bucket.resumeMultipartUpload(upload.object_key,uploadId).uploadPart(index+1,bytes));
  }
  await db.batch([fenced(),db.prepare('UPDATE studio_r2_upload_parts SET etag=? WHERE file_id=? AND part=? AND hash=?')
   .bind(etag,id,index,sum)]);
  return progress(upload,index+1,sessionFor(upload));
 });
}

export async function finishR2Upload<T>(request:Request,projectId:string,id:string,kind:FileMetadata['kind'],
 commit:(file:FileMetadata,read:(start:number,end:number)=>Promise<Uint8Array>,persist:((createdAt:string)=>D1PreparedStatement[])|null)=>Promise<T>) {
 const existing=await getFile(id,kind,projectId);
 if(existing) {
  const {mediaRange}=await import('./media-range');
  return commit(existing,(start,end)=>mediaRange(existing,false,start,end),null);
 }
 return withLease(request,projectId,id,async(upload,lease,bucket)=>{
  if(upload.kind!==kind)throw new HttpError(409,'文件类型不匹配。');
  const completed=await parts(upload);
  if(firstMissing(upload,completed)!==numParts(upload))throw new HttpError(409,'分段尚未上传完成。');
  if(!await bucket.head(upload.object_key)&&upload.upload_id) {
   await bucket.resumeMultipartUpload(upload.object_key,upload.upload_id)
    .complete(completed.map(part=>({partNumber:part.part+1,etag:part.etag!})));
  }
  const object=await bucket.get(upload.object_key);
  if(!object||object.size!==upload.bytes){await object?.body.cancel();throw new HttpError(409,'对象长度不符，无法完成上传。');}
  const digest=createHash('sha256'),reader=object.body.getReader();
  let size=0;
  try {
   for(;;) {
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.length;
    if(size>upload.bytes)throw new HttpError(409,'对象长度超出预期。');
    digest.update(value);
   }
  } finally {await reader.cancel().catch(()=>{});}
  if(size!==upload.bytes||digest.digest('hex')!==upload.hash)throw new HttpError(422,'对象 SHA-256 校验失败。');
  const read=async(start:number,end:number)=>{
   const range=await bucket.get(upload.object_key,{range:{offset:start,length:end-start},onlyIf:{etagMatches:object.etag}});
   if(!range||!('body' in range))throw new HttpError(409,'上传对象已变化。');
   const bytes=new Uint8Array(await range.arrayBuffer());
   if(bytes.length!==end-start)throw new HttpError(409,'对象分段长度不符。');
   return bytes;
  };
  if(kind!=='pptx'&&detectMime(await read(0,Math.min(64,size)),kind,upload.mime)!==upload.mime)
   throw new HttpError(415,'文件格式与内容不一致。');
  return commit(upload,read,createdAt=>{
   const db=database();
   return [
    guard(`EXISTS(SELECT 1 FROM studio_r2_uploads u JOIN studio_r2_effective_policy p ON p.project_id=u.project_id
     WHERE u.id=? AND u.lease=? AND u.lease_until>? AND u.status='open' AND u.expires_at>?
     AND (u.kind<>'pptx' OR u.bytes<=p.max_deck_bytes))`,id,lease,Date.now(),Date.now()),
    db.prepare("UPDATE studio_r2_uploads SET status='committing' WHERE id=? AND lease=?").bind(id,lease),
    db.prepare('INSERT INTO rehearsal_files(id,project_id,kind,mime,bytes,hash,created_at) VALUES (?,?,?,?,?,?,?)')
     .bind(id,projectId,upload.kind,upload.mime,Math.min(upload.bytes,MAX_DECK_BYTES),upload.hash,createdAt),
    db.prepare("INSERT INTO studio_r2_media VALUES(?,?,'r2',?)").bind(id,upload.object_key,Date.now()),
    db.prepare('INSERT INTO studio_r2_verified VALUES(?,?,?,?)').bind(upload.object_key,object.etag,upload.bytes,upload.hash),
    db.prepare('DELETE FROM studio_r2_uploads WHERE id=? AND lease=?').bind(id,lease),
   ];
  });
 });
}
