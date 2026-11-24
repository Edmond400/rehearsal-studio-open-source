import {database} from '../data';
import {CHUNK_BYTES} from './model';
import {MEDIA_PART_BYTES} from './media-transfer';
import type {FileMetadata} from './storage';
import {r2Location,readR2} from './r2-storage';

export async function mediaRange(file:FileMetadata,staged:boolean,start:number,end:number) {
 if(start<0||end<start||end>file.bytes)throw new Error('ZIP range outside file');
 if(start===end)return new Uint8Array();
 const location=staged?null:await r2Location(file);
 if(location){
  const object=await readR2(file,location,start,end);
  if(object){
   const bytes=new Uint8Array(await object.arrayBuffer());
   if(bytes.length===end-start)return bytes;
   if(location.state==='r2')throw new Error('R2 media range is incomplete');
  }
 }
 return d1MediaRange(file,staged,start,end);
}

export async function d1MediaRange(file:FileMetadata,staged:boolean,start:number,end:number){
 const block=staged?MEDIA_PART_BYTES:CHUNK_BYTES;
 const index=staged?'part':'chunk_index',table=staged?'rehearsal_media_parts':'rehearsal_file_chunks';
 const key=staged?'upload_id':'file_id';
 const rows=await database().prepare(`SELECT ${index} AS block, length(data) AS bytes, hex(substr(data,max(0,?- ${index}*${block})+1,
  min(length(data),?-${index}*${block})-max(0,?-${index}*${block}))) AS data
  FROM ${table} WHERE ${key}=? AND ${index} BETWEEN ? AND ? ORDER BY ${index}`)
  .bind(start,end,start,file.id,Math.floor(start/block),Math.floor((end-1)/block)).all<{data:string;block:number;bytes:number}>();
 const first=Math.floor(start/block),last=Math.floor((end-1)/block);
 if(rows.results.length!==last-first+1||rows.results.some((row,i)=>
  row.block!==first+i||row.bytes!==Math.min(block,file.bytes-row.block*block))){
  throw new Error('Media chunks are incomplete');
 }
 const data=Buffer.concat(rows.results.map(row=>Buffer.from(row.data,'hex')));
 if(data.length!==end-start)throw new Error('ZIP metadata is incomplete');
 return data;
}
