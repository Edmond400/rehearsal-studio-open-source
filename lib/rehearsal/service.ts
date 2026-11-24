import {database} from '../data';
import {rateLimit,projectLimit,sessionGuard,authorize} from '../security';
import {HttpError,json,readBytes,sameOrigin} from '../http';
import {type Project,type Recording,DEFAULT_CONFIG,ALGORITHM_VERSION,MAX_AUDIO_BYTES,MAX_PAGE_BYTES,turnsFor} from './model';
import {estimateProject,validateProject} from './algorithm';
import {buildTimeline,validateEvents} from './timeline';
import {projectSchema,recordingSchema,reviewSchema,uniqueIds} from './validation';
import {sha256,detectMime,fileStatements,getFile,mediaFileTable,serveFile,type FileMetadata} from './storage';
import {z} from 'zod';
import {requestProject,requireRehearsal,listProjects,enterRehearsal,manageProject} from './access';
import {digest} from '../passwords';
import {pptxSlideOrder} from './pptx';
import {pptxMediaOrder} from './pptx-media-order';
import {mediaRange} from './media-range';
import {beginUpload,getUpload,promoteUpload,putUploadPart,uploadIdSchema,uploadSchema} from './media-upload';

import {deckBudgetSchema,deckCapacity,deckMime,MAX_DECK_BYTES,previewBudget,saveDeckAsset,sourceIdSchema} from './deck-storage';
import {cancelR2Upload,finishR2Upload,putR2Part,r2Id,r2UploadSchema,r2WritePolicy,startR2Upload} from './r2-upload';
import {draftBody} from './draft-client';
import {getRelease,importLegacyReleases,prepareRelease,releaseHead,releaseTurns} from './releases';
import {chooseRecording,insertReferences,playbackManifest,recordingFromRow,releaseProject,releaseRecordings,slideHashes,type ReleaseRow} from './release-recordings';
import {remapRecordedEvents,sameTurnContent} from './turn-identity';
import {reauthenticate} from '../studio-credentials';
export async function getProject(projectId='current',published=false):Promise<Project|null>{const row=await database().prepare('SELECT document_json,published_json FROM rehearsal_projects WHERE id=? AND deleted_at IS NULL').bind(projectId).first<any>();const doc=published?row?.published_json:row?.document_json;return doc?JSON.parse(doc):null}
function isVisible(p:Project){return p.status!=='draft'&&(!p.publishedAt||Date.parse(p.publishedAt)<=Date.now())}
async function publicProject(projectId:string){const p=await getProject(projectId,true);if(!p||!isVisible(p))throw new HttpError(404,'汇报尚未发布，可进入编排工作台准备材料。');return p}
export async function recordings(projectId='current'):Promise<Recording[]>{
 const result=await database().prepare("SELECT r.*,f.mime,f.bytes,f.hash FROM rehearsal_recordings r JOIN rehearsal_files f ON f.id=r.id WHERE r.project_id=? AND r.status='ready' ORDER BY r.submitted_at DESC,r.id DESC").bind(projectId).all<Parameters<typeof recordingFromRow>[0]>();
 return result.results.map(recordingFromRow);
}
export async function turnProgress(projectId='current'){const r=await database().prepare('SELECT member_id AS memberId,turn_id AS turnId,script_version AS scriptVersion,deck_version AS deckVersion,submitted_at AS submittedAt FROM rehearsal_turn_progress WHERE project_id=? ORDER BY submitted_at DESC').bind(projectId).all();return r.results}
async function payload(request:Request){sameOrigin(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(415,'请提交JSON');try{return JSON.parse(new TextDecoder().decode(await readBytes(request,450000)))}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'JSON格式无效')}}
function guard(sql:string,...values:(string|number)[]){return database().prepare('INSERT INTO rehearsal_write_guards(id,allowed) SELECT ?,CASE WHEN '+sql+' THEN 1 ELSE 0 END').bind(crypto.randomUUID(),...values)}
function accessGuard(request:Request,projectId:string){return sessionGuard(request,projectId)}
export async function saveProject(request:Request,projectId='current',mode:'legacy'|'draft'|'publish'='legacy'){
 const db=database();
 const body=await payload(request);
 const mutation=mode==='draft'?z.object({base_revision:z.number().int().nonnegative(),mutation_id:z.string().uuid(),document:projectSchema}).strict().parse(body):null;
 const publication=mode==='publish'?z.object({expected_draft_revision:z.number().int().nonnegative(),mutation_id:z.string().uuid()}).strict().parse(body):null;
 const old=await getProject(projectId);
 if(!old)throw new HttpError(404,'汇报不存在或已删除。');
 const hash=mutation?await sha256(new TextEncoder().encode(JSON.stringify(mutation))):null;
 async function replay(){
  if(!mutation)return null;
  const saved=await db.prepare('SELECT payload_hash,saved_revision FROM rehearsal_draft_mutations WHERE project_id=? AND client_mutation_id=?').bind(projectId,mutation.mutation_id).first<{payload_hash:string;saved_revision:number}>();
  if(!saved)return null;
  if(saved.payload_hash!==hash)throw new HttpError(409,'请求标识已用于其他修改。');
  const current=await getProject(projectId);
  if(current?.revision!==saved.saved_revision)throw new HttpError(409,'草稿已有更新，请重新合并。');
  return json({project:current,retried:true});
 }
 async function replayPublication(){
  if(!publication)return null;
  const prior=await db.prepare('SELECT release_id,source_draft_revision,snapshot_json FROM rehearsal_releases WHERE project_id=? AND mutation_id=?').bind(projectId,publication.mutation_id).first<{release_id:string;source_draft_revision:number;snapshot_json:string}>();
  if(prior){
   if(prior.source_draft_revision!==publication.expected_draft_revision)throw new HttpError(409,'发布请求对应不同的草稿。');
   return json({project:JSON.parse(prior.snapshot_json),releaseId:prior.release_id,retried:true});
  }
  return null;
 }
 const replayed=await replay()??await replayPublication();if(replayed)return replayed;
 const input=publication?projectSchema.parse({...draftBody(old),revision:publication.expected_draft_revision,status:'published',publishedAt:null}):
  mutation?{...mutation.document,revision:mutation.base_revision,status:'draft' as const}:projectSchema.parse(body);
 if(!uniqueIds(input.members)||!uniqueIds(input.blocks)||!uniqueIds(input.slides))throw new HttpError(400,'成员、片段、PPT的ID不得重复');
 if(input.blocks.reduce((s,b)=>s+b.text.length+(b.spokenText?.length||0),0)>80000)throw new HttpError(413,'讲稿总长度超过80000字符');
 if(new Set(input.members.map(m=>m.name)).size!==input.members.length)throw new HttpError(400,'同名成员请添加区分备注');
 if(old.revision!==input.revision)return json({error:'项目已被其他窗口修改。',current_revision:old.revision},409);
 const mediaTable=input.sourceDeck?await mediaFileTable():'rehearsal_files';
 if(input.sourceDeck&&!await database().prepare(`SELECT id FROM ${mediaTable} WHERE id=? AND project_id=? AND kind='pptx' AND bytes=?`).bind(input.sourceDeck.id,projectId,input.sourceDeck.bytes).first())throw new HttpError(400,'原始PPTX不属于此汇报。');
 if(await database().prepare('SELECT id FROM rehearsal_members WHERE project_id!=? AND id IN (SELECT value FROM json_each(?)) LIMIT 1').bind(projectId,JSON.stringify(input.members.map(m=>m.id))).first())throw new HttpError(400,'成员标识已用于其他汇报，请重新添加成员。');
 const memberIds=new Set(input.members.map(m=>m.id));if(input.blocks.some(b=>b.memberId&&!memberIds.has(b.memberId)))throw new HttpError(400,'片段引用了无效成员');
 const availableSlides=await database().prepare("SELECT id,bytes,mime FROM rehearsal_files WHERE project_id=? AND kind='slide'").bind(projectId).all<{id:string;bytes:number;mime:string}>();
 for(const [i,s] of input.slides.entries()){const f=availableSlides.results.find(f=>f.id===s.id);if(!f||f.bytes!==s.bytes||f.mime!==s.mime||s.pageIndex!==i)throw new HttpError(400,'PPT资源或页序无效，请重新上传。')}
 if(input.config.planningSeconds>input.config.hardLimitSeconds)throw new HttpError(400,'提前结束目标不能超过规定时长。');
 if(input.sourceDeck&&(input.slides.some(s=>s.sourcePage&&!input.sourceDeck!.pages.includes(s.sourcePage))||new Set(input.slides.map(s=>s.sourcePage).filter(Boolean)).size!==input.slides.filter(s=>s.sourcePage).length))throw new HttpError(400,'原始PPT页关联无效或重复，请逐页核对。');
 const revision=input.revision+1,now=new Date().toISOString();
 const scriptChanged=!old||JSON.stringify(input.blocks)!==JSON.stringify(old.blocks);
 const deckChanged=!old||JSON.stringify(input.slides)!==JSON.stringify(old.slides)||JSON.stringify(input.sourceDeck)!==JSON.stringify(old.sourceDeck);
 const configChanged=!old||JSON.stringify({...input.config,version:''})!==JSON.stringify({...old.config,version:''});
 const algo=configChanged?ALGORITHM_VERSION+'-r'+revision+'-'+crypto.randomUUID().slice(0,8):old!.algorithmVersion;
 const p:Project={...input,id:projectId,revision,scriptVersion:scriptChanged?crypto.randomUUID():old!.scriptVersion,deckVersion:deckChanged?crypto.randomUUID():old!.deckVersion,algorithmVersion:algo,config:{...input.config,version:algo},updatedAt:now};
 const turnIds=new Set(turnsFor(p).map(t=>t.id));if(Object.keys(p.overrides).some(x=>!turnIds.has(x)))throw new HttpError(400,'时间覆盖引用了已删除轮次，请清除该目标后保存。');
 const errors=validateProject(p);if(p.status==='published'&&errors.length)throw new HttpError(400,errors.join('；'));
 let estimate;try{if(!mutation)estimate=estimateProject(p,await recordings(projectId))}catch(error){throw new HttpError(400,(error as Error).message)}const doc=JSON.stringify(p);
 const ended= input.status==='ended'?await getProject(projectId,true):null;if(input.status==='ended'&&!ended)throw new HttpError(409,'此汇报尚未发布，无需结束收录。');const publishedDoc=JSON.stringify(ended?{...ended,status:'ended'}:p);
 const statements:D1PreparedStatement[]=[accessGuard(request,projectId),guard('EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=? AND revision=? AND deleted_at IS NULL)',projectId,old?.revision??0),guard('NOT EXISTS(SELECT 1 FROM rehearsal_members WHERE project_id<>? AND id IN (SELECT value FROM json_each(?)))',projectId,JSON.stringify(input.members.map(m=>m.id))),guard("NOT EXISTS(SELECT value FROM json_each(?) AS wanted WHERE NOT EXISTS(SELECT 1 FROM rehearsal_files f WHERE f.id=wanted.value AND f.project_id=? AND f.kind='slide'))",JSON.stringify(input.slides.map(s=>s.id)),projectId),...(input.sourceDeck?[guard(`EXISTS(SELECT 1 FROM ${mediaTable} WHERE id=? AND project_id=? AND kind='pptx' AND bytes=?)`,input.sourceDeck.id,projectId,input.sourceDeck.bytes)]:[]),db.prepare("UPDATE rehearsal_projects SET title=?,status=CASE WHEN ?='published' THEN 'published' WHEN ?='ended' THEN 'ended' WHEN published_json IS NOT NULL THEN status ELSE 'draft' END,revision=?,script_version=?,deck_version=?,algorithm_version=?,document_json=?,published_json=CASE WHEN ? IN ('published','ended') THEN ? ELSE published_json END,updated_at=? WHERE id=?").bind(p.title,p.status,p.status,p.revision,p.scriptVersion,p.deckVersion,p.algorithmVersion,doc,p.status,publishedDoc,now,projectId)];
 if(!mutation)statements.push(db.prepare('INSERT INTO rehearsal_versions VALUES (?,?,?,?)').bind(projectId,p.revision,doc,now));
 if(mutation){
  statements.push(db.prepare('INSERT INTO rehearsal_draft_mutations VALUES (?,?,?,?,?,?)').bind(projectId,mutation.mutation_id,old.revision,p.revision,hash,Date.now()));
  statements.push(db.prepare('DELETE FROM rehearsal_draft_mutations WHERE project_id=? AND saved_revision<=?').bind(projectId,p.revision-128));
  statements.push(db.prepare("INSERT INTO rehearsal_draft_checkpoints SELECT ?,?,?,?,'autosave',? WHERE NOT EXISTS (SELECT 1 FROM rehearsal_draft_checkpoints WHERE project_id=? AND created_at>?)").bind(projectId,mutation.mutation_id,p.revision,doc,now,projectId,new Date(Date.now()-15*60000).toISOString()));
  statements.push(db.prepare('DELETE FROM rehearsal_draft_checkpoints WHERE project_id=? AND checkpoint_id IN (SELECT checkpoint_id FROM rehearsal_draft_checkpoints WHERE project_id=? ORDER BY draft_revision DESC LIMIT -1 OFFSET 20)').bind(projectId,projectId));
 }
 if(p.status==='published')await importLegacyReleases(projectId,await getProject(projectId,true),accessGuard(request,projectId));
 const release=p.status==='published'?await prepareRelease(p,old.revision,publication?.mutation_id??null):null;
 if(release)statements.push(...release.statements);
 statements.push(db.prepare('UPDATE rehearsal_members SET enabled=0 WHERE project_id=?').bind(projectId));
 statements.push(db.prepare(`INSERT INTO rehearsal_members(id,project_id,display_name,enabled)
  SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.enabled') FROM json_each(?) WHERE true
  ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,enabled=excluded.enabled
  WHERE rehearsal_members.project_id=excluded.project_id`).bind(projectId,JSON.stringify(p.members)));
 if(!mutation)statements.push(db.prepare('INSERT INTO rehearsal_estimates VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),projectId,revision,algo,JSON.stringify({config:p.config,estimate}),now));
 try{await db.batch(statements)}catch{const retry=await replay()??await replayPublication();if(retry)return retry;throw new HttpError(409,'保存冲突，原版本已保留。请刷新后重试。')}
 return mutation?json({project:p}):json({project:p,recordings:await recordings(projectId),estimate,...(release?{releaseId:release.id}:{})});
}
export async function submitRecording(request:Request,projectId='current'){
 sameOrigin(request);await rateLimit(request,'rehearsal-upload',30,900);
 let raw:unknown,bytes:Uint8Array,mimeClaim:string;
 if(request.headers.get('content-type')?.startsWith('multipart/form-data')){
  const body=await readBytes(request,MAX_AUDIO_BYTES+200000);let form:FormData;
  try{form=await new Response(body,{headers:{'Content-Type':request.headers.get('content-type')!}}).formData()}catch{throw new HttpError(400,'录音表单不完整，请重试')}
  const audio=form.get('audio'),metadata=form.get('metadata');if(!(audio instanceof File)||typeof metadata!=='string'||metadata.length>150000)throw new HttpError(400,'录音或元数据缺失');
  if(audio.size>MAX_AUDIO_BYTES)throw new HttpError(413,'单录音不能超过10MiB');bytes=new Uint8Array(await audio.arrayBuffer());mimeClaim=audio.type;try{raw=JSON.parse(metadata)}catch{throw new HttpError(400,'录音元数据格式无效')}
 }else{
  const metadata=request.headers.get('x-rehearsal-metadata');if(!metadata||metadata.length>16000)throw new HttpError(400,'录音元数据缺失或过大');
  try{raw=JSON.parse(decodeURIComponent(metadata))}catch{throw new HttpError(400,'录音元数据格式无效')}
  bytes=await readBytes(request,MAX_AUDIO_BYTES);mimeClaim=request.headers.get('content-type')||'';
 }
 if(!bytes.length)throw new HttpError(400,'录音为空');
 const mime=detectMime(bytes,'audio',mimeClaim);
 const hash=await sha256(bytes);
 return commitRecording(request,projectId,recordingSchema.parse(raw),mime,hash,(id,ts)=>[
  ...fileStatements({id,project_id:projectId,kind:'audio',mime,bytes:bytes.length,hash},bytes)
 ]);
}
async function commitRecording(request:Request,projectId:string,input:z.infer<typeof recordingSchema>,mime:string,hash:string,
 persist:((id:string,createdAt:string)=>D1PreparedStatement[])|null){
 const db=database();
 if(hash!==input.hash)throw new HttpError(400,'录音校验摘要不符，请重新提交');
 const requestHash=await sha256(new TextEncoder().encode(JSON.stringify({...input,events:input.events,mime})));
 async function recordedRequest(){
  return db.prepare(`SELECT request_hash FROM rehearsal_recording_receipts WHERE project_id=? AND recording_id=?
   UNION ALL SELECT request_hash FROM rehearsal_recordings WHERE project_id=? AND id=? LIMIT 1`).bind(projectId,input.id,projectId,input.id).first<{request_hash:string}>();
 }
 const existing=await recordedRequest();
 if(existing){if(existing.request_hash!==requestHash)throw new HttpError(409,'重试ID对应不同的录音');return json({ok:true,id:input.id,retried:true})}
 if(!persist)throw new HttpError(404,'上传已过期，请重新开始。');
 const live=await publicProject(projectId);
 if(live.status!=='published')throw new HttpError(409,'本次汇报已结束，不再接收录音');
 await importLegacyReleases(projectId,live,accessGuard(request,projectId));
 const head=await releaseHead(projectId);
 let release=input.releaseId?await getRelease(projectId,input.releaseId):head;
 const matches=(row:ReleaseRow|null)=>row&&(()=>{const p=releaseProject(row);return input.scriptVersion===p.scriptVersion&&input.deckVersion===p.deckVersion&&input.algorithmVersion===p.algorithmVersion})();
 if(!input.releaseId&&!matches(release)){
  const rows=await db.prepare(`SELECT * FROM rehearsal_releases WHERE project_id=?
   AND json_extract(snapshot_json,'$.scriptVersion')=? AND json_extract(snapshot_json,'$.deckVersion')=?
   AND json_extract(snapshot_json,'$.algorithmVersion')=? LIMIT 2`)
   .bind(projectId,input.scriptVersion,input.deckVersion,input.algorithmVersion).all<ReleaseRow>();
  release=rows.results.length===1?rows.results[0]:null;
 }
 if(!head||!release||!matches(release))throw new HttpError(409,'找不到录音开始时的发布版本。请下载保留本地录音。');
 const p=releaseProject(release);
 const turn=turnsFor(p).find(t=>t.id===input.turnId&&t.memberId===input.memberId);
 if(!turn||!p.members.some(m=>m.id===input.memberId&&m.enabled))throw new HttpError(400,'请选择当前有效成员及发言轮次');
 let duration=input.mediaDurationMs??input.clockDurationMs;
 if(input.durationMs!==Math.round(duration))throw new HttpError(400,'录音时长与媒体/计时信息不一致');
 duration=Math.round(duration);
 let events;try{events=validateEvents(input.events,duration,p.slides.length)}catch(error){throw new HttpError(400,(error as Error).message)}
 const sourceTurn=(await releaseTurns(projectId,release.release_id)).find(t=>t.legacyTurnId===turn.id&&t.memberId===input.memberId);
 if(!sourceTurn)throw new HttpError(409,'此发言轮次的发布记录不完整。');
 const headTurn=head.release_id!==release.release_id?(await releaseTurns(projectId,head.release_id)).find(t=>t.uid===sourceTurn.uid):undefined;
 const attachCurrent=headTurn&&sameTurnContent(sourceTurn,headTurn)&&remapRecordedEvents(events,p,releaseProject(head),await slideHashes(projectId));
 const estimate=estimateProject(p,await recordings(projectId)),predicted=estimate.turns.find(t=>t.turnId===turn.id)!.initialSeconds,ts=new Date().toISOString();
 const statements=[accessGuard(request,projectId),guard('EXISTS(SELECT 1 FROM rehearsal_members WHERE id=? AND project_id=?)',input.memberId,projectId),guard("EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=? AND status='published' AND deleted_at IS NULL)",projectId),...persist(input.id,ts),db.prepare('INSERT INTO rehearsal_recordings(id,project_id,member_id,turn_id,script_version,deck_version,algorithm_version,duration_ms,submitted_at,predicted_seconds,snapshot_json,events_json,metadata_json,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(input.id,projectId,input.memberId,turn.id,p.scriptVersion,p.deckVersion,p.algorithmVersion,duration,ts,predicted,JSON.stringify({config:p.config,blocks:p.blocks.filter(b=>turn.blockIds.includes(b.id)),slides:p.slides,estimate:estimate.turns.find(t=>t.turnId===turn.id)}),JSON.stringify(events),JSON.stringify({clockDurationMs:input.clockDurationMs,mediaDurationMs:input.mediaDurationMs,durationSource:input.mediaDurationMs===null?'浏览器有效计时（媒体未提供有限时长，待人工核对）':'浏览器媒体有效时长'}),requestHash)];
 statements.push(
  guard('EXISTS(SELECT 1 FROM rehearsal_release_heads WHERE project_id=? AND release_id=?)',projectId,head.release_id),
  db.prepare('INSERT INTO rehearsal_recording_origins VALUES (?,?,?,?)').bind(projectId,input.id,release.release_id,sourceTurn.uid),
  insertReferences(projectId,release.release_id,[{uid:sourceTurn.uid,id:input.id}]),
  db.prepare('INSERT INTO rehearsal_recording_receipts VALUES (?,?,?,?)').bind(projectId,input.id,requestHash,Date.now()),
  db.prepare('DELETE FROM rehearsal_recording_receipts WHERE project_id=? AND submitted_at<?').bind(projectId,Date.now()-30*86400000)
 );
 if(attachCurrent)statements.push(insertReferences(projectId,head.release_id,[{uid:sourceTurn.uid,id:input.id}]));
 const count='SELECT count(*) FROM rehearsal_recording_origins WHERE project_id=? AND release_id=? AND turn_uid=?';
 statements.push(db.prepare(`DELETE FROM rehearsal_files WHERE project_id=? AND id=(
  SELECT r.id FROM rehearsal_recording_origins o JOIN rehearsal_recordings r ON r.id=o.recording_id
  WHERE o.project_id=? AND o.release_id=? AND o.turn_uid=? AND r.id<>?
  AND NOT EXISTS(SELECT 1 FROM rehearsal_protected_recordings protected WHERE protected.project_id=o.project_id AND protected.id=r.id)
  ORDER BY r.submitted_at,r.rowid LIMIT 1
 ) AND (${count})>3`).bind(projectId,projectId,release.release_id,sourceTurn.uid,input.id,projectId,release.release_id,sourceTurn.uid));
 statements.push(guard('('+count+')<=3',projectId,release.release_id,sourceTurn.uid));
 try{await db.batch(statements)}catch{
  const retry=await recordedRequest();if(retry?.request_hash===requestHash)return json({ok:true,id:input.id,retried:true});
  throw new HttpError(409,'无法提交录音。可淘汰的录音不足、存储已满或发布版本刚刚更新，请保留本地录音后重试。');
 }
 return json({ok:true,id:input.id});
}
async function uploadSlide(request:Request,projectId:string){
 const p=await getProject(projectId);if(!p)throw new HttpError(409,'请先保存汇报基本信息，再上传PPT');
 const bytes=await readBytes(request,MAX_PAGE_BYTES);if(!bytes.length)throw new HttpError(400,'页面图片为空');const mime=detectMime(bytes,'slide',request.headers.get('content-type')||'');
 const file={id:crypto.randomUUID(),project_id:projectId,kind:'slide' as const,mime,bytes:bytes.length,hash:await sha256(bytes)};
 await database().batch([accessGuard(request,projectId),...fileStatements(file,bytes)]);return json({id:file.id,mime,bytes:bytes.length});
}
async function reviewRecording(request:Request,projectId:string){
 await authorize(request,projectId,true);
 const i=reviewSchema.parse(await payload(request)),db=database();
 if(!await db.prepare("SELECT id FROM rehearsal_recordings WHERE id=? AND project_id=?").bind(i.id,projectId).first())throw new HttpError(404,'录音不存在');
 const proof=i.action==='delete'?(await reauthenticate(request,projectId,i.password)).proof:null;
 const statement=i.action==='delete'?db.prepare('DELETE FROM rehearsal_recordings WHERE id=? AND project_id=?').bind(i.id,projectId):db.prepare('UPDATE rehearsal_recordings SET locked=COALESCE(?,locked),complete=COALESCE(?,complete) WHERE id=? AND project_id=?').bind(i.locked===undefined?null:Number(i.locked),i.complete===undefined?null:Number(i.complete),i.id,projectId);
 try{await db.batch([sessionGuard(request,projectId,true),...(proof?[proof]:[]),statement]);}catch{throw new HttpError(409,'此录音受指定、历史引用、播放或验收锁定保护，无法删除。');}return json({ok:true});
}
async function cleanup(request:Request,projectId:string){
 await authorize(request,projectId,true);
 const input=z.object({password:z.string().min(1).max(256)}).strict().parse(await payload(request));
 const {proof}=await reauthenticate(request,projectId,input.password);
 const p=await getProject(projectId);if(!p)return json({ok:true});
 const keep=new Set<string>();const remember=(doc:Project)=>{for(const s of doc.slides??[])keep.add(s.id);if(doc.sourceDeck)keep.add(doc.sourceDeck.id)};remember(p);const live=await getProject(projectId,true);if(live)remember(live);
 const versions=await database().prepare('SELECT document_json FROM rehearsal_versions WHERE project_id=?').bind(projectId).all<{document_json:string}>();for(const row of versions.results)remember(JSON.parse(row.document_json));
 const checkpoints=await database().prepare('SELECT document_json FROM rehearsal_draft_checkpoints WHERE project_id=?').bind(projectId).all<{document_json:string}>();for(const row of checkpoints.results)remember(JSON.parse(row.document_json));
 const rows=await database().prepare('SELECT snapshot_json FROM rehearsal_recordings WHERE project_id=?').bind(projectId).all<{snapshot_json:string}>();for(const row of rows.results)remember(JSON.parse(row.snapshot_json));
 const db=database();
 const files=await db.prepare(`SELECT id FROM rehearsal_files WHERE kind IN ('slide','pptx') AND project_id=?
  AND ((id NOT LIKE 'preview-%' AND id NOT LIKE 'deck-%') OR created_at<?)`).bind(projectId,new Date(Date.now()-72*3600000).toISOString()).all<{id:string}>();
 const candidates=files.results.filter(file=>!keep.has(file.id)).map(file=>file.id);
 const [, , , ,deleted]=await db.batch<{id:string}>([
  sessionGuard(request,projectId,true),proof,guard('EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=? AND revision=?)',projectId,p.revision),
  db.prepare('DELETE FROM rehearsal_media_uploads WHERE project_id=? AND expires_at<=?').bind(projectId,Date.now()),
  db.prepare(`DELETE FROM rehearsal_files WHERE project_id=? AND id IN (SELECT value FROM json_each(?))
   AND NOT EXISTS(SELECT 1 FROM rehearsal_releases r WHERE r.project_id=rehearsal_files.project_id AND
    (json_extract(r.snapshot_json,'$.sourceDeck.id')=rehearsal_files.id OR EXISTS(
     SELECT 1 FROM json_each(r.snapshot_json,'$.slides') WHERE json_extract(value,'$.id')=rehearsal_files.id)))
   RETURNING id`).bind(projectId,JSON.stringify(candidates))
 ]);
 return json({ok:true,removed:deleted.results.length});
}
async function uploadDeck(request:Request,projectId:string){
 const bytes=await readBytes(request,MAX_DECK_BYTES);
 let order;
 try{order=pptxSlideOrder(bytes);}catch(error){throw new HttpError(400,(error as Error).message);}
 const file=await saveDeckAsset(projectId,'pptx',deckMime,bytes,accessGuard(request,projectId));
 return json({id:file.id,pages:order.map(s=>s.path),sourceIds:order.map(s=>s.id),bytes:file.bytes});
}
async function uploadPreviewPage(request:Request,projectId:string){
 const sourceId=sourceIdSchema.parse(request.headers.get('X-Rehearsal-Metadata'));
 const bytes=await readBytes(request,MAX_PAGE_BYTES);
 const mime=detectMime(bytes,'slide',request.headers.get('Content-Type')??'');
 const file=await saveDeckAsset(projectId,'slide',mime,bytes,accessGuard(request,projectId),sourceId);
 return json({id:file.id,mime:file.mime,bytes:file.bytes});
}
const finishUploadSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('pptx')}).strict(),
 z.object({kind:z.literal('audio'),mime:z.enum(['audio/webm','audio/mp4','audio/ogg']),recording:recordingSchema}).strict()
]);

