import {database} from '../data';
import {HttpError} from '../http';
import {type Project,type Recording,turnsFor} from './model';
import {planLegacyReleases,type LegacyRecording} from './legacy-releases';
import {remapRecordedEvents,sameTurnContent,type FileHashes,type ReleaseTurn} from './turn-identity';
import {validateEvents} from './timeline';

export type ReleaseRow={project_id:string;release_id:string;release_no:number;source_draft_revision:number;snapshot_json:string;created_at:string};
type RecordRow={id:string;member_id:string;turn_id:string;script_version:string;deck_version:string;algorithm_version:string;
 mime:string;bytes:number;hash:string;duration_ms:number;submitted_at:string;locked:number;complete:number;
 predicted_seconds:number;events_json:string;snapshot_json:string;metadata_json:string};

export async function slideHashes(projectId:string){
 const rows=await database().prepare("SELECT id,hash FROM rehearsal_files WHERE project_id=? AND kind='slide'").bind(projectId).all<{id:string;hash:string}>();
 return new Map(rows.results.map(f=>[f.id,f.hash]));
}
export const releaseProject=(row:ReleaseRow):Project=>({...JSON.parse(row.snapshot_json),releaseId:row.release_id});
export function recordingFromRow(row:RecordRow):Recording {
 return {id:row.id,memberId:row.member_id,turnId:row.turn_id,scriptVersion:row.script_version,deckVersion:row.deck_version,algorithmVersion:row.algorithm_version,
  mime:row.mime,bytes:row.bytes,hash:row.hash,durationMs:row.duration_ms,submittedAt:row.submitted_at,locked:!!row.locked,complete:!!row.complete,
  predictedSeconds:row.predicted_seconds,events:JSON.parse(row.events_json),metadata:JSON.parse(row.metadata_json),slides:JSON.parse(row.snapshot_json).slides};
}

export async function referenceCandidates(project:Project,turns:ReleaseTurn[],hashes:FileHashes) {
 const db=database(),ids=new Map(turns.map(t=>[t.uid,t]));
 if(!turns.length)return [];
 const rows=await db.prepare(`SELECT r.id,r.duration_ms,r.events_json,r.snapshot_json,o.turn_uid,
  t.member_id,t.turn_fingerprint,p.snapshot_json AS origin_json
  FROM rehearsal_recording_origins o JOIN rehearsal_recordings r ON r.id=o.recording_id AND r.project_id=o.project_id
  JOIN rehearsal_release_turns t ON t.project_id=o.project_id AND t.release_id=o.release_id AND t.turn_uid=o.turn_uid
  JOIN rehearsal_releases p ON p.project_id=o.project_id AND p.release_id=o.release_id
  WHERE o.project_id=? AND o.turn_uid IN (SELECT value FROM json_each(?))`).bind(project.id,JSON.stringify([...ids.keys()]))
 .all<{id:string;duration_ms:number;events_json:string;snapshot_json:string;turn_uid:string;member_id:string;turn_fingerprint:string;origin_json:string}>();
 return rows.results.flatMap(row=>{
  const target=ids.get(row.turn_uid)!;
  if(!sameTurnContent(target,{...target,memberId:row.member_id,fingerprint:row.turn_fingerprint}))return [];
  const origin:Project=JSON.parse(row.origin_json);
  if(JSON.stringify(JSON.parse(row.snapshot_json).slides)!==JSON.stringify(origin.slides))return [];
  try {
   const events=validateEvents(JSON.parse(row.events_json),row.duration_ms,origin.slides.length);
   return remapRecordedEvents(events,origin,project,hashes)?[{uid:target.uid,id:row.id}]:[];
  } catch { return []; }
 });
}

export function insertReferences(projectId:string,releaseId:string,refs:{uid:string;id:string}[]){
 return database().prepare(`INSERT INTO rehearsal_recording_release_refs
  SELECT ?,?,json_extract(value,'$.uid'),json_extract(value,'$.id'),? FROM json_each(?) WHERE true
  ON CONFLICT(project_id,release_id,turn_uid,recording_id) DO NOTHING`).bind(projectId,releaseId,new Date().toISOString(),JSON.stringify(refs));
}

