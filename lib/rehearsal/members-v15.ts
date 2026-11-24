import type {Project,Recording} from './model';
/** Name separators are intentional; ordinary spaces belong to the name. */
export function parseMemberNames(input:string,existing:string[]=[]){
 const names:string[]=[],duplicates:string[]=[];
 const seen=new Set<string>(existing.map(x=>x.trim()).filter(Boolean));
 for(const raw of input.split(/[\n\r,，、;；]+/)){
  const name=raw.trim();if(!name)continue;
  if(seen.has(name)){if(!duplicates.includes(name))duplicates.push(name);continue;}
  names.push(name);seen.add(name);
 }
 return {names,duplicates};
}
export function removeMemberSafely(project:Project,id:string,recordings:Recording[]):Project{
 const member=project.members.find(m=>m.id===id);
 if(!member)throw new Error('组员已不存在。');
 const referenced=project.blocks.some(b=>b.memberId===id)||recordings.some(r=>r.memberId===id)
    ||project.status==='published'||project.status==='ended'||!!project.publishedAt;
 if(referenced)return {...project,members:project.members.map(m=>m.id===id?{...m,enabled:false}:m)};
 return {...project,members:project.members.filter(m=>m.id!==id)};
}
