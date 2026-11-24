'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';
import {apiFetch} from '@/lib/transport';
import {rehearsalHeaders} from '@/lib/rehearsal/session';
import {forgetDeck,recoverDecks,recoveredPages,rememberDeck,rememberPage,type DeckJob} from '@/lib/rehearsal/deck-import-recovery';
import {uploadMedia,mediaDigest,r2MediaCapability,uploadR2Preview} from '@/lib/rehearsal/media-client';
import {replaceDeck,slideReplacementPlan} from '@/lib/rehearsal/deck-replace';
import {MAX_PAGE_BYTES,newRehearsalId,type Project,type Slide} from '@/lib/rehearsal/model';
import type {PreviewPage} from '@/lib/rehearsal/pptx-preview';
import {FilePicker} from './file-picker';

const apiRoot='/api/rehearsal/edit';
const legacyMaxDeck=20*1024*1024;
type Source={id:string;bytes:number;pages:string[];sourceIds:string[]};
const deckType='application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MiB=1024*1024;
const size=(bytes:number)=>(bytes/MiB).toFixed(2)+' MiB';
type Budget={additional:number;remaining:number;fits:boolean;originalId:string|null;previewIds:string[];existingPreviewIds:string[];projectUsed:number;projectLimit:number;siteUsed:number;siteLimit:number};
type Prepared={sourceId:string;bytes:number;hash:string};
type Page=PreviewPage&{repaired?:boolean};
async function asset(blob:Blob){
 return {bytes:blob.size,hash:await mediaDigest(await blob.arrayBuffer())};
}
async function upload<T>(path:string,blob:Blob,mime:string,signal:AbortSignal,sourceId?:string) {
 const response=await apiFetch(apiRoot+path,{
  method:'POST',credentials:'same-origin',body:blob,signal,
  headers:{...rehearsalHeaders(),'Content-Type':mime,...(sourceId?{'X-Rehearsal-Metadata':sourceId}:{})}
 });
 const result=await response.json().catch(()=>({})) as T&{error?:string};
 if(!response.ok)throw new Error(result.error??'上传未完成。请重试。');
 return result;
}

function Preview({image}:{image:Blob}){
 const [url,setUrl]=useState('');
 useEffect(()=>{const next=URL.createObjectURL(image);setUrl(next);return()=>URL.revokeObjectURL(next);},[image]);
 return url?<img src={url} alt="当前 PPT 静态预览" style={{display:'block',width:'100%',maxWidth:850,height:'auto'}}/>:null;
}