async function receiveMedia(request:Request,projectId:string,path:string[]){
 if(request.method!=='POST')throw new HttpError(405,'不支持此操作');
 sameOrigin(request);
 if(path.length===1){
  await rateLimit(request,'media-start',60,900);
  return json(await beginUpload(request,projectId,uploadSchema.parse(await payload(request))));
 }
 if(path.length!==3)throw new HttpError(404,'接口不存在');
 const id=uploadIdSchema.parse(path[1]);
 if(path[2]!=='finish'){
  if(!/^\d{1,2}$/.test(path[2]))throw new HttpError(400,'分块编号无效。');
  await rateLimit(request,'media-part',640,900);
  return json(await putUploadPart(request,projectId,id,Number(path[2])));
 }
 await rateLimit(request,'media-finish',60,900);
 const input=finishUploadSchema.parse(await payload(request));
 const stage=await getUpload(projectId,id);
 if(stage&&(stage.kind!==input.kind||!stage.verified))throw new HttpError(409,'文件分块未全部通过校验。');
 if(input.kind==='audio'){
  if(id!==input.recording.id||stage&&stage.mime!==input.mime)throw new HttpError(409,'录音标识或格式不符。');
  return commitRecording(request,projectId,input.recording,input.mime,stage?.hash??input.recording.hash,
   stage?(_,createdAt)=>promoteUpload(stage,createdAt):null);
 }
 let file=await getFile(id,'pptx',projectId)??stage;
 if(!file)throw new HttpError(404,'上传已过期，请重新开始。');
 let order;
 const inspect=async(source:FileMetadata)=>pptxMediaOrder(source.bytes,(start,end)=>mediaRange(source,source===stage,start,end));
 try{order=await inspect(file);}
 catch(error){
  // Another identical finalization can promote the parts during metadata reads.
  const committed=file===stage?await getFile(id,'pptx',projectId):null;
  if(!committed)throw new HttpError(400,(error as Error).message);
  file=committed;order=await inspect(committed);
 }
 if(file===stage){
  try{await database().batch([accessGuard(request,projectId),...promoteUpload(stage,new Date().toISOString())]);}
  catch(error){
   if(!await getFile(id,'pptx',projectId)){
    if(error instanceof Error&&error.message.includes('studio_quota_exceeded'))throw new HttpError(409,'存储容量不足，请清理后重试。');
    throw new HttpError(409,'上传状态已变更，请恢复上传。');
   }
  }
 }
 return json({id,bytes:file.bytes,pages:order.map(s=>s.path),sourceIds:order.map(s=>s.id)});
}

