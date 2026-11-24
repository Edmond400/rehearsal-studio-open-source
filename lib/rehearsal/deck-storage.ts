import {z} from 'zod';
import {database} from '../data';
import {HttpError} from '../http';
import {digest} from '../passwords';
import {MAX_PAGE_BYTES,MAX_SITE_FILE_BYTES} from './model';
import {MAX_R2_DECK_BYTES,R2_PROJECT_MEDIA_BUDGET,R2_SITE_MEDIA_BUDGET} from './media-transfer';
import {fileStatements,mediaFileTable,sha256,type FileMetadata} from './storage';

export const MAX_DECK_BYTES=20*1024*1024;
export const deckMime='application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const sourceIdSchema=z.string().regex(/^\d{1,10}$/);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const asset=(max:number)=>z.object({bytes:z.number().int().positive().max(max),hash}).strict();
export const deckBudgetSchema=z.object({
 source:asset(MAX_R2_DECK_BYTES),
 pages:z.array(asset(MAX_PAGE_BYTES).extend({sourceId:sourceIdSchema})).min(1).max(200)
}).strict();

export function previewId(projectId:string,sourceId:string,hash:string){
 return 'preview-'+digest(JSON.stringify([projectId,sourceId,hash]));
}
export function originalId(projectId:string,hash:string){
 return 'deck-'+digest(JSON.stringify([projectId,hash]));
}
export async function deckCapacity(projectId:string) {
 const db=database();
 const now=Date.now();
 const table=await db.prepare("SELECT 1 FROM sqlite_schema WHERE name='studio_d1_media'").first()?'studio_d1_media':'rehearsal_files';
 const [project,site]=await Promise.all([
  db.prepare(`SELECT max_bytes,(SELECT COALESCE(sum(bytes),0) FROM ${table} WHERE project_id=?) +(SELECT COALESCE(sum(bytes),0) FROM rehearsal_media_uploads WHERE project_id=? AND reserved=1 AND expires_at>?) AS used
   FROM studio_usage WHERE project_id=?`).bind(projectId,projectId,now,projectId).first<{max_bytes:number;used:number}>(),
  db.prepare(`SELECT (SELECT COALESCE(sum(bytes),0) FROM ${table})
   +(SELECT COALESCE(sum(bytes),0) FROM rehearsal_media_uploads WHERE reserved=1 AND expires_at>?) AS used`).bind(now).first<{used:number}>()
 ]);
 if(!project)throw new HttpError(404,'项目不存在或存储额度未初始化。');
 return {projectUsed:project.used,projectLimit:project.max_bytes,siteUsed:site?.used??0,siteLimit:MAX_SITE_FILE_BYTES};
}

export async function existingOriginal(projectId:string,hash:string,bytes:number){
 const table=await mediaFileTable();
 return database().prepare(`SELECT * FROM ${table} WHERE project_id=? AND kind='pptx' AND hash=? AND bytes=? ORDER BY created_at,id LIMIT 1`).bind(projectId,hash,bytes).first<FileMetadata>();
}
async function r2DeckCapacity(projectId:string) {
 const row=await database().prepare(`SELECT
 (SELECT COALESCE(sum(bytes),0) FROM studio_media_files WHERE project_id=?)
 +(SELECT COALESCE(sum(bytes),0) FROM rehearsal_media_uploads WHERE project_id=? AND reserved=1)
 +(SELECT COALESCE(sum(bytes),0) FROM studio_r2_uploads WHERE project_id=?)
 +(SELECT COALESCE(sum(bytes),0) FROM studio_r2_upload_quarantine WHERE project_id=?) AS projectUsed,
 (SELECT COALESCE(sum(bytes),0) FROM studio_r2_verified)
 +(SELECT COALESCE(sum(bytes),0) FROM studio_r2_uploads)
 +(SELECT COALESCE(sum(bytes),0) FROM studio_r2_upload_quarantine)
 +(SELECT COALESCE(sum(f.bytes),0) FROM studio_r2_media m JOIN rehearsal_files f ON f.id=m.file_id
 WHERE NOT EXISTS(SELECT 1 FROM studio_r2_verified v WHERE v.object_key=m.object_key)) AS siteUsed`)
 .bind(projectId,projectId,projectId,projectId).first<{projectUsed:number;siteUsed:number}>();
 return {...row!,projectLimit:R2_PROJECT_MEDIA_BUDGET,siteLimit:R2_SITE_MEDIA_BUDGET};
}

export async function previewBudget(projectId:string,input:z.infer<typeof deckBudgetSchema>,maxR2Deck?:number){
 if(input.source.bytes>(maxR2Deck??MAX_DECK_BYTES))throw new HttpError(413,'PPTX 超过当前上传上限。');
 if(new Set(input.pages.map(p=>p.sourceId)).size!==input.pages.length)throw new HttpError(400,'原始页面身份重复。');
 const ids=input.pages.map(p=>previewId(projectId,p.sourceId,p.hash));
 const [existing,original,budget,reserved]=await Promise.all([
  database().prepare("SELECT id FROM rehearsal_files WHERE project_id=? AND kind='slide' AND id IN (SELECT value FROM json_each(?))").bind(projectId,JSON.stringify(ids)).all<{id:string}>(),
  existingOriginal(projectId,input.source.hash,input.source.bytes),
  maxR2Deck?r2DeckCapacity(projectId):deckCapacity(projectId),
  database().prepare(maxR2Deck
   ?"SELECT id FROM studio_r2_uploads WHERE id=? AND project_id=? AND status='open' AND expires_at>?"
   :'SELECT id FROM rehearsal_media_uploads WHERE id=? AND project_id=? AND reserved=1 AND expires_at>?')
   .bind(originalId(projectId,input.source.hash),projectId,Date.now()).first()
 ]);
 const found=new Set(existing.results.map(r=>r.id));
 const additional=(original||reserved?0:input.source.bytes)+input.pages.reduce((total,p,i)=>total+(found.has(ids[i])?0:p.bytes),0);
 const remaining=Math.max(0,Math.min(budget.projectLimit-budget.projectUsed,budget.siteLimit-budget.siteUsed));
 return {...budget,additional,remaining,fits:additional<=remaining,originalId:original?.id??null,previewIds:ids,existingPreviewIds:[...found]};
}
export async function saveDeckAsset(projectId:string,kind:'slide'|'pptx',mime:string,bytes:Uint8Array,guard:D1PreparedStatement,sourceId?:string){
 const hash=await sha256(bytes);
 const id=kind==='pptx'?originalId(projectId,hash):previewId(projectId,sourceId!,hash);
 const db=database();
 const lookup=async()=>kind==='pptx'?existingOriginal(projectId,hash,bytes.length):
  db.prepare("SELECT * FROM rehearsal_files WHERE id=? AND project_id=? AND kind='slide' AND hash=? AND bytes=?").bind(id,projectId,hash,bytes.length).first<FileMetadata>();
 const old=await lookup();
 if(old)return old;
 const file={id,project_id:projectId,kind,mime,bytes:bytes.length,hash};
 // The studio_quota insert trigger checks both limits atomically. A
 // second global SUM here would spend a D1 statement on the same limit.
 try{await db.batch([guard,...fileStatements(file,bytes)]);}
 catch(error){
  const existing=await lookup();
  if(existing)return existing;
  if(error instanceof Error&&error.message.includes('studio_quota_exceeded'))throw new HttpError(409,'存储容量不足。已完成的预览会保留，可清理无引用文件后继续。');
  throw error;
 }
 return file;
}
