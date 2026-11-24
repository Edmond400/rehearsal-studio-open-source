import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {database} from './data';
import {HttpError,json,readJson,sameOrigin,nativeRequest} from './http';
import {digest,randomSecret,equal,codeDigest,anonymousToken,setCookie,sessionToken,guard,sessionGuard,authorize,rateLimit,projectLimit,globalLimit,audit,sessionResponse,sessionExpires} from './security';
import {newAdminCredential,verifyAdminPassword,requireAdminPassword,protectedCodeDigest,creationInputDigest,passwordPepperConfigured} from './admin-password';
import {projectCredential,adminCredential,reauthenticate,ownerSessionStatements,insertAdminPassword} from './studio-credentials';
import {directory,visibilityValues} from './studio-directory';
import {DEFAULT_CONFIG,type Project} from './rehearsal/model';
import {handleRehearsal,saveProject} from './rehearsal/service';

const idPattern=/^[a-zA-Z0-9_-]{1,80}$/;
const hex=/^[a-f0-9]{64}$/;
const CODE=/^\d{4}$/;
const password=z.string().min(1).max(256);
const visibility=z.enum(visibilityValues);
const POW_BITS=16;
const invalid='项目或凭证不正确，请核对后重试。';
export function validProof(nonce:string,solution:string){const h=Buffer.from(digest(nonce+':'+solution),'hex');return h[0]===0&&h[1]===0}

async function challenge(request:Request){
 sameOrigin(request);await rateLimit(request,'create-challenge',30,3600);
 const prior=anonymousToken(request),anonymous=hex.test(prior)?prior:randomSecret(),nonce=randomSecret(),expires=Date.now()+300000,db=database();
 await db.batch([db.prepare('DELETE FROM studio_challenges WHERE expires_at<?').bind(Date.now()),db.prepare('DELETE FROM studio_limits WHERE expires_at<?').bind(Date.now()),db.prepare('DELETE FROM studio_sessions WHERE expires_at<?').bind(Date.now()),db.prepare('INSERT INTO studio_challenges VALUES (?,?,?)').bind(nonce,digest(anonymous),expires)]);
 return Response.json({nonce,bits:POW_BITS,expires_at:expires,...(nativeRequest(request)?{anonymous_token:anonymous}:{})},{headers:{'Set-Cookie':setCookie('studio_anonymous',anonymous,3600),'Cache-Control':'no-store'}});
}

async function startSession(request:Request,id:string,legacyRoute?:'owner'|'editor'){
 const body=await readJson(request);
 const secret=legacyRoute?z.object({secret:password}).strict().parse(body).secret:z.object({password}).strict().parse(body).password;
 await rateLimit(request,'verify:'+id,10,900);await projectLimit(id,'verify',100,900);await globalLimit('verify',300,60);
 const row=await projectCredential(id),admin=adminCredential(row);
 const code=CODE.test(secret);
 const legacy=!!row?.secret_digest&&!admin&&hex.test(secret)&&equal(digest(secret),row.secret_digest);
 // For a unified login, both password classes and nonexistent projects incur
 // the same KDF work. Old clients have explicit role-specific routes.
 const modern=(!legacyRoute&&(admin||passwordPepperConfigured()))?await verifyAdminPassword(id,secret,admin):false;
 const expected=row?.password_hash||'';
 const actual=expected.startsWith('v14:')?protectedCodeDigest(id,secret):await codeDigest(id,secret);
 const editor=code&&!!row&&!row.archived_at&&equal(expected,actual)&&legacyRoute!=='owner';
 const owner=!code&&(modern||legacy)&&legacyRoute!=='editor';
 if(!row||(!owner&&!editor))throw new HttpError(401,invalid);
 const role=owner?'owner':'editor',token=randomSecret(),db=database();
 const version=owner?(row.admin_version??row.owner_version)!:row.credential_version;
 const condition=owner
  ?guard('EXISTS(SELECT 1 FROM rehearsal_projects p LEFT JOIN studio_owner_credentials o ON o.project_id=p.id LEFT JOIN studio_admin_passwords a ON a.project_id=p.id WHERE p.id=? AND p.deleted_at IS NULL AND COALESCE(a.credential_version,o.credential_version)=?)',id,version)
  :guard('EXISTS(SELECT 1 FROM rehearsal_projects WHERE id=? AND deleted_at IS NULL AND archived_at IS NULL AND credential_version=?)',id,version);
 try{await db.batch([condition,db.prepare('INSERT INTO studio_sessions VALUES (?,?,?,?,?)').bind(digest(token),id,role,version,sessionExpires()),audit(id,role,'session-created')])}
 catch{throw new HttpError(409,'项目凭证刚刚更新，请重新验证。')}
 return sessionResponse({project_id:id,role,...(owner&&legacy?{legacy_upgrade_required:true}:{})},token,request);
}