export function DeckImport({project,disabled,onActivity,onApply}:{project:Project;disabled:boolean;onActivity:(active:boolean)=>void;onApply:(next:Project)=>Promise<boolean>}){
 const [job,setJob]=useState<DeckJob|null>(null),[pages,setPages]=useState<Page[]>([]),[total,setTotal]=useState(0);
 const [phase,setPhase]=useState<'idle'|'render'|'upload'>('idle');
 const [pending,setPending]=useState<DeckJob[]>([]),[budget,setBudget]=useState<Budget|null>(null),[manual,setManual]=useState<Record<string,number>>({});
 const [index,setIndex]=useState(0),[message,setMessage]=useState(''),[error,setError]=useState(''),[storageError,setStorageError]=useState('');
 const [r2MaxDeck,setR2MaxDeck]=useState<number|null>(null);
 const maxDeck=r2MaxDeck??legacyMaxDeck;
 const [saved,setSaved]=useState(false);
 const [storeEnabled,setStoreEnabled]=useState(true);
 const active=useRef<AbortController|null>(null);
 const images=useRef(new Map<string,Page>());
 const alive=useRef(true);
 const deck=project.sourceDeck;
 useEffect(()=>{
  alive.current=true;setR2MaxDeck(null);
  let scopeActive=true;
  void r2MediaCapability().then(max=>{if(scopeActive)setR2MaxDeck(max);}).catch(()=>{});
  void recoverDecks(project.id).then(list=>{if(alive.current)setPending(list);}).catch(()=>{if(alive.current)setStorageError('此浏览器无法读取上次导入。');});
  return()=>{scopeActive=false;alive.current=false;active.current?.abort();};
 },[project.id]);

 async function store(work:()=>Promise<unknown>){
  if(!storeEnabled)return;
  try{await work();}catch{if(alive.current)setStorageError('本机空间不足或禁止本地保存。请保留原始 PPTX，关闭页面后可能需要重新导入。');}
 }
 const complete=total>0&&pages.length===total&&pages.every(p=>p.image);
 async function getBudget(source:DeckJob,items:Page[]) {
  const images:Prepared[]=[];
  for(const item of items){
   if(!item.image)throw new Error('还有页面需要修复。');
   images.push({sourceId:item.sourceId,...await asset(item.image)});
  }
  return api(apiRoot+'/preview-budget',{source:await asset(source.file),pages:images}) as Promise<Budget>;
 }
 async function render(source:DeckJob,resume=false){
  if(active.current)return;
  const control=active.current=new AbortController();
  setJob(source);setSaved(false);setError('');setMessage('正在读取原始 PPTX…');setPhase('render');setManual({});setBudget(null);setIndex(0);
  try {
   if(resume){
    const cached=await recoveredPages(source.id).catch(()=>new Map<string,Page>());
    images.current=new Map([...cached,...images.current]);
   }else images.current=new Map();
   setPages([]);setTotal(0);
   await store(()=>rememberDeck(source));
   const {renderPptxPreviews}=await import('@/lib/rehearsal/pptx-preview');
   const ordered:Page[]=[];
   const result=await renderPptxPreviews(source.file,{signal:control.signal,cached:images.current,onPage:async(page,i,n)=>{
    if(!alive.current)return;
    ordered[i]=page;
    images.current.set(page.path,page);
    setTotal(n);setPages([...ordered]);setMessage('已处理 '+(i+1)+' / '+n+' 页');
    await store(()=>rememberPage(source.id,i,page));
   }});
   if(!alive.current)return;
   if(result.pages.every(p=>p.image)){
    setMessage('全部 '+ordered.length+' 页已生成。核对预览后可应用到草稿。');
    try{setBudget(await getBudget(source,ordered));}catch(e){setError((e as Error).message);}
   }else setMessage('部分页面需要修复。完成后可应用到草稿。');
  }catch(e){
   if(alive.current){
    setMessage(control.signal.aborted?'已暂停导入。可以继续上次进度。':'');
    if(!control.signal.aborted)setError((e as Error).message||'PPTX 渲染中断，请拆分文件后重试。');
   }
  }finally{active.current=null;if(alive.current)setPhase('idle');}
 }
 async function repair(file:File){
  const page=pages[index];
  if(!job||!page)return;
  if(file.size>MAX_PAGE_BYTES||!/^image\/(png|jpeg|webp)$/.test(file.type)){setError('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP。');return;}
  const url=URL.createObjectURL(file);
  try{
   const img=new Image();img.src=url;await img.decode();
   if(img.naturalWidth*img.naturalHeight>8000000)throw new Error('图片像素过多，请缩小后重试。');
   const updated={...page,image:file,width:img.naturalWidth,height:img.naturalHeight,error:undefined,warnings:['此页由用户提供静态预览。'],repaired:true};
   images.current.set(page.path,updated);
   const next=pages.map((p,i)=>i===index?updated:p);
   setPages(next);setError('');setBudget(null);
   await store(()=>rememberPage(job.id,index,updated));
   if(next.length===total&&next.every(p=>p.image))setBudget(await getBudget(job,next));
  }catch(e){setError((e as Error).message);}
  finally{URL.revokeObjectURL(url);}
 }

 function planned(sourceId:string|null,plan:Budget|null):Slide[]{
  return pages.map((page,pageIndex)=>{
   const previous=sourceId&&deck?.id===sourceId&&!page.repaired?project.slides.find(s=>s.sourcePage===page.path):undefined;
   if(previous)return {...previous,pageIndex};
   return {id:plan?.previewIds[pageIndex]??'pending-'+page.sourceId,pageIndex,sourcePage:page.path,sourceId:page.sourceId,
    mime:page.image?.type??'image/jpeg',bytes:page.image?.size??0};
  });
 }
 const proposed=planned(budget?.originalId??null,budget);
 const unresolved=slideReplacementPlan(project,budget?.originalId??'',proposed).unresolved;

 async function apply() {
  if(!job||!complete||active.current)return;
  const controller=active.current=new AbortController();
  setPhase('upload');onActivity(true);setError('');
  try{
   const current=await getBudget(job,pages);
   setBudget(current);
   const expected=planned(current.originalId,current);
   const mapping=slideReplacementPlan(project,current.originalId??'',expected);
   if(mapping.unresolved.some(id=>!expected[manual[id]]))throw new Error('先为未匹配的旧页面选择替代页。');
   if(!current.fits)throw new Error('本次预计新增 '+size(current.additional)+'，可用 '+size(current.remaining)+'。请清理无引用文件或缩小 PPTX。');
   setMessage('正在上传原始 PPTX…');
   const source=current.originalId
    ?{id:current.originalId,bytes:job.file.size,pages:pages.map(p=>p.path),sourceIds:pages.map(p=>p.sourceId)}
    :await uploadMedia<Source>(job.file,{kind:'pptx',hash:await mediaDigest(await job.file.arrayBuffer())},undefined,controller.signal,
      sent=>setMessage('已上传原件 '+size(sent)+' / '+size(job.file.size)))
      ??await upload<Source>('/pptx',job.file,deckType,controller.signal);
   if(JSON.stringify(source.pages)!==JSON.stringify(pages.map(p=>p.path))||
      JSON.stringify(source.sourceIds)!==JSON.stringify(pages.map(p=>p.sourceId)))throw new Error('服务器核对页序失败，草稿仍需重新导入。');
   const staged:Slide[]=[];
   for(const [pageIndex,page] of pages.entries()){
    if(controller.signal.aborted)return;
    const old=source.id===deck?.id&&!page.repaired?project.slides.find(s=>s.sourcePage===page.path):undefined;
    if(old)staged.push({...old,pageIndex});
    else if(current.existingPreviewIds.includes(current.previewIds[pageIndex])){
     staged.push({id:current.previewIds[pageIndex],pageIndex,sourcePage:page.path,sourceId:page.sourceId,mime:page.image!.type,bytes:page.image!.size});
    }else {
     const image=page.image!;
     const file=await uploadR2Preview<{id:string;mime:string;bytes:number}>(image,{
      kind:'slide',hash:await mediaDigest(await image.arrayBuffer()),sourceId:page.sourceId,mime:image.type
     },controller.signal,r2MaxDeck!==null)
      ??await upload<{id:string;mime:string;bytes:number}>('/preview-page',image,image.type,controller.signal,page.sourceId);
     if(file.id!==current.previewIds[pageIndex]||file.bytes!==page.image!.size)throw new Error('上传后的页面校验不符。');
     staged.push({...file,pageIndex,sourcePage:page.path,sourceId:page.sourceId});
    }
    setMessage('已上传 '+staged.length+' / '+pages.length+' 页，正在准备应用');
   }
   if(controller.signal.aborted)return;
   const changed=replaceDeck(project,{id:source.id,pages:source.pages,bytes:source.bytes},staged,manual);
   if(!await onApply(changed))throw new Error('草稿尚未确认保存。请处理同步冲突后再核对。');
   await forgetDeck(job.id).catch(()=>{});
   setPending(list=>list.filter(row=>row.id!==job.id));
   setMessage('全部 '+staged.length+' 页已应用，草稿已保存。');setSaved(true);
   setJob(null);setPages([]);setBudget(null);setTotal(0);images.current.clear();
  }catch(e){
   if(alive.current){
    setMessage(controller.signal.aborted?'上传已暂停。可继续应用，重复文件会复用。':'');
    if(!controller.signal.aborted)setError((e as Error).message);
   }
  }finally{active.current=null;onActivity(false);if(alive.current)setPhase('idle');}
 }

 const importStatus=error?"失败可重试":phase==="render"?"正在解析/转换":phase==="upload"?"正在保存":saved?"已保存到草稿":complete?"已解析待保存":"待选择";
 return <section className="panel rh-pad">
  <h2>上传 PPTX 并生成预览</h2>
  <p>选择一次 PPTX。浏览器会生成静态页面，核对后将原件和预览一起应用到草稿。</p>
  <p className="rh-import-feedback" role="status"><strong>{importStatus}</strong>{job&&' · '+job.name}{total>0&&' · '+pages.filter(p=>p.image).length+' / '+total+' 页预览成功'}</p>
  <FilePicker label="上传 PPTX" hint={'原始 PPTX（最多 '+maxDeck/MiB+' MiB）'} accept=".pptx" disabled={disabled||phase!=='idle'}
   onFiles={files=>{const file=files?.[0];if(!file)return;
    if(file.size>maxDeck||!file.name.toLowerCase().endsWith('.pptx')){setError('请选择不超过 '+maxDeck/MiB+' MiB 的 PPTX。');return;}
    if(job&&!confirm('开始另一份 PPTX？已有本地导入可稍后恢复。'))return;
    void render({id:newRehearsalId(),projectId:project.id,name:file.name,file,updated:Date.now()});
   }}/>
  <label><input type="checkbox" checked={storeEnabled} disabled={phase!=='idle'||!!job} onChange={e=>setStoreEnabled(e.target.checked)}/>在本机保存导入进度（72 小时）</label>
  {storageError&&<p role="status">{storageError}<ErrorContact /></p>}
  {!job&&pending.map(row=><div key={row.id} className="rh-actions">
   <button disabled={disabled} onClick={()=>void render(row,true)}>恢复 {row.name}</button>
   <button disabled={disabled} onClick={()=>{if(confirm('删除该本地导入副本？'))void forgetDeck(row.id).then(()=>setPending(list=>list.filter(item=>item.id!==row.id))).catch(e=>setError(e.message));}}>删除本地副本</button>
  </div>)}
  {job&&<div className="rh-actions"><strong>{job.name}</strong>
   {phase!=='idle'?<button onClick={()=>active.current?.abort()}>暂停</button>:<>
    <button disabled={disabled} onClick={()=>void render(job,true)}>继续生成</button>
    <button disabled={disabled} onClick={()=>{if(!confirm('放弃这次本地导入？'))return;void forgetDeck(job.id).catch(()=>{});setPending(list=>list.filter(row=>row.id!==job.id));setJob(null);setPages([]);setTotal(0);setBudget(null);setMessage('');setError('');images.current.clear();}}>放弃导入</button>
   </>}
  </div>}
  {message&&<p role="status">{message}</p>}
  {error&&<p className="callout error" role="alert">{error}<ErrorContact /></p>}
  {!!pages.length&&<div>
   <label>查看生成的页面<select value={index} onChange={e=>setIndex(+e.target.value)}>{pages.map((page,i)=><option key={page.path} value={i}>第 {i+1} 页{page.error?' · 待修复':''}</option>)}</select></label>
   {pages[index]?.image&&<Preview image={pages[index].image!}/>}
   {pages[index]?.error&&<p className="callout error">{pages[index].error}<ErrorContact /></p>}
   {pages[index]?.warnings.map(warning=><p className="muted" key={warning}>{warning}</p>)}
   <details><summary>更多 · 高级修复：预览异常？替换该页预览图</summary><p className="muted">只修改此页静态预览图，不会更改 PPTX 原文件。</p><FilePicker label="替换当前预览图" hint="PNG / JPEG / WebP（不超过 2 MiB）" accept="image/png,image/jpeg,image/webp" disabled={phase!=='idle'} onFiles={files=>{if(files?.[0])void repair(files[0])}}/></details>
  </div>}
  {complete&&<>
   {budget&&<p>预计新增 {size(budget.additional)}，剩余 {size(budget.remaining)}。项目 {size(budget.projectUsed)} / {size(budget.projectLimit)}，全站 {size(budget.siteUsed)} / {size(budget.siteLimit)}。</p>}
   {!!unresolved.length&&<div className="callout"><p>以下旧页面仍有关联讲稿，请确认替代页。</p>
    {unresolved.map(id=><label key={id}>原第 {project.slides.findIndex(s=>s.id===id)+1} 页<select value={manual[id]??''} onChange={e=>setManual({...manual,[id]:e.target.value===''?-1:+e.target.value})}>
     <option value="">选择替代页</option>{pages.map((page,i)=><option key={page.path} value={i}>新第 {i+1} 页</option>)}
    </select></label>)}
   </div>}
   <button className="btn" disabled={phase!=='idle'||disabled||unresolved.some(id=>!pages[manual[id]])} onClick={()=>void apply()}>应用全部预览到草稿</button>
  </>}
 </section>;
}
