import {z} from 'zod';
import {database} from '../data';
import {HttpError,readBytes} from '../http';
import {guard,sessionGuard} from '../security';
import {deckMime,existingOriginal,MAX_DECK_BYTES,originalId} from './deck-storage';
import {MAX_AUDIO_BYTES} from './model';
import {MEDIA_PART_BYTES} from './media-transfer';
import {ResumableSha256} from './media-hash';
import {detectMime,getFile,sha256,type FileMetadata} from './storage';

const ttl = 72 * 3600000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const uploadSchema = z.discriminatedUnion('kind', [
 z.object({kind:z.literal('pptx'),bytes:z.number().int().positive().max(MAX_DECK_BYTES),hash:digest}).strict(),
 z.object({kind:z.literal('audio'),id:z.string().uuid(),bytes:z.number().int().positive().max(MAX_AUDIO_BYTES),
  hash:digest,mime:z.enum(['audio/webm','audio/mp4','audio/ogg'])}).strict()
]);
export const uploadIdSchema = z.string().uuid().or(z.string().regex(/^deck-[a-f0-9]{64}$/));
export type MediaUpload = FileMetadata & {
 kind:'pptx'|'audio'; next_part:number; hash_state:string|null; verified:number; expires_at:number;
};

export function getUpload(project:string,id:string) {
 return database().prepare('SELECT * FROM rehearsal_media_uploads WHERE project_id=? AND id=? AND expires_at>?')
  .bind(project,id,Date.now()).first<MediaUpload>();
}

function progress(id:string,next:number) {
 return {id,next,partBytes:MEDIA_PART_BYTES};
}

async function audioReceived(project:string,id:string) {
 return database().prepare(`SELECT recording_id FROM rehearsal_recording_receipts WHERE project_id=? AND recording_id=?
  UNION ALL SELECT id FROM rehearsal_recordings WHERE project_id=? AND id=? LIMIT 1`).bind(project,id,project,id).first();
}

export async function beginUpload(request:Request,project:string,input:z.infer<typeof uploadSchema>) {
 const id=input.kind==='pptx'?originalId(project,input.hash):input.id;
 const mime=input.kind==='pptx'?deckMime:input.mime;
 const db=database();
 const committed=input.kind==='pptx'?await existingOriginal(project,input.hash,input.bytes):await audioReceived(project,id);
 if(committed){
  // A recording ID is an idempotency key, not proof that the caller is
  // retrying the same audio. A pruned recording may have only a receipt; its
  // request hash is checked again by commitRecording at /finish.
  if(input.kind==='audio'){
   const existing=await getFile(id,'audio',project);
   if(existing&&(existing.bytes!==input.bytes||existing.hash!==input.hash||existing.mime!==mime)){
    throw new HttpError(409,'此录音标识对应已提交的另一份文件，请使用新的录音标识。');
   }
  }
  return progress('id' in committed?String(committed.id):id,Math.ceil(input.bytes/MEDIA_PART_BYTES));
 }
 const now=Date.now();
 try{
  await db.batch([
   // Keep expired-upload cleanup and the new quota reservation in the same
   // authorized transaction. A revoked session or failed reservation must not
   // commit cleanup in another project.
   sessionGuard(request,project),
   db.prepare('DELETE FROM rehearsal_media_uploads WHERE expires_at<=?').bind(now),
   db.prepare(`INSERT INTO rehearsal_media_uploads(id,project_id,kind,mime,bytes,hash,expires_at)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rehearsal_media_uploads WHERE id=?)
    AND NOT EXISTS(SELECT 1 FROM rehearsal_files WHERE id=?)
    AND (SELECT count(*) FROM rehearsal_media_uploads WHERE project_id=?)<12
    AND (SELECT count(*) FROM rehearsal_media_uploads)<128`).bind(id,project,input.kind,mime,input.bytes,input.hash,now+ttl,id,id,project)
  ]);
 }catch(error){
  if(error instanceof Error&&error.message.includes('studio_quota_exceeded'))throw new HttpError(409,'存储容量不足。未完成上传也会预留额度。');
  throw error;
 }
 const staged=await getUpload(project,id);
 if(!staged){
  // Another tab may have finalized the file between the first committed-file
  // lookup and this read. Do not acknowledge unrelated bytes or a mismatched
  // declared length merely because the deterministic ID is already present.
  const file=await getFile(id,input.kind,project);
  if(file){
   if(file.bytes!==input.bytes||file.hash!==input.hash||file.mime!==mime){
    throw new HttpError(409,'已提交文件与本次上传的大小、摘要或格式不一致。');
   }
   return progress(id,Math.ceil(file.bytes/MEDIA_PART_BYTES));
  }
  // Preserve the existing 30-day receipt semantics for retired audio IDs;
  // the final recording request hash is checked again by commitRecording.
  if(input.kind==='audio'&&await audioReceived(project,id)){
   return progress(id,Math.ceil(input.bytes/MEDIA_PART_BYTES));
  }
  throw new HttpError(409,'已有过多未完成上传或标识已被使用，请稍后重试。');
 }
 if(staged.kind!==input.kind||staged.hash!==input.hash||staged.bytes!==input.bytes||staged.mime!==mime){
  throw new HttpError(409,'上传标识对应不同文件。');
 }
 return progress(id,staged.next_part);
}