async function create(request:Request){
 const v=z.object({title:z.string().trim().min(1).max(160),seconds:z.number().int().min(60).max(10800),code:z.string().regex(CODE),admin_password:password,visibility:visibility.default('public'),challenge:z.string().regex(hex),solution:z.string().regex(/^\d{1,12}$/),request_id:z.string().regex(hex)}).strict().parse(await readJson(request));
 requireAdminPassword(v.admin_password);
 const anonymous=anonymousToken(request);if(!hex.test(anonymous))throw new HttpError(403,'创建验证已失效，请重新验证');
 const db=database(),requestHash=digest(v.request_id+':'+anonymous);
 const inputDigest=creationInputDigest(v.request_id,JSON.stringify([v.title,v.seconds,v.code,v.admin_password,v.visibility]));
 const prior=await db.prepare('SELECT project_id,created_at,input_digest FROM studio_creation_requests WHERE request_hash=?').bind(requestHash).first<{project_id:string;created_at:number;input_digest:string|null}>();
 if(prior){
  if(!prior.input_digest||!equal(prior.input_digest,inputDigest))throw new HttpError(409,'此创建请求对应的填写内容不同。请使用原填写内容重试。');
  if(prior.created_at<Date.now()-600000)throw new HttpError(409,'此汇报已经创建。请从目录或分享链接重新进入。');
  await rateLimit(request,'create-retry',10,900);
  const id=prior.project_id,credential=adminCredential(await projectCredential(id));
  if(!credential||!await verifyAdminPassword(id,v.admin_password,credential))throw new HttpError(409,'创建请求已结束，请使用当前密码进入。');
  const session=ownerSessionStatements(id,credential.credential_version,'creation-retried');
  await db.batch([guard('EXISTS(SELECT 1 FROM studio_creation_requests WHERE request_hash=? AND input_digest=?) AND EXISTS(SELECT 1 FROM studio_admin_passwords WHERE project_id=? AND credential_version=?)',requestHash,inputDigest,id,credential.credential_version),...session.statements]);
  return sessionResponse({project_id:id,role:'owner',retried:true},session.token,request);
 }
 await rateLimit(request,'create',6,3600);await globalLimit('anonymous:'+digest(anonymous),3,3600);await globalLimit('create',50,86400);
 const c=await db.prepare('SELECT anonymous_hash,expires_at FROM studio_challenges WHERE nonce=?').bind(v.challenge).first<{anonymous_hash:string;expires_at:number}>();
 if(!c||c.anonymous_hash!==digest(anonymous)||c.expires_at<Date.now()||!validProof(v.challenge,v.solution))throw new HttpError(403,'创建验证无效或已过期，请重新验证');
 const id=randomBytes(16).toString('hex'),now=new Date().toISOString();
 const credential=await newAdminCredential(id,v.admin_password),session=ownerSessionStatements(id,credential.credential_version,'created');
 const p:Project={id,title:v.title,theme:'',status:'draft',publishedAt:null,revision:0,scriptVersion:crypto.randomUUID(),deckVersion:crypto.randomUUID(),algorithmVersion:DEFAULT_CONFIG.version,members:[],blocks:[],slides:[],config:{...DEFAULT_CONFIG,hardLimitSeconds:v.seconds,planningSeconds:v.seconds},overrides:{},updatedAt:now};
 const doc=JSON.stringify(p);
 const statements=[
  guard('EXISTS(SELECT 1 FROM studio_challenges WHERE nonce=? AND anonymous_hash=? AND expires_at>?)',v.challenge,digest(anonymous),Date.now()),
  db.prepare('DELETE FROM studio_challenges WHERE nonce=?').bind(v.challenge),
  db.prepare("INSERT INTO rehearsal_projects(id,title,status,revision,script_version,deck_version,algorithm_version,document_json,updated_at,password_hash,credential_version) VALUES (?,?,'draft',0,?,?,?,?,?,?,1)").bind(id,p.title,p.scriptVersion,p.deckVersion,p.algorithmVersion,doc,now,protectedCodeDigest(id,v.code)),
  insertAdminPassword(id,credential),
  db.prepare('INSERT INTO studio_project_visibility VALUES (?,?,?)').bind(id,v.visibility,Date.now()),
  db.prepare('INSERT INTO studio_usage(project_id) VALUES (?)').bind(id),
  db.prepare('INSERT INTO studio_creation_requests(request_hash,project_id,created_at,input_digest) VALUES (?,?,?,?)').bind(requestHash,id,Date.now(),inputDigest),
  db.prepare('INSERT INTO rehearsal_versions VALUES (?,0,?,?)').bind(id,doc,now),
  ...session.statements
 ];
 try{await db.batch(statements)}catch{throw new HttpError(409,'创建未完成或此请求已成功提交。请使用同一请求重试，避免重复创建。')}
 return sessionResponse({project_id:id,role:'owner'},session.token,request,201);
}

