'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';

import {DEFAULT_CONFIG,type Project,type Block,type Recording,type Estimate,newRehearsalId} from '@/lib/rehearsal/model';
import {estimateProject} from '@/lib/rehearsal/algorithm';
import {AlgorithmNotes} from './algorithm-notes';
import {binaryRequest,EstimatePanel,RecordingList,SlideImage,LazySlideImage} from './shared';
import {GroupPlayback} from './playback';
import {ReadingExport} from './reading-export';
import {ReadingPreview} from './reading-preview';
import {PresentationDownload} from './presentation-download';
import {ScriptEditor} from './script-editor';
import {DeckImport} from './deck-import';
import {FilePicker} from './file-picker';
import {useDraft} from './use-draft';
import {draftBody} from '@/lib/rehearsal/draft-client';
import {reconcileScript,scriptText} from '@/lib/rehearsal/script-reconcile';
import {normalizeImportedScript,importParagraphCount} from '@/lib/rehearsal/import-guard';
import {saveBlob} from '@/lib/transport';
import {removeSlide,moveSlide} from '@/lib/rehearsal/editing';
import {parseMemberNames,removeMemberSafely} from '@/lib/rehearsal/members-v15';
const empty=():Project=>({id:'current',title:'新汇报',theme:'',status:'draft',publishedAt:null,revision:0,scriptVersion:'',deckVersion:'',algorithmVersion:DEFAULT_CONFIG.version,members:[],blocks:[],slides:[],config:{...DEFAULT_CONFIG},overrides:{},updatedAt:''});
export function RehearsalAdmin({configured,group=false,ownerAccess=false,onBack}:{configured:boolean;group?:boolean;ownerAccess?:boolean;onBack?:()=>void}){
 const base='/api/rehearsal/edit';
 const draft=useDraft(),project=draft.local??empty(),dirty=draft.dirty;
 const [authenticated,setAuthenticated]=useState<boolean|null>(null),[records,setRecords]=useState<Recording[]>([]),[estimate,setEstimate]=useState<Estimate|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[memberNames,setMemberNames]=useState(''),[script,setScript]=useState(''),[usage,setUsage]=useState(0);
 const [removing,setRemoving]=useState(''),[replacement,setReplacement]=useState(''),[dragSlide,setDragSlide]=useState(''),[slideUndo,setSlideUndo]=useState<Project|null>(null);
 const [preview,setPreview]=useState(false);
 const [memberMenu,setMemberMenu]=useState('');
 const [importMode,setImportMode]=useState<'file'|'paste'>('file'),[importState,setImportState]=useState('待选择'),[importInfo,setImportInfo]=useState('');
 const publication=useRef<{revision:number;id:string}|null>(null);
 async function load(){try{const r=await api(base);draft.connect(r.project||empty());setRecords(r.recordings);setEstimate(r.estimate);setUsage(r.usage?.bytes||0);setAuthenticated(true)}catch(e){setError((e as Error).message);setAuthenticated(false)}}
 useEffect(()=>{void load()},[]);
 function edit(p:Project){draft.client.current?.edit(p);setEstimate(null);setMessage('')}
 async function save(status:Project['status']='draft'){
  setError('');
  if(status==='draft')return draft.flush();
  setBusy(true);
  try {
   const saved=await draft.flush();
   if(!saved)throw new Error('请先处理未同步草稿，再发布或结束收录。');
   if(publication.current?.revision!==saved.revision)publication.current={revision:saved.revision,id:newRehearsalId()};
   if(status==='published')await api(base+'/publish',{expected_draft_revision:saved.revision,mutation_id:publication.current.id});
   else await api(base,{...draftBody(saved),status:'ended'});
   await load();publication.current=null;
   setMessage(status==='published'?'已发布当前草稿。':'已结束收录。');
  }catch(e){setError((e as Error).message)}
  finally{setBusy(false)}
 }
 async function importText(raw:string,filename='粘贴文字'){
  try{
   const p=draft.client.current?.local??project;
   const text=normalizeImportedScript(raw),result=reconcileScript(p,text);
   setImportInfo(filename+' · '+text.length+' 字符 · '+importParagraphCount(text)+' 段');
   setImportState('已解析待保存');
   if(p.blocks.length){
    const affected=p.blocks.filter(b=>b.memberId!==null||b.slideIndex!==null).length;
    if(!confirm('替换讲稿？原 '+p.blocks.length+' 片段 → 新 '+result.blocks.length+' 片段，'+affected+' 个原关联片段可能受影响。'+(result.warnings.join('；')||'能可靠匹配的分工与映射将保留')+'。历史已保存版本可恢复。'))return;
   }
   edit({...p,blocks:result.blocks,overrides:{}});
   setImportState('正在保存');
   const saved=await draft.flush();
   if(!saved||scriptText(saved.blocks)!==scriptText(result.blocks)){
    setImportState('已解析待保存');
    setError('讲稿暂存于本地，但服务器尚未确认保存；请处理冲突后再同步。');return;
   }
   setImportState('已保存到草稿');
   setMessage(result.warnings.join(' '));
  }catch(e){setImportState('失败可重试');setError((e as Error).message)}
 }
 async function textFile(file:File){
  setError('');setImportState('正在解析/转换');
  if(file.size>10*1024*1024){setImportState('失败可重试');setError('讲稿文件请控制在10MiB以内。');return;}
  try{
   let raw:string;
   if(/\.txt$/i.test(file.name))raw=await file.text();
   else if(/\.docx$/i.test(file.name)){const mammoth=await import('mammoth/mammoth.browser');raw=(await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()})).value;}
   else throw new Error('请选择 DOCX 或 TXT。');
   await importText(raw,file.name);
  }catch(e){setImportState('失败可重试');setError('提取失败，原稿未修改：'+(e as Error).message)}
 }
  async function repairSavedPreview(index:number,file:File){
  const slide=project.slides[index];
  if(!slide||!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>2*1024*1024){setError('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP。');return;}
  setBusy(true);setError('');
  try{
   const result=await binaryRequest(base+(slide.sourceId?'/preview-page':'/slides'),file,{'Content-Type':file.type,...(slide.sourceId?{'X-Rehearsal-Metadata':slide.sourceId}:{})});
   if(project.slides.some((s,i)=>i!==index&&s.id===result.id))throw new Error('替换图像与另一页身份冲突。');
   edit({...project,slides:project.slides.map((s,i)=>i===index?{...s,...result}:s)});
   if(!await draft.flush())throw new Error('此页已暂存，等待草稿同步。');
   setMessage('预览页已替换并保存。');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 async function uploadPages(files:FileList|null){if(!files?.length)return;setError('');if(dirty||project.sourceDeck){setError('请先保存草稿。已有原始 PPTX 时，请使用单页修复。');return}setBusy(true);let added:Project['slides']=[];try{
  async function page(blob:Blob){if(blob.size>2*1024*1024)throw new Error('每页图片须≤2MiB，请降低图片尺寸/画质');if(project.slides.length+added.length>=200)throw new Error('PPT最多200页');const r=await binaryRequest(base+'/slides',blob,{'Content-Type':blob.type},!group);added.push({...r,pageIndex:project.slides.length+added.length,...(project.sourceDeck?.pages[project.slides.length+added.length]?{sourcePage:project.sourceDeck.pages[project.slides.length+added.length]}:{})});setMessage('已上传 '+added.length+' 页，正在处理…')}
  for(const file of Array.from(files)){
   if(file.size>20*1024*1024)throw new Error('原始PPT文件请≤20MiB，或分批上传逐页图片');
   if(/\.pdf$/i.test(file.name)){
    const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker-5.4.624.min.mjs';
    const doc=await pdfjs.getDocument({data:await file.arrayBuffer(),isEvalSupported:false}).promise;
    try{if(doc.numPages+project.slides.length+added.length>200)throw new Error('PDF总页数超过200页');for(let i=1;i<=doc.numPages;i++){const pg=await doc.getPage(i),base=pg.getViewport({scale:1}),viewport=pg.getViewport({scale:Math.min(2,1600/base.width,1200/base.height)}),canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;await pg.render({canvas,viewport}).promise;const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PDF页面渲染失败')),'image/jpeg',.82));await page(blob);canvas.width=canvas.height=0;pg.cleanup()}}finally{await doc.destroy()}
   }else if(/\.pptx?$/i.test(file.name))throw new Error('此处用于网页预览，请将PPTX导出为PDF后上传；原始PPTX请在上方单独上传。');
   else if(['image/jpeg','image/png','image/webp'].includes(file.type))await page(file);else throw new Error('请选择PDF、PNG、JPEG或WebP');
  }
  edit({...project,slides:[...project.slides,...added],overrides:{}});setMessage('已提取 '+added.length+' 页，请预览页序并保存。');
 }catch(e){setError((e as Error).message+'。本次静态页尚未应用到草稿。')}finally{setBusy(false)}}
 const [ownerProof,setOwnerProof]=useState('');
 async function review(r:Recording,action:'lock'|'complete'|'delete'){if(action==='delete'&&!ownerProof){setError('请先在存储管理中输入管理员密码。');return}if(action==='delete'&&!confirm('删除这次误提交及全部音频块？'))return;setError('');try{await api(base+'/recordings',{id:r.id,action:action==='delete'?'delete':'review',...(action==='delete'?{password:ownerProof}:{}),...(action==='lock'?{locked:!r.locked}:action==='complete'?{complete:!r.complete}:{})});const result=await api(base+'');setRecords(result.recordings);if(!dirty)setEstimate(result.estimate)}catch(e){setError((e as Error).message)}finally{if(action==='delete')setOwnerProof('')}}
 if(authenticated===null)return <p>{group?'正在读取本汇报编排…':'正在检查现有管理员会话…'}</p>;
 if(!authenticated&&group)return <section className="panel rh-pad"><p>{error||'请先验证本汇报密码。'}<ErrorContact /></p><a href="/rehearsal">返回汇报列表</a></section>;
 if(!authenticated)return <section className="panel rh-pad"><p>项目访问已失效，请返回并重新验证。</p><button onClick={onBack}>返回</button></section>;
 return <div className="rh-root" onCompositionStart={()=>draft.setComposing(true)} onCompositionEnd={()=>draft.setComposing(false)}><div className="page-heading"><div><p className="eyebrow">REHEARSAL STUDIO / ADMIN</p><h1>{project.title}</h1></div><div className="rh-actions">{onBack&&<button className="text-link" onClick={()=>{if(window.dispatchEvent(new Event('studio:leave-editor',{cancelable:true})))onBack()}}>{group?'返回练习':'返回汇报列表'}</button>}<a href="/rehearsal" className="text-link">打开组员页面 ↗</a></div></div><p>上传讲稿 → 网页划分文字 → 关联PPT → 自动测算 → 发布 → 收录音 → 全组回放</p><div className="rh-toolbar"><span>版本 r{draft.current?.base.revision} · {draft.label}</span><button className="btn secondary" disabled={busy||draft.composing||draft.state==='conflict'} onClick={()=>void save()}>立即同步</button><button className="btn" disabled={busy} onClick={()=>void save('published')}>检查并发布</button><button disabled={busy} onClick={()=>void save('ended')}>结束收录</button></div>{error&&<p className="callout error" role="alert">{error}<ErrorContact /></p>}{message&&<p className="callout" role="status">{message}</p>}
 <div className="rh-grid">
  <section className="panel rh-pad"><h2>朗读版 PDF</h2><ReadingExport group={group} project={draft.current?.base??project} dirty={dirty} busy={busy} onBusy={setBusy}/><details onToggle={e=>setPreview(e.currentTarget.open)}><summary>预览已保存稿件</summary>{preview&&draft.current?.base&&<ReadingPreview project={draft.current.base}/>}</details></section>
  <PresentationDownload project={draft.current?.base??project} editing dirty={dirty}/>
 </div>
 <label><input type="checkbox" checked={draft.backupEnabled} onChange={e=>draft.setBackupEnabled(e.target.checked)}/>在本机临时保存未同步草稿（72 小时）</label>
 {draft.storageError&&<p role="status">{draft.storageError}<ErrorContact /></p>}
 {draft.state&&(draft.leaveWarning||['offline','conflict','auth','error'].includes(draft.state))&&<div className="callout" role="status">
  <p>{draft.leaveWarning?'离开前请选择同步、导出或放弃未同步草稿。':draft.label+'。'+(draft.current?.detail??'')}</p>
  {draft.leaveWarning&&<div className="rh-actions"><button disabled={draft.state==='conflict'||draft.composing} onClick={()=>void draft.flush()}>同步草稿</button><button disabled={draft.state==='saving'} onClick={()=>{if(confirm('放弃本地未同步修改？'))draft.current?.discard()}}>放弃未同步修改</button></div>}
  <button onClick={()=>void saveBlob(new Blob([JSON.stringify(draftBody(project),null,2)],{type:'application/json'}),'未同步草稿.json')}>导出本地草稿</button>
  {draft.state==='conflict'&&<div className="rh-actions">
   <button onClick={()=>{if(confirm('以本地草稿覆盖当前服务器草稿？'))void draft.current?.resolve(true)}}>使用我的草稿</button>
   <button onClick={()=>{if(confirm('放弃本地修改，采用服务器草稿？'))void draft.current?.resolve(false)}}>使用服务器草稿</button>
  </div>}
 </div>}
 {draft.backups.map(row=><div className="callout" key={row.key}><p>发现未同步副本 · {new Date(row.updated).toLocaleString()}</p>
  <button disabled={dirty} onClick={()=>draft.restore(row)}>与当前版本核对并恢复</button>
  <button onClick={()=>{if(confirm('删除这份本地副本？'))draft.discard(row)}}>删除副本</button>
 </div>)}
 <fieldset disabled={busy} className="rh-admin-fields"><section className="panel rh-pad"><h2>1 / 汇报与组员</h2><div className="rh-grid"><label>汇报标题<input value={project.title} onChange={e=>edit({...project,title:e.target.value})}/></label></div><div className="rh-grid"><label>规定上限（分钟，1—180）<input type="number" min={1} max={180} step={.5} value={project.config.hardLimitSeconds/60} onChange={e=>{const hard=Math.round(+e.target.value*60);edit({...project,config:{...project.config,hardLimitSeconds:hard,planningSeconds:project.config.planningSeconds===project.config.hardLimitSeconds?hard:Math.min(project.config.planningSeconds,hard)}})}}/></label><label>提前完成目标（分钟，可留空）<input type="number" min={1} max={project.config.hardLimitSeconds/60} step={.5} placeholder="未填则使用规定上限" value={project.config.planningSeconds===project.config.hardLimitSeconds?'':project.config.planningSeconds/60} onChange={e=>edit({...project,config:{...project.config,planningSeconds:e.target.value?Math.round(+e.target.value*60):project.config.hardLimitSeconds}})}/></label></div>
  <label>批量添加组员（换行、逗号、顿号或分号分隔）<textarea value={memberNames} onChange={e=>setMemberNames(e.target.value)}/></label>
  {memberNames.trim()&&<p className="muted">待添加：{parseMemberNames(memberNames,project.members.map(m=>m.name)).names.join('、')||'无'}{parseMemberNames(memberNames,project.members.map(m=>m.name)).duplicates.length?' · 重名已跳过：'+parseMemberNames(memberNames,project.members.map(m=>m.name)).duplicates.join('、'):''}</p>}
  <button type="button" disabled={!parseMemberNames(memberNames,project.members.map(m=>m.name)).names.length} onClick={()=>{
   const {names,duplicates}=parseMemberNames(memberNames,project.members.map(m=>m.name));
   if(!names.length)return;
   edit({...project,members:[...project.members,...names.map(name=>({id:newRehearsalId(),name,enabled:true}))]});
   setMemberNames('');setMessage('已添加 '+names.length+' 名组员。'+(duplicates.length?'跳过重复：'+duplicates.join('、'):''));
  }}>添加到小组名册</button>
  <div className="rh-member-list">{project.members.map(m=><div key={m.id} className="rh-member-item" onContextMenu={e=>{e.preventDefault();setMemberMenu(m.id)}}>
   <label><input type="checkbox" checked={m.enabled} onChange={e=>edit({...project,members:project.members.map(x=>x.id===m.id?{...x,enabled:e.target.checked}:x)})}/>{m.name}{!m.enabled?' · 已停用':''}</label>
   <button type="button" aria-label={'更多组员操作：'+m.name} aria-expanded={memberMenu===m.id} onClick={()=>setMemberMenu(memberMenu===m.id?'':m.id)}>···</button>
   {memberMenu===m.id&&<div className="rh-member-menu" role="menu"><button type="button" role="menuitem" onClick={()=>{
    const hasAssignments=project.blocks.some(b=>b.memberId===m.id);
    const hasRecordings=records.some(r=>r.memberId===m.id);
    const historic=project.status!=='draft'||!!project.publishedAt;
    if(!confirm('从小组名册移除“'+m.name+'”？'+(hasAssignments?'当前讲稿含此成员分工；':'')+(hasRecordings?'现有录音仍保留；':'')+(historic?'历史发布可能引用此人，采用停用而非删除；':'')+'如需更改朗读人，请先重新分工。'))return;
    try{edit(removeMemberSafely(project,m.id,records));setMemberMenu('');setMessage('名册已更新；历史引用已保留。')}catch(e){setError((e as Error).message)}
   }}>从小组移除</button><button type="button" onClick={()=>setMemberMenu('')}>取消</button></div>}
  </div>)}</div>
  <p>发言顺序由下方稿件片段顺序确定；A→B→A 会生成三个轮次。每个发言轮次分别保留最近三条录音，其他轮次的录音不会被挤掉。</p></section>
 <section className="panel rh-pad rh-document-import"><h2>2 / 讲稿导入</h2>
  <div className="rh-actions" role="group" aria-label="讲稿导入方式">
   <button type="button" aria-pressed={importMode==='file'} onClick={()=>{setImportMode('file');setImportState('待选择');setImportInfo('')}}>上传 DOCX/TXT</button>
   <button type="button" aria-pressed={importMode==='paste'} onClick={()=>{setImportMode('paste');setImportState('待选择');setImportInfo('')}}>直接粘贴文字</button>
  </div>
  {importMode==='file'?<FilePicker label="选择讲稿文件" hint="DOCX 或 TXT（不超过 10 MiB）" accept=".docx,.txt" onFiles={files=>{if(files?.[0])void textFile(files[0])}}/>
    :<><label>原稿文字<textarea rows={5} value={script} onChange={e=>setScript(e.target.value)}/></label><button type="button" disabled={!script.trim()} onClick={()=>void importText(script)}>提取自然段</button></>}
  <p role="status" className="rh-import-feedback"><strong>{importState}</strong>{importInfo&&' · '+importInfo}</p><p className="muted">替换前会提示关联影响；保存草稿不等于发布。</p>
 </section>
 </fieldset>
 <DeckImport project={project} disabled={dirty||busy||draft.composing} onActivity={setBusy} onApply={async next=>{
  const session=draft.client.current;
  if(!session||session.dirty||session.base.revision!==next.revision)throw new Error('草稿已变化，请先同步再应用。');
  edit(next);
  const saved=await draft.flush();
  if(!saved||saved.sourceDeck?.id!==next.sourceDeck?.id||saved.slides.length!==next.slides.length||
    saved.slides.some((slide,i)=>slide.id!==next.slides[i].id))return false;
  void api(base+'/capacity').then(r=>setUsage(r.projectUsed)).catch(()=>{});
  return true;
 }}/>
 <fieldset disabled={busy} className="rh-admin-fields">
 <section className="panel rh-pad"><h2>已保存的静态页面</h2><p className="muted">拖拽手柄调整页序；键盘、手机可用前移/后移按钮。重排不改变关联的幻灯片身份。</p>{slideUndo&&<button type="button" onClick={()=>{edit(slideUndo);setSlideUndo(null)}}>撤销上次重排</button>}
 {!project.sourceDeck&&<details><summary>高级导入静态 PDF 或图片</summary>
 <FilePicker label="选择 PDF 或图片" hint="PDF / PNG / JPEG / WebP" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" onFiles={files=>void uploadPages(files)}/>
 </details>}
 <div className="rh-thumbnails">{project.slides.map((s,i)=><div key={s.id} className={dragSlide===s.id?"rh-sort-dragging":""} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(dragSlide&&dragSlide!==s.id){try{setSlideUndo(project);edit(moveSlide(project,dragSlide,i))}catch(err){setError((err as Error).message)}}setDragSlide("")}}><LazySlideImage id={s.id} admin={false} alt={'第'+(i+1)+'页'}/><div className="rh-actions"><strong>{i+1}</strong>{project.sourceDeck&&!s.sourceId&&<label>原PPT页<select aria-label={'预览第'+(i+1)+'页对应原PPT页'} value={s.sourcePage||''} onChange={e=>edit({...project,slides:project.slides.map(x=>x.id===s.id?{...x,sourcePage:e.target.value||undefined}:x)})}><option value="">未关联</option>{project.sourceDeck.pages.map((path,j)=><option key={path} value={path}>第{j+1}页</option>)}</select></label>}<button type="button" draggable aria-label={'拖动第'+(i+1)+'页排序'} onDragStart={e=>{e.dataTransfer.effectAllowed='move';setDragSlide(s.id)}} onDragEnd={()=>setDragSlide('')}>⠿ 拖动</button><button type="button" disabled={i===0} onClick={()=>{setSlideUndo(project);edit(moveSlide(project,s.id,i-1))}}>前移</button><button type="button" disabled={i===project.slides.length-1} onClick={()=>{setSlideUndo(project);edit(moveSlide(project,s.id,i+1))}}>后移</button><button type="button" onClick={()=>{setRemoving(s.id);setReplacement('')}}>移除</button><details><summary>更多 · 高级修复</summary><p className="muted">仅替换网页静态预览图，不修改原始 PPTX。</p><FilePicker label={'替换第'+(i+1)+'页预览图'} hint="PNG / JPEG / WebP（不超过 2 MiB）" accept="image/png,image/jpeg,image/webp" disabled={dirty} onFiles={files=>{if(files?.[0])void repairSavedPreview(i,files[0])}}/></details></div></div>)}</div></section>
 <ScriptEditor project={project} onChange={edit}/>
 <section className="panel rh-pad"><h2>自动发言时间测算</h2>
  <p>依据当前讲稿与总汇报时长估算各人的发言时间；无需逐轮手动设定。</p>
  {Object.keys(project.overrides).length>0&&<div className="callout" role="status"><p>此项目保留 {Object.keys(project.overrides).length} 条历史手动目标；在恢复自动测算前，这些目标仍会参与计算。</p>
   <button type="button" onClick={()=>{if(confirm('撤销当前草稿中的历史手动目标？已发布的历史版本和录音不受影响。'))edit({...project,overrides:{}})}}>恢复自动测算</button></div>}
  <button type="button" onClick={()=>{try{setEstimate(estimateProject(project,records));setMessage('已根据当前草稿重算；正式发布时服务器会再次计算。')}catch(e){setError((e as Error).message)}}}>重新计算预计用时</button>
 </section></fieldset>
 {removing&&<div className="rh-dialog-backdrop"><div className="panel rh-dialog" role="dialog" aria-modal="true" aria-labelledby="rh-remove-title"><h2 id="rh-remove-title">删除PPT页并调整映射</h2><p>删除第{project.slides.findIndex(s=>s.id===removing)+1}页。其他页面的讲稿关联会自动保留并更新页码。</p><p>被删页关联 {project.blocks.filter(b=>b.slideIndex!==null&&project.slides[b.slideIndex]?.id===removing).length} 个片段。</p><label>将这些片段整批迁移到<select aria-label="删除页的替代页" value={replacement} onChange={e=>setReplacement(e.target.value)}><option value="">请选择替代页</option>{project.slides.filter(s=>s.id!==removing).map(s=><option key={s.id} value={s.id}>原第{project.slides.findIndex(x=>x.id===s.id)+1}页</option>)}</select></label>{project.slides.length<2&&<p>如该页关联了文字，请先添加替代页。</p>}<div className="rh-actions"><button className="btn" disabled={busy} onClick={()=>{try{edit(removeSlide(project,removing,replacement));setRemoving('')}catch(e){setError((e as Error).message)}}}>删除并调整映射</button><button onClick={()=>setRemoving('')}>取消</button></div>{error&&<p role="alert">{error}<ErrorContact /></p>}</div></div>}
 {estimate&&<EstimatePanel estimate={estimate} project={project} recordings={records}/>}<RecordingList project={project} recordings={records} admin={false} onReview={ownerAccess?(r,a)=>void review(r,a):undefined}/><GroupPlayback project={project} recordings={records} admin={false}/>{ownerAccess&&<section className="panel rh-pad"><h2>存储管理</h2><p>本汇报占用 {(usage/1024/1024).toFixed(2)}MiB；所有汇报共享180MiB存储空间。</p><label>清理文件或删除录音前，请输入管理员密码<input type="password" autoComplete="current-password" value={ownerProof} onChange={e=>setOwnerProof(e.target.value)}/></label><button disabled={dirty||busy||!ownerProof} onClick={async()=>{try{const r=await api(base+'/cleanup',{password:ownerProof});setMessage('已清理 '+r.removed+' 个无当前稿件或保留录音引用的PPT资源。')}catch(e){setError((e as Error).message)}finally{setOwnerProof('')}}}>清理无引用页面</button></section>}<AlgorithmNotes config={project.config} updatedAt={project.updatedAt}/>
 </div>;
}
