import type {Project,Slide} from './model';

export function slideReplacementPlan(project:Project,sourceDeckId:string,newSlides:Slide[]) {
 const automatic=new Map<string,number>();
 for(const old of project.slides){
  const sameFile=newSlides.findIndex(s=>s.id===old.id);
  const sameSource=project.sourceDeck?.id===sourceDeckId&&old.sourcePage
   ?newSlides.findIndex(s=>s.sourcePage===old.sourcePage):-1;
  const index=sameFile>=0?sameFile:sameSource;
  if(index>=0)automatic.set(old.id,index);
 }
 const unresolved=[...new Set(project.blocks.flatMap(block=>{
  const old=block.slideIndex===null?undefined:project.slides[block.slideIndex];
  return old&&!automatic.has(old.id)?[old.id]:[];
 }))];
 return {automatic,unresolved};
}
export function replaceDeck(project:Project,sourceDeck:NonNullable<Project['sourceDeck']>,slides:Slide[],manual:Record<string,number>){
 const {automatic,unresolved}=slideReplacementPlan(project,sourceDeck.id,slides);
 for(const id of unresolved){
  const index=manual[id];
  if(!Number.isInteger(index)||!slides[index])throw new Error('请逐一确认原讲稿所关联页面的替代页。');
  automatic.set(id,index);
 }
 return {...project,sourceDeck,slides,blocks:project.blocks.map(block=>{
  if(block.slideIndex===null)return block;
  const old=project.slides[block.slideIndex];
  return {...block,slideIndex:old?automatic.get(old.id)??null:null};
 })};
}