const r2FinishSchema=z.union([finishUploadSchema,z.object({kind:z.literal('slide')}).strict()]);

async function receiveR2Media(request:Request,projectId:string,path:string[]){
 const policy=await r2WritePolicy(projectId);
 if(!policy)throw new HttpError(404,'此项目仍使用原上传方式。');
 if(path.length===1&&request.method==='GET')return json({maxDeckBytes:policy.max_deck_bytes});
 if(request.method!=='POST')throw new HttpError(405,'不支持此操作');
 sameOrigin(request);
 if(path.length===1){
  const input=r2UploadSchema.parse(await payload(request));
  await projectLimit(projectId,'r2-media-start',320,900);
  return json(await startR2Upload(request,projectId,input,policy.max_deck_bytes));
 }
 if(path.length!==3)throw new HttpError(404,'接口不存在');
 const id=r2Id.parse(path[1]),action=path[2];
 await projectLimit(projectId,'r2-media-parts',800,900);
 if(action==='cancel')return json(await cancelR2Upload(request,projectId,id));
 if(/^\d$/.test(action))return json(await putR2Part(request,projectId,id,Number(action)));
 if(action!=='finish')throw new HttpError(404,'接口不存在');
 const input=r2FinishSchema.parse(await payload(request));
 if(input.kind==='audio'&&id!==input.recording.id)throw new HttpError(409,'录音标识不符。');
 try{
  return await finishR2Upload(request,projectId,id,input.kind,async(file,read,persist)=>{
   if(input.kind==='audio'){
    if(file.mime!==input.mime)throw new HttpError(409,'录音格式不符。');
    return commitRecording(request,projectId,input.recording,input.mime,file.hash,persist?(_,at)=>persist(at):null);
   }
   let order;
   if(input.kind==='pptx'){
    try{order=await pptxMediaOrder(file.bytes,read);}
    catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'PPTX 页序或压缩结构无效。');}
   }
   if(persist)await database().batch([accessGuard(request,projectId),...persist(new Date().toISOString())]);
   return json(order?{id,bytes:file.bytes,pages:order.map(page=>page.path),sourceIds:order.map(page=>page.id)}
    :{id,bytes:file.bytes,mime:file.mime});
  });
 }catch(error){
  console.warn('studio-r2-finish-failed',input.kind,error instanceof HttpError?error.status:500);
  throw error;
 }
}

