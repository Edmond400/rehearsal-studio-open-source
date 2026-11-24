import {createHash} from 'node:crypto';
import {database} from '../data';
import {HttpError} from '../http';
import {CHUNK_BYTES} from './model';
import {d1MediaRange} from './media-range';
import {r2Location,readR2} from './r2-storage';
import {MEDIA_RANGE_BYTES} from './media-transfer';
export type FileMetadata={id:string;project_id:string;kind:'audio'|'slide'|'pptx';mime:string;bytes:number;hash:string};
export async function sha256(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex')}
export function detectMime(bytes:Uint8Array,kind:'audio'|'slide'|'pptx',claimed:string){
 const b=bytes;let actual='';
 if(kind==='audio'){
  if(b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3)actual='audio/webm';
  else if(b.length>=12&&new TextDecoder().decode(b.slice(4,8))==='ftyp')actual='audio/mp4';
  else if(new TextDecoder().decode(b.slice(0,4))==='OggS')actual='audio/ogg';
 }else{
  if(b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10)actual='image/png';
  else if(b[0]===255&&b[1]===216&&b[2]===255)actual='image/jpeg';
  else if(new TextDecoder().decode(b.slice(0,4))==='RIFF'&&new TextDecoder().decode(b.slice(8,12))==='WEBP')actual='image/webp';
 }
 if(!actual||claimed.split(';')[0].toLowerCase()!==actual)throw new HttpError(415,'文件格式与MIME不匹配，仅支持浏览器音频或静态图片。');
 return actual;
}
export function fileStatements(f:FileMetadata,bytes:Uint8Array){
 const db=database(),stmts=[db.prepare('INSERT INTO rehearsal_files(id,project_id,kind,mime,bytes,hash,created_at) VALUES (?,?,?,?,?,?,?)').bind(f.id,f.project_id,f.kind,f.mime,f.bytes,f.hash,new Date().toISOString())];
 // The D1 JS binding serializes a binary parameter as a number array.
 // A bounded hex string avoids that allocation while SQLite still stores a BLOB.
 const view=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 for(let offset=0,i=0;offset<bytes.length;offset+=CHUNK_BYTES,i++){
  stmts.push(db.prepare('INSERT INTO rehearsal_file_chunks(file_id,chunk_index,data) VALUES (?,?,unhex(?))')
   .bind(f.id,i,view.subarray(offset,offset+CHUNK_BYTES).toString('hex')));
 }
 return stmts;
}
export async function mediaFileTable() {
 return await database().prepare("SELECT 1 FROM sqlite_schema WHERE name='studio_media_files'").first()
  ?'studio_media_files':'rehearsal_files';
}
export async function getFile(id:string,kind:'audio'|'slide'|'pptx',projectId='current'){
 const table=kind==='pptx'?await mediaFileTable():'rehearsal_files';
 return database().prepare(`SELECT * FROM ${table} WHERE id=? AND project_id=? AND kind=?`).bind(id,projectId,kind).first<FileMetadata>();
}
export async function serveFile(request:Request,file:FileMetadata){
 let start=0,end=file.bytes-1;
 const range=request.headers.get('range');
 const headers=new Headers({'Content-Type':file.mime,'Content-Disposition':'inline','Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Accept-Ranges':'bytes','ETag':'"sha256-'+file.hash+'"'});
 if(range){
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid=()=>{headers.set('Content-Range','bytes */'+file.bytes);return new Response(null,{status:416,headers});};
  if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(Number(match[1]))||!Number.isSafeInteger(Number(match[2])))return invalid();
  if(!match[1])start=Math.max(0,file.bytes-Number(match[2]));
  else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
  if(start>end||start>=file.bytes)return invalid();
  headers.set('Content-Range',`bytes ${start}-${end}/${file.bytes}`);
 }
 const size=end-start+1;
 headers.set('Content-Length',String(size));
 const status=range?206:200;
 const location=await r2Location(file);
 if(location){
  if(request.method==='HEAD'){
   if(await readR2(file,location,start,end+1,true))return new Response(null,{status,headers});
  }else{
   const object=await readR2(file,location,start,end+1);
   if(object)return new Response(object.body,{status,headers});
  }
 }
 if(range&&size<=MEDIA_RANGE_BYTES&&request.method!=='HEAD'){
  try{
   const data=await d1MediaRange(file,false,start,end+1);
   return new Response(new Uint8Array(data),{status,headers});
  }catch{throw new HttpError(409,'文件分块不完整，请重新读取。');}
 }
 const stats=await database().prepare('SELECT count(*) AS n,sum(length(data)) AS bytes FROM rehearsal_file_chunks WHERE file_id=?')
  .bind(file.id).first<{n:number;bytes:number}>();
 if(stats?.n!==Math.ceil(file.bytes/CHUNK_BYTES)||stats.bytes!==file.bytes)throw new HttpError(409,'文件不完整，请联系管理员或重新提交。');
 if(request.method==='HEAD')return new Response(null,{status,headers});
 // Legacy full GET stays available, with a bounded result and backpressure.
 let offset=start;
 const stream=new ReadableStream<Uint8Array>({async pull(controller){
  try{
   const next=Math.min(end+1,offset+2*CHUNK_BYTES);
   const data=await d1MediaRange(file,false,offset,next);
   controller.enqueue(new Uint8Array(data));offset=next;
   if(offset>end)controller.close();
  }catch(error){controller.error(error);}
 }});
 return new Response(stream,{status,headers});
}
