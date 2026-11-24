import {type Block,type Project,type Slide,type SlideEvent} from './model';
import {validateEvents} from './timeline';
import {fingerprint,identifyReleaseTurns,type FileHashes,type ReleaseTurn} from './turn-identity';

export type LegacyRecording={
 id:string;memberId:string;turnId:string;scriptVersion:string;deckVersion:string;algorithmVersion:string;
 durationMs:number;events:SlideEvent[];snapshot:{blocks?:Block[];slides?:Slide[]};
};
export type LegacyRelease={id:string;number:number;project:Project;turns:ReleaseTurn[]};
export type LegacyReference={recordingId:string;releaseId:string;turnUid:string};
const pair=(p:Pick<Project,'scriptVersion'|'deckVersion'|'algorithmVersion'>)=>JSON.stringify([p.scriptVersion,p.deckVersion,p.algorithmVersion]);

/**
 * Read-only import planner. No deletions; a legacy audio record is attached
 * only to a single demonstrable origin. E3 owns transactional backfill,
 * new upload retention and promotion of the planned head.
 */
export async function planLegacyReleases(id:string,published:Project|null,history:Project[],recordings:LegacyRecording[],hashes:FileHashes){
 const versions=new Map<number,Project>(),ambiguous=new Set<number>();
 for(const p of [...history,...(published?[published]:[])]){
  if(p.id!==id||!['published','ended'].includes(p.status)||!Number.isInteger(p.revision)||p.revision<0)continue;
  const normalized={...p,status:'published' as const};
  const prior=versions.get(p.revision);
  if(prior&&JSON.stringify(prior)!==JSON.stringify(normalized))ambiguous.add(p.revision);
  else versions.set(p.revision,normalized);
 }
 const releases:LegacyRelease[]=[],skippedRevisions=[...ambiguous],refs:LegacyReference[]=[],unresolved:string[]=[];
 for(const p of [...versions.values()].sort((a,b)=>a.revision-b.revision)){
  if(ambiguous.has(p.revision))continue;
  const releaseId='legacy-'+(await fingerprint([id,p.revision,pair(p)])).slice(0,40);
  try{
   const turns=await identifyReleaseTurns(p,hashes,releases.at(-1)?.turns,async ordinal=>'turn-'+(await fingerprint([releaseId,ordinal])).slice(0,40));
   releases.push({id:releaseId,number:releases.length+1,project:p,turns});
  }catch{skippedRevisions.push(p.revision)}
 }
 for(const r of recordings){
  const matches:LegacyReference[]=[];
  for(const release of releases){
   if(pair(release.project)!==pair(r))continue;
   const turn=release.turns.find(t=>t.legacyTurnId===r.turnId&&t.memberId===r.memberId);
   if(!turn||!r.snapshot.blocks||!r.snapshot.slides)continue;
   const expectedBlocks=release.project.blocks.filter(b=>turn.blockIds.includes(b.id));
   if(JSON.stringify(expectedBlocks)!==JSON.stringify(r.snapshot.blocks)||JSON.stringify(release.project.slides)!==JSON.stringify(r.snapshot.slides))continue;
   try{validateEvents(r.events,r.durationMs,release.project.slides.length)}catch{continue}
   matches.push({recordingId:r.id,releaseId:release.id,turnUid:turn.uid});
  }
  if(matches.length===1)refs.push(matches[0]);
  else unresolved.push(r.id);
 }
 return {releases,head:releases.find(r=>r.project.revision===published?.revision)?.id??null,refs,unresolved,skippedRevisions};
}
