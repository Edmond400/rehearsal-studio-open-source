import {database} from '../data';
import {identifyReleaseTurns,type ReleaseTurn} from './turn-identity';
import type {Project} from './model';
import {slideHashes,legacyImportPlan,referenceCandidates,insertReferences,type ReleaseRow} from './release-recordings';

type TurnRow = {turn_uid:string;ordinal:number;member_id:string;turn_fingerprint:string;ordered_slide_refs_json:string;block_ids_json:string};

export async function releaseTurns(projectId: string, releaseId: string): Promise<ReleaseTurn[]> {
 const rows = await database().prepare('SELECT * FROM rehearsal_release_turns WHERE project_id=? AND release_id=? ORDER BY ordinal').bind(projectId,releaseId).all<TurnRow>();
 return rows.results.map(row => {
  const blockIds: string[] = JSON.parse(row.block_ids_json);
  return {uid:row.turn_uid,ordinal:row.ordinal,memberId:row.member_id,legacyTurnId:'turn-'+blockIds[0],
   fingerprint:row.turn_fingerprint,slides:JSON.parse(row.ordered_slide_refs_json),blockIds};
 });
}
export async function releaseHead(projectId: string) {
 return database().prepare('SELECT r.* FROM rehearsal_release_heads h JOIN rehearsal_releases r USING(project_id,release_id) WHERE h.project_id=?').bind(projectId).first<ReleaseRow>();
}
export function releaseStatements(p: Project,id: string,number: number,base: number,turns: ReleaseTurn[],mutation: string|null) {
 const db=database();
 return [
  db.prepare('INSERT INTO rehearsal_releases VALUES (?,?,?,?,?,?,?)').bind(p.id,id,number,base,JSON.stringify(p),p.updatedAt,mutation),
  db.prepare(`INSERT INTO rehearsal_release_turns SELECT ?,?,json_extract(value,'$.uid'),json_extract(value,'$.ordinal'),
   json_extract(value,'$.memberId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.slides'),json_extract(value,'$.blockIds') FROM json_each(?)`).bind(p.id,id,JSON.stringify(turns))
 ];
}
export async function prepareRelease(project: Project,base: number,mutation: string|null) {
 const db=database(), head=await releaseHead(project.id);
 const hashes=await slideHashes(project.id);
 const previous=head?await releaseTurns(project.id,head.release_id):[];
 const turns=await identifyReleaseTurns(project,hashes,previous);
 const epoch=await db.prepare('SELECT epoch FROM rehearsal_recording_epochs WHERE project_id=?').bind(project.id).first<number>('epoch')??0;
 const id=crypto.randomUUID(),refs=await referenceCandidates(project,turns,hashes);
 return {id,statements:[
  db.prepare("INSERT INTO rehearsal_write_guards SELECT ?,CASE WHEN COALESCE((SELECT epoch FROM rehearsal_recording_epochs WHERE project_id=?),0)=? THEN 1 ELSE 0 END")
   .bind(crypto.randomUUID(),project.id,epoch),
  ...releaseStatements(project,id,(head?.release_no??0)+1,base,turns,mutation),
  insertReferences(project.id,id,refs),
  db.prepare('INSERT INTO rehearsal_release_heads VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET release_id=excluded.release_id').bind(project.id,id)
 ]};
}

export async function getRelease(projectId:string,id:string) {
 return database().prepare('SELECT * FROM rehearsal_releases WHERE project_id=? AND release_id=?').bind(projectId,id).first<ReleaseRow>();
}

export async function importLegacyReleases(projectId:string,published:Project|null,guard:D1PreparedStatement){
 if(!published || await releaseHead(projectId))return;
 const db=database(),plan=await legacyImportPlan(projectId,published,await slideHashes(projectId));
 if(!plan.head)return;
 // D1 rolls back this batch if the draft or release head changed while the
 // legacy snapshot was being inspected.
 const statements=[
  guard,
  db.prepare("INSERT INTO rehearsal_write_guards SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=? AND published_json=?) AND NOT EXISTS(SELECT 1 FROM rehearsal_release_heads WHERE project_id=?) THEN 1 ELSE 0 END")
   .bind(crypto.randomUUID(),projectId,JSON.stringify(published),projectId)
 ];
 for(const release of plan.releases)statements.push(...releaseStatements(release.project,release.id,release.number,release.project.revision,release.turns,null));
 statements.push(db.prepare(`INSERT INTO rehearsal_recording_origins SELECT ?,json_extract(value,'$.recordingId'),
  json_extract(value,'$.releaseId'),json_extract(value,'$.turnUid') FROM json_each(?)`).bind(projectId,JSON.stringify(plan.refs)));
 statements.push(db.prepare(`INSERT INTO rehearsal_recording_release_refs SELECT ?,json_extract(value,'$.releaseId'),
  json_extract(value,'$.turnUid'),json_extract(value,'$.recordingId'),? FROM json_each(?)`).bind(projectId,new Date().toISOString(),JSON.stringify(plan.refs)));
 statements.push(db.prepare('INSERT INTO rehearsal_release_heads VALUES (?,?)').bind(projectId,plan.head));
 try {await db.batch(statements)} catch(error) {if(!await releaseHead(projectId))throw error;}
}