async function ownerAction(request:Request,id:string,action:string){
 await authorize(request,id,true);const db=database();
 if(request.method==='GET'&&action==='export'){
  const tables=['rehearsal_projects','rehearsal_versions','rehearsal_members','rehearsal_recordings','rehearsal_estimates','rehearsal_turn_progress','rehearsal_files','rehearsal_releases','rehearsal_release_turns','rehearsal_recording_origins','rehearsal_recording_release_refs','rehearsal_playback_choices','rehearsal_draft_checkpoints'];
  const manifest:Record<string,unknown>={};
  for(const table of tables){
   const rows=(await db.prepare(`SELECT * FROM ${table} WHERE ${table==='rehearsal_projects'?'id':'project_id'}=?`).bind(id).all<Record<string,unknown>>()).results;
   manifest[table]=rows.map(({password_hash,credential_version,deleted_at,archived_at,...safe})=>safe);
  }
  return json({schema:2,project_id:id,generated_at:new Date().toISOString(),tables:manifest});
 }
 if(request.method==='GET'&&action==='status'){
  return json(await db.prepare(`SELECT p.archived_at,COALESCE(v.visibility,'unlisted') AS visibility,CASE WHEN a.project_id IS NULL THEN 1 ELSE 0 END AS legacy_upgrade_required,
  COALESCE((SELECT sum(bytes) FROM rehearsal_files WHERE project_id=p.id),0) AS bytes,u.max_bytes FROM rehearsal_projects p
  JOIN studio_usage u ON u.project_id=p.id LEFT JOIN studio_project_visibility v ON v.project_id=p.id LEFT JOIN studio_admin_passwords a ON a.project_id=p.id WHERE p.id=?`).bind(id).first());
 }
 if(!['POST','DELETE'].includes(request.method))throw new HttpError(404,'接口不存在');
 const v=await readJson(request);const g=()=>sessionGuard(request,id,true);
 if(action==='upgrade'&&request.method==='POST'){
  const x=z.object({owner_key:z.string().regex(hex),admin_password:password}).strict().parse(v);
  const auth=await reauthenticate(request,id,x.owner_key);
  if(auth.admin||auth.row.owner_version==null)throw new HttpError(409,'此项目已经启用管理员密码，请使用新密码登录。');
  const credential=await newAdminCredential(id,x.admin_password,auth.row.owner_version+1);
  if(!await verifyAdminPassword(id,x.admin_password,credential))throw new HttpError(500,'新凭证未通过验证，旧密钥仍可使用。');
  const session=ownerSessionStatements(id,credential.credential_version,'legacy-credential-upgraded');
  try{await db.batch([g(),auth.proof,insertAdminPassword(id,credential),db.prepare("INSERT INTO studio_project_visibility VALUES (?,'unlisted',?) ON CONFLICT(project_id) DO NOTHING").bind(id,Date.now()),db.prepare('DELETE FROM studio_owner_credentials WHERE project_id=?').bind(id),db.prepare("DELETE FROM studio_sessions WHERE project_id=? AND role='owner'").bind(id),db.prepare('DELETE FROM studio_creation_requests WHERE project_id=?').bind(id),...session.statements])}
  catch{throw new HttpError(409,'升级未提交。若没有其他管理员完成升级，原密钥仍可用。')}
  return sessionResponse({project_id:id,role:'owner'},session.token,request);
 }
 if(action==='password'&&request.method==='POST'){
  const x=z.object({password,new_password:password}).strict().parse(v),auth=await reauthenticate(request,id,x.password);
  if(!auth.admin)throw new HttpError(409,'请先升级旧管理密钥。');
  if(x.password===x.new_password)throw new HttpError(400,'新密码必须不同。');
  const next=await newAdminCredential(id,x.new_password,auth.admin.credential_version+1),session=ownerSessionStatements(id,next.credential_version,'admin-password-changed');
  await db.batch([g(),auth.proof,db.prepare('UPDATE studio_admin_passwords SET algorithm=?,iterations=?,salt=?,verifier=?,credential_version=?,upgraded_at=? WHERE project_id=?').bind(next.algorithm,next.iterations,next.salt,next.verifier,next.credential_version,Date.now(),id),db.prepare("DELETE FROM studio_sessions WHERE project_id=? AND role='owner'").bind(id),db.prepare('DELETE FROM studio_creation_requests WHERE project_id=?').bind(id),...session.statements]);
  return sessionResponse({project_id:id,role:'owner'},session.token,request);
 }
 if(action==='code'&&request.method==='POST'){
  const x=z.object({password,code:z.string().regex(CODE)}).strict().parse(v),auth=await reauthenticate(request,id,x.password);
  await db.batch([g(),auth.proof,db.prepare('UPDATE rehearsal_projects SET password_hash=?,credential_version=credential_version+1 WHERE id=?').bind(protectedCodeDigest(id,x.code),id),db.prepare("DELETE FROM studio_sessions WHERE project_id=? AND role='editor'").bind(id),db.prepare('DELETE FROM studio_creation_requests WHERE project_id=?').bind(id),audit(id,'owner','code-changed')]);
  return json({ok:true});
 }
 if(action==='visibility'&&request.method==='POST'){
  const x=z.object({password,visibility}).strict().parse(v),auth=await reauthenticate(request,id,x.password);
  if(!auth.admin)throw new HttpError(409,'请先升级旧管理密钥。');
  await db.batch([g(),auth.proof,db.prepare('INSERT INTO studio_project_visibility VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET visibility=excluded.visibility,updated_at=excluded.updated_at').bind(id,x.visibility,Date.now()),audit(id,'owner','directory-visibility-changed')]);
  return json({ok:true,visibility:x.visibility});
 }
 if(action==='archive'&&request.method==='POST'){
  const x=z.object({password,archived:z.boolean()}).strict().parse(v),auth=await reauthenticate(request,id,x.password);
  await db.batch([g(),auth.proof,db.prepare('UPDATE rehearsal_projects SET archived_at=? WHERE id=?').bind(x.archived?new Date().toISOString():null,id),db.prepare("DELETE FROM studio_sessions WHERE project_id=? AND role='editor'").bind(id),audit(id,'owner',x.archived?'archived':'restored')]);return json({ok:true});
 }
 if(action==='delete'&&request.method==='DELETE'){
  const x=z.object({password,confirm:z.literal(true)}).strict().parse(v),auth=await reauthenticate(request,id,x.password);
  await db.batch([g(),auth.proof,db.prepare('DELETE FROM rehearsal_projects WHERE id=?').bind(id)]);
  return Response.json({deleted:true,irreversible:true},{headers:{'Set-Cookie':setCookie('studio_session','',0),'Cache-Control':'no-store'}});
 }
 throw new HttpError(404,'接口不存在');
}