export async function releaseRecordings(project:Project,hashes:FileHashes){
 const db=database();
 const rows=await db.prepare(`SELECT r.*,f.mime,f.bytes,f.hash,t.block_ids_json,ref.turn_uid,
  CASE WHEN choice.recording_id=r.id THEN 1 ELSE 0 END AS selected,
  COALESCE(choice.selection_revision,0) AS selection_revision
 FROM rehearsal_recording_release_refs ref JOIN rehearsal_recordings r ON r.project_id=ref.project_id AND r.id=ref.recording_id
 JOIN rehearsal_release_turns t ON t.project_id=ref.project_id AND t.release_id=ref.release_id AND t.turn_uid=ref.turn_uid
 JOIN rehearsal_files f ON f.project_id=r.project_id AND f.id=r.id
 LEFT JOIN rehearsal_playback_choices choice ON choice.project_id=ref.project_id AND choice.release_id=ref.release_id AND choice.turn_uid=ref.turn_uid
 WHERE ref.project_id=? AND ref.release_id=? AND r.status='ready'
 ORDER BY r.submitted_at DESC,r.id DESC`).bind(project.id,project.releaseId).all<RecordRow&{block_ids_json:string;turn_uid:string;selected:number;selection_revision:number}>();
 return rows.results.flatMap(row=>{
  const raw=recordingFromRow(row),origin={...project,slides:raw.slides??[]};
  let mapped;
  try {mapped=remapRecordedEvents(validateEvents(raw.events,raw.durationMs,origin.slides.length),origin,project,hashes);}
  catch { return []; }
  if(!mapped)return [];
  return [{...raw,turnId:'turn-'+JSON.parse(row.block_ids_json)[0],releaseId:project.releaseId,
   turnUid:row.turn_uid,scriptVersion:project.scriptVersion,deckVersion:project.deckVersion,algorithmVersion:project.algorithmVersion,
   events:mapped,slides:project.slides,selected:!!row.selected,selectionRevision:row.selection_revision}];
 });
}

export async function legacyImportPlan(projectId:string,published:Project,hashes:FileHashes){
 const db=database();
 const [versions,records]=await Promise.all([
  db.prepare("SELECT document_json FROM rehearsal_versions WHERE project_id=? AND json_extract(document_json,'$.status')='published' ORDER BY revision").bind(projectId).all<{document_json:string}>(),
  db.prepare("SELECT * FROM rehearsal_recordings WHERE project_id=? AND status='ready'").bind(projectId).all<RecordRow>()
 ]);
 const legacy:LegacyRecording[]=records.results.map(r=>({id:r.id,memberId:r.member_id,turnId:r.turn_id,scriptVersion:r.script_version,deckVersion:r.deck_version,
  algorithmVersion:r.algorithm_version,durationMs:r.duration_ms,events:JSON.parse(r.events_json),snapshot:JSON.parse(r.snapshot_json)}));
 return planLegacyReleases(projectId,published,versions.results.map(r=>JSON.parse(r.document_json)),legacy,hashes);
}

export async function chooseRecording(projectId:string,releaseId:string,uid:string,recordingId:string|null,revision:number,guard:D1PreparedStatement){
 const db=database();
 const turn=await db.prepare('SELECT 1 ok FROM rehearsal_release_turns WHERE project_id=? AND release_id=? AND turn_uid=?').bind(projectId,releaseId,uid).first();
 if(!turn)throw new HttpError(404,'找不到这个发布版本的发言轮次。');
 const before=await db.prepare('SELECT selection_revision FROM rehearsal_playback_choices WHERE project_id=? AND release_id=? AND turn_uid=?').bind(projectId,releaseId,uid).first<number>('selection_revision');
 if((before??0)!==revision)throw new HttpError(409,'组员刚更新回放选择，请刷新后再试。');
 try {
  const [,result]=await db.batch([guard,db.prepare(`INSERT INTO rehearsal_playback_choices
   SELECT ?,?,?,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM rehearsal_playback_choices WHERE project_id=? AND release_id=? AND turn_uid=?))
   ON CONFLICT(project_id,release_id,turn_uid) DO UPDATE SET recording_id=excluded.recording_id,
   selection_revision=excluded.selection_revision,updated_at=excluded.updated_at WHERE rehearsal_playback_choices.selection_revision=?`)
   .bind(projectId,releaseId,uid,recordingId,revision+1,new Date().toISOString(),revision,projectId,releaseId,uid,revision)]);
  if(result.meta.changes!==1)throw new Error('CAS');
 } catch {throw new HttpError(409,'选择已变更或录音已不可用，请刷新。');}
}

export async function playbackManifest(row:ReleaseRow,guard:D1PreparedStatement){
 const p=releaseProject(row);
 const candidates=await releaseRecordings(p,await slideHashes(p.id));
 const chosen=turnsFor(p).flatMap(turn=>{
  const list=candidates.filter(r=>r.turnId===turn.id);
  return list.find(r=>r.selected)??list[0]??[];
 });
 const db=database();
 const expires=Date.now()+12*3600000;
 await db.batch([guard,db.prepare(`INSERT INTO rehearsal_audio_leases
  SELECT ?,value,? FROM json_each(?) WHERE true
  ON CONFLICT(project_id,recording_id) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)`).bind(p.id,expires,JSON.stringify(chosen.map(r=>r.id)))]);
 return {project:p,recordings:chosen,expires};
}
