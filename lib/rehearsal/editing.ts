import type {Project,Block} from './model';
import {newRehearsalId} from './model';

export function removeSlide(p:Project,id:string,replacementId?:string):Project{
 if(!p.slides.some(s=>s.id===id))throw new Error('PPT页不存在');
 const affected=p.blocks.some(b=>b.slideIndex!==null&&p.slides[b.slideIndex]?.id===id);
 const slides=p.slides.filter(s=>s.id!==id).map((s,pageIndex)=>({...s,pageIndex}));
 if(affected&&!slides.some(s=>s.id===replacementId))throw new Error('请为被删页关联的文字选择一张有效替代页。');
 return {...p,slides,blocks:p.blocks.map(b=>{
  if(b.slideIndex===null)return b;
  const old=p.slides[b.slideIndex]?.id,target=old===id?replacementId:old,index=slides.findIndex(s=>s.id===target);
  return {...b,slideIndex:index<0?null:index};
 }),overrides:{}};
}
export function scriptSpans(blocks:Block[]){
 let offset=0;return blocks.map((block,i)=>{const separator=i&&blocks[i-1].paragraphId!==block.paragraphId?'\n\n':'';offset+=separator.length;const start=offset;offset+=block.text.length;return {block,separator,start,end:offset}});
}
export function paintRange(p:Project,start:number,end:number,patch:Partial<Block>,id=newRehearsalId):Project{
 if(start<0||end<=start) return p;
 let changed=false;const blocks:Block[]=[];
 for(const span of scriptSpans(p.blocks)){
  const b=span.block,a=Math.max(0,start-span.start),z=Math.min(b.text.length,end-span.start);
  if(z<=a||b.nonspoken||Object.entries(patch).every(([k,v])=>(b as any)[k]===v)){blocks.push(b);continue}
  if((a>0||z<b.text.length)&&(b.manualSpeechSeconds!==undefined||b.spokenText!==undefined))throw new Error('所选文字包含设有独立估时或读法覆盖的片段。请选中该完整片段，或先调整其特殊读法设置。');
  changed=true;
  const ranges=[[0,a],[a,z],[z,b.text.length]].filter(([from,to])=>to>from);
  ranges.forEach(([from,to],i)=>blocks.push({...b,id:i===0?b.id:id(),text:b.text.slice(from,to),sourceStart:(b.sourceStart||0)+from,sourceEnd:(b.sourceStart||0)+to,...(from===a?patch:{}),paragraphEnd:to===b.text.length?b.paragraphEnd:false,actionId:b.actionId||b.id,...(i>0?{chartAction:false,formulaAction:false,extraSeconds:0}: {}),longPause:to===b.text.length?b.longPause:0}));
 }
 const merged=mergeFragments(blocks);
 if(merged.length>500)throw new Error('片段已达到500个，请合并相邻片段后再分工。');
 return changed?{...p,blocks:merged,overrides:{}}:p;
}

export function assignScriptRange(p:Project,start:number,end:number,memberId:string,id=newRehearsalId){if(!p.members.some(m=>m.id===memberId&&m.enabled))throw new Error('请选择有效朗读人。');return paintRange(p,start,end,{memberId},id)}
export function assignSlideRange(p:Project,start:number,end:number,slideIndex:number,id=newRehearsalId){if(!Number.isInteger(slideIndex)||!p.slides[slideIndex])throw new Error('请选择有效PPT页。');return paintRange(p,start,end,{slideIndex},id)}

/** Coalesce only adjacent fragments whose spoken behavior is unchanged. */
export function mergeFragments(blocks: Block[]): Block[] {
 const result: Block[] = [];
 for (const block of blocks) {
  const previous = result.at(-1);
  const sameSpellings = JSON.stringify(previous?.spellOut ?? []) === JSON.stringify(block.spellOut ?? []);
  const hasCue = (b: Block) => Boolean(b.chartAction || b.formulaAction || b.extraSeconds);
  if (previous && previous.paragraphId === block.paragraphId && !previous.paragraphEnd &&
      previous.memberId === block.memberId && previous.slideIndex === block.slideIndex &&
      previous.nonspoken === block.nonspoken && previous.text.length + block.text.length <= 20000 &&
      previous.spokenText === undefined && block.spokenText === undefined &&
      previous.manualSpeechSeconds === undefined && block.manualSpeechSeconds === undefined &&
      !previous.longPause && !hasCue(previous) && !hasCue(block) && sameSpellings) {
   result[result.length - 1] = {...previous, text: previous.text + block.text,
    sourceEnd: block.sourceEnd, paragraphEnd: block.paragraphEnd, longPause: block.longPause};
  } else result.push(block);
 }
 return result;
}

/** Move by stable slide ID; block links are resolved against the original order. */
export function moveSlide(p:Project,slideId:string,to:number):Project{
 const from=p.slides.findIndex(s=>s.id===slideId);
 if(from<0||!Number.isInteger(to)||to<0||to>=p.slides.length)throw new Error('无效的幻灯片排序位置');
 if(from===to)return p;
 const slides=[...p.slides],moving=slides.splice(from,1)[0];
 slides.splice(to,0,moving);
 const byId=new Map(slides.map((s,index)=>[s.id,index]));
 return {...p,slides:slides.map((s,pageIndex)=>({...s,pageIndex})),blocks:p.blocks.map(b=>{
  if(b.slideIndex===null)return b;
  const original=p.slides[b.slideIndex];
  if(!original)throw new Error('存在无效的旧幻灯片关联，已停止重排。');
  return {...b,slideIndex:byId.get(original.id)!};
 })};
}