async function serveProjectFile(request:Request,projectId:string,id:string,kind:'audio'|'slide'|'pptx'){
 const file=await getFile(id,kind,projectId);
 if(!file)throw new HttpError(404,'资源不存在。');
 if(kind==='audio'&&request.method==='GET')await database().prepare(`INSERT INTO rehearsal_audio_leases
  SELECT project_id,id,? FROM rehearsal_recordings WHERE project_id=? AND id=?
  ON CONFLICT(project_id,recording_id) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)`).bind(Date.now()+120000,projectId,id).run();
 return serveFile(request,file);
}
export async function handleRehearsal(request:Request,path:string[],admin=false,routeProjectId?:string):Promise<Response>{
 try{
  if(admin)throw new HttpError(404,'接口不存在');
  if(path.join('/')==='projects'){if(request.method==='GET')return json({projects:await listProjects(admin)});if(admin&&request.method==='POST')return await manageProject(request);throw new HttpError(405,'不支持此操作')}
  if(!admin&&request.method==='POST'&&path.join('/')==='access')return await enterRehearsal(request);
  const projectId=admin?(request.headers.get('X-Studio-Project')?requestProject(request):'current'):await requireRehearsal(request,routeProjectId);
  if(path[0]==='uploads')return await receiveMedia(request,projectId,path);
  if(path[0]==='r2-uploads')return await receiveR2Media(request,projectId,path);
  const editing=admin||path[0]==='edit';if(!admin&&editing)path=path.slice(1);
  if(editing){
   if(request.method==='GET'&&['slides','audio','pptx'].includes(path[0])&&path.length===2)return await serveProjectFile(request,projectId,path[1],path[0]==='slides'?'slide':path[0] as 'audio'|'pptx');
   if(request.method==='GET'&&path.join('/')==='capacity')return json(await deckCapacity(projectId));
   if(request.method==='GET'&&path.join('/')==='draft')return json({project:await getProject(projectId)});
   if(request.method==='GET'&&!path.length){const project=await getProject(projectId),rs=await recordings(projectId),usage=await database().prepare(`SELECT COALESCE(sum(bytes),0) AS bytes FROM ${await mediaFileTable()} WHERE project_id=?`).bind(projectId).first();if(!project)throw new HttpError(404,'汇报不存在或已删除。');return json({project,recordings:rs,progress:await turnProgress(projectId),estimate:estimateProject(project,rs),usage})}
   if(request.method!=='POST')throw new HttpError(405,'不支持此操作');sameOrigin(request);if(['slides','pptx','preview-page','preview-budget'].includes(path[0])){await rateLimit(request,'file-upload:'+projectId,240,900);await projectLimit(projectId,'file-upload',300,900)}
   switch(path.join('/')){case '':return await saveProject(request,projectId);case 'draft':return await saveProject(request,projectId,'draft');case 'publish':return await saveProject(request,projectId,'publish');case 'slides':return await uploadSlide(request,projectId);case 'pptx':return await uploadDeck(request,projectId);case 'preview-page':return await uploadPreviewPage(request,projectId);case 'preview-budget':return json(await previewBudget(projectId,deckBudgetSchema.parse(await payload(request)),(await r2WritePolicy(projectId))?.max_deck_bytes));case 'recordings':return await reviewRecording(request,projectId);case 'cleanup':return await cleanup(request,projectId);default:throw new HttpError(404,'接口不存在')}
  }
  if(request.method==='POST'&&path.join('/')==='recordings')return await submitRecording(request,projectId);
  const endpoint=path.join('/');
  if(request.method==='POST'&&endpoint==='playback/choice'){
   const body=z.object({release_id:z.string().min(1).max(80),turn_uid:z.string().min(1).max(80),recording_id:z.string().uuid().nullable(),selection_revision:z.number().int().nonnegative()}).strict().parse(await payload(request));
   await chooseRecording(projectId,body.release_id,body.turn_uid,body.recording_id,body.selection_revision,accessGuard(request,projectId));return json({ok:true});
  }
  if(request.method==='POST'&&endpoint==='playback/session'){
   const body=z.object({release_id:z.string().min(1).max(80)}).strict().parse(await payload(request));
   await rateLimit(request,'playback-manifest',60,600);
   const release=await getRelease(projectId,body.release_id);
   if(!release)throw new HttpError(404,'发布版本不存在。');
   try{return json(await playbackManifest(release,accessGuard(request,projectId)));}catch{throw new HttpError(409,'回放清单已更新，请重试。');}
  }
  if(!['GET','HEAD'].includes(request.method))throw new HttpError(405,'不支持此操作');
  if(['audio','slides','pptx'].includes(path[0])&&path.length===2)return await serveProjectFile(request,projectId,path[1],path[0]==='slides'?'slide':path[0] as 'audio'|'pptx');
  let p=await getProject(projectId,true);
  if(p&&isVisible(p)){
   await importLegacyReleases(projectId,p,accessGuard(request,projectId));
   const head=await releaseHead(projectId);
   if(head)p={...p,releaseId:head.release_id};
  }
  if(path[0]==='releases'){
   if(!p||!isVisible(p))throw new HttpError(404,'汇报尚未发布。');
   if(path.length===1){
    const rows=await database().prepare('SELECT release_id,release_no,created_at FROM rehearsal_releases WHERE project_id=? ORDER BY release_no DESC').bind(projectId).all();
    return json({releases:rows.results,head:p.releaseId});
   }
   const row=await getRelease(projectId,path[1]);
   if(!row)throw new HttpError(404,'发布版本不存在。');
   const snapshot=releaseProject(row);
   const rs=await releaseRecordings(snapshot,await slideHashes(projectId));
   const choices=(await database().prepare('SELECT turn_uid,selection_revision FROM rehearsal_playback_choices WHERE project_id=? AND release_id=?').bind(projectId,row.release_id).all()).results;
   const turns=await releaseTurns(projectId,row.release_id);
   return json({project:snapshot,recordings:rs,choices,turns});
  }
  const available=async(p:Project)=>p.releaseId?releaseRecordings(p,await slideHashes(projectId)):recordings(projectId);
  if(!path.length){
   const visible=p&&isVisible(p)?p:null,rs=visible?await available(visible):[];
   return json({project:visible,recordings:rs,progress:visible?await turnProgress(projectId):[],estimate:visible?estimateProject(visible,rs):null});
  }
  if(!p||!isVisible(p))throw new HttpError(404,'汇报尚未发布。');
  const rs=await available(p),estimate=estimateProject(p,rs);
  if(path[0]==='algorithm')return json({version:p.algorithmVersion,config:p.config});
  if(path[0]==='recordings')return json({recordings:rs});
  if(path[0]==='playback')return json(buildTimeline(p,rs));
  if(path[0]==='members'&&path.length===2){const member=p.members.find(m=>m.id===path[1]&&m.enabled);if(!member)throw new HttpError(404,'成员不存在');return json({member,blocks:p.blocks.filter(b=>b.memberId===member.id),turns:turnsFor(p).filter(t=>t.memberId===member.id),estimate:estimate.turns.filter(t=>t.memberId===member.id),recordings:rs.filter(r=>r.memberId===member.id)})}
  throw new HttpError(404,'接口不存在');
 }catch(error){if(error instanceof z.ZodError)return json({error:'提交字段无效：'+error.issues.map(i=>i.path.join('.')+': '+i.message).join('；')},400);if(error instanceof HttpError)return json({error:error.message},error.status);console.error('rehearsal-request-failed');return json({error:'排练服务暂不可用，内容已保留，请重试。'},500)}
}
