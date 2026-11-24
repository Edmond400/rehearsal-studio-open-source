'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState,Fragment} from 'react';
import type {Project,Slide} from '@/lib/rehearsal/model';
import {assignScriptRange,assignSlideRange,scriptSpans} from '@/lib/rehearsal/editing';
import {readingColors} from '@/lib/rehearsal/reading-document';
import {SlideImage} from './shared';

function LazyThumbnail({slide,index,selected,onSelect}:{slide:Slide;index:number;selected:boolean;onSelect:()=>void}){
 const outer=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(false);
 useEffect(()=>{
  const node=outer.current;if(!node)return;
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'300px'});
  observer.observe(node);return()=>observer.disconnect();
 },[slide.id]);
 return <div ref={outer} className="rh-slide-thumb" data-slide-id={slide.id}>
  <button type="button" aria-pressed={selected} onClick={onSelect} aria-label={'查看PPT第'+(index+1)+'页'}>
   <span className="rh-slide-thumb-image">{visible?<SlideImage id={slide.id} alt={'PPT第'+(index+1)+'页'} />:<span>预览尚未加载</span>}</span>
   <span>第 {index+1} 页</span>
  </button>
 </div>;
}
export function FullScriptAssignment({project,onChange}:{project:Project;onChange:(p:Project)=>void}){
 const [mode,setMode]=useState<'view'|'speaker'|'slide'>('view'),[slideBrush,setSlideBrush]=useState('');
 const [selectedSlide,setSelectedSlide]=useState(''),[brush,setBrush]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState('');
 const area=useRef<HTMLDivElement>(null),thumbs=useRef<HTMLDivElement>(null),colors=readingColors(project.members);
 const chosen=project.slides.findIndex(s=>s.id===selectedSlide);
 useEffect(()=>{
  if(!selectedSlide)return;
  const target=Array.from(thumbs.current?.querySelectorAll<HTMLElement>('.rh-slide-thumb')||[]).find(e=>e.dataset.slideId===selectedSlide);
  target?.scrollIntoView({behavior:'smooth',block:'nearest'});
 },[selectedSlide,mode]);
 function selectSlide(id:string){
  setSelectedSlide(id);
  if(mode==='slide')setSlideBrush(id);
  if(mode==='view'){
   const slideIndex=project.slides.findIndex(s=>s.id===id);
   const block=project.blocks.find(b=>b.slideIndex===slideIndex);
   if(block){const target=Array.from(area.current?.querySelectorAll<HTMLElement>('[data-block-id]')||[]).find(n=>n.dataset.blockId===block.id);target?.scrollIntoView({behavior:'smooth',block:'nearest'});}
  }
 }
 function apply(){
  if(mode==='view')return;
  const container=area.current,s=window.getSelection();if(!(mode==='speaker'?brush:slideBrush)||!container||!s||s.isCollapsed||!s.rangeCount)return;
  const range=s.getRangeAt(0);if(!container.contains(range.startContainer)||!container.contains(range.endContainer))return;
  const before=range.cloneRange();before.selectNodeContents(container);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length;
  const through=range.cloneRange();through.selectNodeContents(container);through.setEnd(range.endContainer,range.endOffset);const end=through.toString().length;
  try{
   const next=mode==='speaker'?assignScriptRange(project,start,end,brush):assignSlideRange(project,start,end,project.slides.findIndex(s=>s.id===slideBrush));
   if(next!==project){onChange(next);setMessage(mode==='speaker'?'已分配演讲人，PPT关联保持不变。':'已关联到PPT第'+(project.slides.findIndex(s=>s.id===slideBrush)+1)+'页，演讲人分配保持不变。')}
   setError('');
  }catch(e){setError((e as Error).message)}
  finally{s.removeAllRanges()}
 }
 return <section className="rh-full-assignment"><h3>全文分工与 PPT 关联</h3>
  <div className="rh-actions" role="group" aria-label="编排模式">
   <button type="button" aria-pressed={mode==='view'} onClick={()=>setMode('view')}>查看关联</button>
   <button type="button" aria-pressed={mode==='speaker'} onClick={()=>setMode('speaker')}>分配演讲人</button>
   <button type="button" aria-pressed={mode==='slide'} onClick={()=>setMode('slide')}>关联 PPT</button>
  </div>
  <div className="rh-mapping-workspace">
   <aside className="rh-mapping-thumbs" aria-label="PPT页面" ref={thumbs}>
    {project.slides.map((slide,i)=><LazyThumbnail key={slide.id} slide={slide} index={i} selected={selectedSlide===slide.id} onSelect={()=>selectSlide(slide.id)}/>)}
    {!project.slides.length&&<p>请先导入 PPTX。</p>}
   </aside>
   <div className="rh-mapping-main">
    {mode!=='view'&&<div className="rh-brush-toolbar" role="toolbar" aria-label="全文格式刷">
     {mode==='slide'?project.slides.map((s,i)=><button type="button" key={s.id} aria-pressed={slideBrush===s.id} onClick={()=>{setSlideBrush(s.id);setSelectedSlide(s.id)}}>PPT第{i+1}页</button>):project.members.filter(m=>m.enabled).map(m=><button type="button" key={m.id} aria-pressed={brush===m.id} style={{color:colors.get(m.id),borderColor:brush===m.id?colors.get(m.id):undefined}} onClick={()=>{setBrush(m.id);window.getSelection()?.removeAllRanges()}}>{m.name}</button>)}
     <button type="button" onClick={()=>{setBrush('');setSlideBrush('')}}>退出刷选</button>
     <strong>{mode==='speaker'?(brush?'当前演讲人：'+project.members.find(m=>m.id===brush)?.name:'选择演讲人后拖选讲稿'):(slideBrush?'当前 PPT：第'+(project.slides.findIndex(s=>s.id===slideBrush)+1)+'页':'选择 PPT 页后拖选讲稿')}</strong>
    </div>}
    <p className="muted">{mode==='view'?'点击 PPT 高亮所有关联片段；点击讲稿片段定位对应 PPT。查看不会修改草稿。':'选择目标后在正文中拖选文字，松开即可分配。演讲人和 PPT 映射分别独立保留。'}</p>
    <div ref={area} tabIndex={0} aria-label="全文分工区域" className={'rh-full-script '+(mode!=='view'?'brushing':'')} onMouseUp={apply} onTouchEnd={()=>{if(mode!=='view')setTimeout(apply,0)}} onKeyUp={e=>{if(e.key==='Enter')apply();if(e.key==='Escape'){setBrush('');setSlideBrush('')}}}>
     {scriptSpans(project.blocks).map(({block:b,separator})=><Fragment key={b.id}>{separator}<span data-block-id={b.id} data-mapping={(b.memberId?project.members.find(m=>m.id===b.memberId)?.name||'未知演讲人':'待分配演讲人')+' · '+(b.slideIndex===null?'PPT 待关联':'PPT 第'+(b.slideIndex+1)+'页')} onClick={()=>{if(mode==='view'&&b.slideIndex!==null){const s=project.slides[b.slideIndex];if(s)selectSlide(s.id)}}} className={(mode==='view'&&chosen>=0&&b.slideIndex===chosen?'rh-linked-active ':'')+'rh-mapping-segment'} title={(b.slideIndex===null?'未关联PPT':'PPT第'+(b.slideIndex+1)+'页')+' · '+(b.nonspoken?'不需朗读':project.members.find(m=>m.id===b.memberId)?.name||'未分配')} style={{color:b.nonspoken?'#8c8691':b.memberId?colors.get(b.memberId):'#443e49',background:b.nonspoken?'#f0edf2':undefined}}>{b.text}</span></Fragment>)}
    </div>
   </div>
  </div>
  {message&&<p role="status">{message}</p>}{error&&<p role="alert" className="callout error">{error}<ErrorContact /></p>}
 </section>;
}