export async function putUploadPart(request:Request,project:string,id:string,part:number) {
 const stage=await getUpload(project,id);
 if(!stage){
  const file=await getFile(id,id.startsWith('deck-')?'pptx':'audio',project);
  if(file)return progress(id,Math.ceil(file.bytes/MEDIA_PART_BYTES));
  throw new HttpError(404,'上传已过期，请重新开始。');
 }
 const offset=part*MEDIA_PART_BYTES;
 const expected=Math.min(MEDIA_PART_BYTES,stage.bytes-offset);
 if(!Number.isSafeInteger(part)||part<0||expected<=0||part>stage.next_part)throw new HttpError(409,'分块次序不符，请恢复上传。');
 const bytes=await readBytes(request,expected);
 if(bytes.length!==expected)throw new HttpError(400,'分块读取不完整，请重试。');
 const db=database(),partHash=await sha256(bytes);
 async function replay() {
  const saved=await db.prepare(`SELECT p.hash,u.next_part FROM rehearsal_media_parts p JOIN rehearsal_media_uploads u
   ON u.id=p.upload_id WHERE u.project_id=? AND p.upload_id=? AND p.part=?`).bind(project,id,part)
   .first<{hash:string;next_part:number}>();
  if(!saved)return null;
  if(saved.hash!==partHash)throw new HttpError(409,'重试分块与已保存内容不同。');
  return progress(id,saved.next_part);
 }
 if(part<stage.next_part){
  const saved=await replay();
  if(saved)return saved;
  throw new HttpError(409,'上传状态已变更，请恢复上传。');
 }
 if(stage.kind==='audio'&&part===0)detectMime(bytes,'audio',stage.mime);
 const hash=new ResumableSha256(offset,stage.hash_state).update(bytes);
 const last=offset+bytes.length===stage.bytes;
 const compare=guard(`EXISTS(SELECT 1 FROM rehearsal_media_uploads WHERE id=? AND project_id=?
  AND next_part=? AND verified=0 AND reserved=1 AND expires_at>?)`,id,project,part,Date.now());
 if(last&&Buffer.from(hash.digest()).toString('hex')!==stage.hash){
  // Do not store an invalid final block or erase the verified prefix.
  // The caller can retry the final part with correct bytes; if the declared
  // file hash itself was wrong, the reservation expires through normal cleanup.
  throw new HttpError(422,'文件 SHA-256 校验失败，请核对最后一块或重新选择原件。');
 }
 const hex=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('hex');
 try{
  await db.batch([
   sessionGuard(request,project),compare,
   db.prepare('INSERT INTO rehearsal_media_parts VALUES (?,?,?,unhex(?))').bind(id,part,partHash,hex),
   db.prepare('UPDATE rehearsal_media_uploads SET next_part=?,hash_state=?,verified=?,expires_at=? WHERE id=?')
    .bind(part+1,last?null:hash.checkpoint(),last?1:0,Date.now()+ttl,id)
  ]);
 }catch{
  const saved=await replay();
  if(saved)return saved;
  throw new HttpError(409,'上传状态已变更，请恢复上传。');
 }
 return progress(id,part+1);
}

// Keep the old, immutable 512 KiB storage layout. All binary copying is in D1.
export function promoteUpload(stage:MediaUpload,createdAt:string) {
 const db=database(),{id,project_id:project,kind,mime,bytes,hash}=stage;
 return [
  guard(`EXISTS(SELECT 1 FROM rehearsal_media_uploads WHERE id=? AND project_id=? AND kind=? AND mime=? AND hash=?
   AND bytes=? AND verified=1 AND reserved=1 AND expires_at>?)
   AND (SELECT count(*) FROM rehearsal_media_parts WHERE upload_id=?)=?
   AND (SELECT sum(length(data)) FROM rehearsal_media_parts WHERE upload_id=?)=?`,
   id,project,kind,mime,hash,bytes,Date.now(),id,Math.ceil(bytes/MEDIA_PART_BYTES),id,bytes),
  db.prepare('UPDATE rehearsal_media_uploads SET reserved=0 WHERE id=?').bind(id),
  db.prepare('INSERT INTO rehearsal_files VALUES (?,?,?,?,?,?,?)').bind(id,project,kind,mime,bytes,hash,createdAt),
  db.prepare(`INSERT INTO rehearsal_file_chunks(file_id,chunk_index,data)
   SELECT a.upload_id,a.part/2,unhex(hex(a.data)||coalesce(hex(b.data),''))
   FROM rehearsal_media_parts a LEFT JOIN rehearsal_media_parts b ON b.upload_id=a.upload_id AND b.part=a.part+1
   WHERE a.upload_id=? AND a.part%2=0`).bind(id),
  db.prepare('DELETE FROM rehearsal_media_uploads WHERE id=?').bind(id)
 ];
}
