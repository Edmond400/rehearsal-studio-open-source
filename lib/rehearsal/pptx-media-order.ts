import {inflateSync,strFromU8} from 'fflate';
import {pptxSlideOrderFromParts} from './pptx';

// Read only ZIP directory records and the two presentation XML parts. The
// original file has already passed the complete SHA-256 check at this point.
const names=['ppt/presentation.xml','ppt/_rels/presentation.xml.rels'];
const directoryLimit=1024*1024;
const xmlLimit=4*1024*1024;
type ZipEntry={method:number;packed:number;unpacked:number;offset:number};
const view=(bytes:Uint8Array)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);

export async function pptxMediaOrder(bytes:number,read:(start:number,end:number)=>Promise<Uint8Array>) {
 const tailStart=Math.max(0,bytes-65557);
 const tail=view(await read(tailStart,bytes));
 let eocd=-1;
 for(let i=tail.byteLength-22;i>=0;i--){
  if(tail.getUint32(i,true)===0x06054b50&&i+22+tail.getUint16(i+20,true)===tail.byteLength){eocd=i;break;}
 }
 if(eocd<0||tail.getUint16(eocd+4,true)||tail.getUint16(eocd+6,true)){
  throw new Error('PPTX ZIP 目录无效或使用了分卷格式。');
 }
 const count=tail.getUint16(eocd+10,true),size=tail.getUint32(eocd+12,true),start=tail.getUint32(eocd+16,true);
 if(!count||count>6000||count!==tail.getUint16(eocd+8,true)||size>directoryLimit||start+size>tailStart+eocd){
  throw new Error('PPTX ZIP 目录超过安全范围。');
 }
 const directory=await read(start,start+size),d=view(directory),found=new Map<string,ZipEntry>();
 let cursor=0;
 for(let i=0;i<count;i++){
  if(cursor+46>size||d.getUint32(cursor,true)!==0x02014b50)throw new Error('PPTX ZIP 目录项无效。');
  const length=d.getUint16(cursor+28,true);
  const next=cursor+46+length+d.getUint16(cursor+30,true)+d.getUint16(cursor+32,true);
  if(next>size)throw new Error('PPTX ZIP 目录项不完整。');
  if(names.some(name=>name.length===length)){
   const name=strFromU8(directory.subarray(cursor+46,cursor+46+length));
   if(names.includes(name)){
    if(found.has(name)||(d.getUint16(cursor+8,true)&1))throw new Error('PPTX XML 重复或加密。');
    found.set(name,{method:d.getUint16(cursor+10,true),packed:d.getUint32(cursor+20,true),
     unpacked:d.getUint32(cursor+24,true),offset:d.getUint32(cursor+42,true)});
   }
  }
  cursor=next;
 }
 const parts:Record<string,Uint8Array>={};
 let total=0;
 for(const name of names){
  const item=found.get(name);
  if(!item||!item.packed||!item.unpacked||item.packed>xmlLimit||(total+=item.unpacked)>xmlLimit||
   item.offset+30>start||![0,8].includes(item.method))throw new Error('PPTX XML 缺失或超出安全范围。');
  const local=view(await read(item.offset,item.offset+30));
  const offset=item.offset+30+local.getUint16(26,true)+local.getUint16(28,true);
  if(local.getUint32(0,true)!==0x04034b50||local.getUint16(8,true)!==item.method||offset+item.packed>start){
   throw new Error('PPTX XML 文件头无效。');
  }
  const packed=await read(offset,offset+item.packed);
  const xml=item.method===8?inflateSync(packed,{out:new Uint8Array(item.unpacked)}):packed;
  if(xml.length!==item.unpacked)throw new Error('PPTX XML 字节数无效。');
  parts[name]=xml;
 }
 return pptxSlideOrderFromParts(parts);
}