export async function handleProjects(request:Request,path:string[]):Promise<Response>{
 try{
  if(path.join('/')==='challenge'&&request.method==='POST')return await challenge(request);
  if(path.join('/')==='directory'&&request.method==='GET')return await directory(request);
  if(!path.length&&request.method==='POST')return await create(request);
  const [id,...tail]=path;if(!id||!idPattern.test(id))throw new HttpError(404,'接口不存在');
  if(request.method==='POST'&&tail.join('/')==='session')return await startSession(request,id);
  if(request.method==='POST'&&tail.join('/')==='join')return await startSession(request,id,'editor');
  if(request.method==='POST'&&tail.join('/')==='owner-session')return await startSession(request,id,'owner');
  if(tail[0]==='owner'&&tail.length===2)return await ownerAction(request,id,tail[1]);
  if(!tail.length&&request.method==='DELETE')return await ownerAction(request,id,'delete');
  if(request.method==='POST'&&tail.join('/')==='logout'){sameOrigin(request);await database().prepare('DELETE FROM studio_sessions WHERE project_id=? AND token_hash=?').bind(id,digest(sessionToken(request))).run();return Response.json({ok:true},{headers:{'Set-Cookie':setCookie('studio_session','',0),'Cache-Control':'no-store'}})}
  if(request.method==='GET'&&tail[0]==='versions'){await authorize(request,id);return json({versions:(await database().prepare('SELECT revision,changed_at FROM rehearsal_versions WHERE project_id=? UNION SELECT draft_revision AS revision,created_at AS changed_at FROM rehearsal_draft_checkpoints WHERE project_id=? ORDER BY revision DESC LIMIT 100').bind(id,id).all()).results})}
  if(request.method==='POST'&&tail[0]==='restore'){
   await authorize(request,id);
   const v=z.object({revision:z.number().int().min(0),expected_revision:z.number().int().min(0)}).strict().parse(await readJson(request));const row=await database().prepare('SELECT document_json FROM rehearsal_versions WHERE project_id=? AND revision=? UNION ALL SELECT document_json FROM rehearsal_draft_checkpoints WHERE project_id=? AND draft_revision=? LIMIT 1').bind(id,v.revision,id,v.revision).first<{document_json:string}>();if(!row)throw new HttpError(404,'版本不存在');const {id:_,scriptVersion,deckVersion,algorithmVersion,updatedAt,...body}=JSON.parse(row.document_json);const headers=new Headers(request.headers);headers.set('Content-Type','application/json');return await saveProject(new Request(request.url,{method:'POST',headers,body:JSON.stringify({...body,revision:v.expected_revision,status:'draft'})}),id);
  }
  return await handleRehearsal(request,tail,false,id);
 }catch(error){if(error instanceof z.ZodError)return json({error:'提交字段无效'},400);if(error instanceof HttpError)return json({error:error.message},error.status);return json({error:'服务暂时不可用，已保存内容保留。'},500)}
}
