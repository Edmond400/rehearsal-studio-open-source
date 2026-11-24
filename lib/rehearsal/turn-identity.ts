import {type Project,type SlideEvent,turnsFor} from './model';

export type SlideRef={id:string;hash:string;sourcePage:string|null};
export type ReleaseTurn={uid:string;ordinal:number;memberId:string;legacyTurnId:string;blockIds:string[];fingerprint:string;slides:SlideRef[]};
export type FileHashes=ReadonlyMap<string,string>;

export async function fingerprint(value:unknown){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function slideRef(project:Project,index:number,hashes:FileHashes):SlideRef|null{
 const slide=project.slides[index],hash=slide&&hashes.get(slide.id);
 if(!slide||!hash||!/^[a-f0-9]{64}$/.test(hash))return null;
 return {id:slide.id,hash,sourcePage:slide.sourceId?'slide-id:'+slide.sourceId:slide.sourcePage??null};
}
type Candidate=Omit<ReleaseTurn,'uid'>;
async function candidates(project:Project,hashes:FileHashes):Promise<Candidate[]>{
 const indexes=new Map(project.blocks.map((b,i)=>[b.id,i]));
 return Promise.all(turnsFor(project).map(async (turn,ordinal)=>{
  let spoken='',previousSlide:string|undefined;
  const slides:SlideRef[]=[],transitions:{at:number;slide:SlideRef|null}[]=[],reading:{at:number;[key:string]:unknown}[]=[];
  const spellRanges: {start:number;end:number;words:string}[]=[];
  // The player groups spoken fragments by member. A brush can isolate an
  // adjacent blank fragment, but its original whitespace still joins the words.
  const spokenIndexes=new Set<number>();
  for(const blockId of turn.blockIds){
   const i=indexes.get(blockId)!,anchor=project.blocks[i];
   spokenIndexes.add(i);
   for(const step of [-1,1]){
    for(let n=i+step;n>=0&&n<project.blocks.length;n+=step){
     const b=project.blocks[n];
     if(b.text.trim()||b.nonspoken||b.memberId!==anchor.memberId||b.paragraphId!==anchor.paragraphId||b.slideIndex!==anchor.slideIndex)break;
     spokenIndexes.add(n);
    }
   }
  }
  for(const index of [...spokenIndexes].sort((a,b)=>a-b)){
   const b=project.blocks[index];
   const ref=b.slideIndex===null?null:slideRef(project,b.slideIndex,hashes);
   if(b.slideIndex!==null&&!ref)throw new Error('Referenced slide identity or hash is unavailable');
   const slideKey=JSON.stringify(ref);
   if(slideKey!==previousSlide){transitions.push({at:spoken.length,slide:ref});if(ref)slides.push(ref);previousSlide=slideKey}
   const start=spoken.length;
   spoken+=(b.spokenText??b.text).replace(/\r\n?/g,'\n');
   if (b.spellOut?.length) {
    const words=JSON.stringify([...new Set(b.spellOut.map(word=>word.toLowerCase()))].sort());
    const previous=spellRanges.at(-1);
    if (previous?.end===start && previous.words===words) previous.end=spoken.length;
    else spellRanges.push({start,end:spoken.length,words});
   }
   if (b.paragraphEnd || b.longPause) reading.push({at:spoken.length,paragraphEnd:b.paragraphEnd,longPause:b.longPause??0});
   if (b.chartAction || b.formulaAction) reading.push({at:start,chart:!!b.chartAction,formula:!!b.formulaAction});
  }
  reading.sort((a,b)=>a.at-b.at || Number('chart' in a)-Number('chart' in b));
  return {ordinal,memberId:turn.memberId,legacyTurnId:turn.id,blockIds:turn.blockIds,slides,
   fingerprint:await fingerprint(['turn-v2',turn.memberId,spoken,transitions,reading,spellRanges])};
 }));
}

export async function identifyReleaseTurns(project:Project,hashes:FileHashes,previous:ReleaseTurn[]=[],newUid:(ordinal:number)=>string|Promise<string>=()=>crypto.randomUUID()):Promise<ReleaseTurn[]>{
 const current=await candidates(project,hashes);
 const priorByBlock=new Map(previous.flatMap(t=>t.blockIds.map(b=>[b,t.uid] as const)));
 const oldByUid=new Map(previous.map(t=>[t.uid,t]));
 const overlap=current.map(t=>new Set(t.blockIds.flatMap(b=>priorByBlock.get(b)??[])));
 const usage=new Map<string,number>();
 for(const set of overlap)for(const uid of set)usage.set(uid,(usage.get(uid)??0)+1);
 const uidFor=(next:Candidate,i:number)=>{
  if(overlap[i].size===1){
   const uid=[...overlap[i]][0];
   if(usage.get(uid)===1&&oldByUid.get(uid)?.memberId===next.memberId)return uid;
  }
  if(overlap[i].size)return undefined;
  // When all block IDs have changed, only a unique exact fingerprint may
  // recover the prior identity. Repeated equal turns remain distinct.
  const hits=previous.filter(t=>t.memberId===next.memberId&&t.fingerprint===next.fingerprint);
  if(hits.length===1&&!usage.has(hits[0].uid)&&current.filter(t=>t.fingerprint===next.fingerprint).length===1)return hits[0].uid;
 };
 return Promise.all(current.map(async (t,i)=>({...t,uid:uidFor(t,i)??await newUid(i)})));
}

export function sameTurnContent(a:ReleaseTurn,b:ReleaseTurn){
 return a.uid===b.uid&&a.memberId===b.memberId&&a.fingerprint===b.fingerprint;
}
export function remapRecordedEvents(events:readonly SlideEvent[],from:Project,to:Project,hashes:FileHashes):SlideEvent[]|null{
 if(!from.slides.length&&!to.slides.length)return events.map(e=>({...e}));
 const target=new Map<string,number>();
 for(let i=0;i<to.slides.length;i++){
  const ref=slideRef(to,i,hashes);
  if(ref)target.set(JSON.stringify(ref),i);
 }
 const mapped:SlideEvent[]=[];
 for(const event of events){
  const ref=slideRef(from,event.slide_index,hashes);
  if(!ref)return null;
  const index=target.get(JSON.stringify(ref));
  if(index===undefined)return null;
  mapped.push({...event,slide_index:index});
 }
 return mapped;
}
