import {env} from 'cloudflare:workers';
import {createHash,randomBytes,timingSafeEqual,createHmac} from 'node:crypto';
import {database} from './data';
import {HttpError,nativeRequest} from './http';
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export const randomSecret=()=>randomBytes(32).toString('hex');
export function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
// Each deployment creates an independent D1 secret. It is not an operator password
// or a shared owner backdoor, and cannot be used as any project's owner credential.
let saltPromise:Promise<string>|undefined;
async function loadDeploymentSalt(){const db=database();await db.prepare("INSERT OR IGNORE INTO studio_settings(id,value) VALUES ('verifier-salt',?)").bind(randomSecret()).run();return (await db.prepare("SELECT value FROM studio_settings WHERE id='verifier-salt'").first<{value:string}>())!.value}
async function deploymentSalt(){return saltPromise??=(loadDeploymentSalt().catch(e=>{saltPromise=undefined;throw e}))}
export async function codeDigest(projectId:string,code:string){return createHmac('sha256',await deploymentSalt()).update('editor-code:'+projectId+':'+code).digest('hex')}
export function cookie(request:Request,key:string){return request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(key+'='))?.slice(key.length+1)||''}
export function sessionToken(request:Request){return nativeRequest(request)?request.headers.get('X-Studio-Session')||'':cookie(request,'studio_session')}
export function anonymousToken(request:Request){return nativeRequest(request)?request.headers.get('X-Studio-Anonymous')||'':cookie(request,'studio_anonymous')}
export function setCookie(name:string,value:string,seconds:number){return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`}
export function guard(sql:string,...values:(string|number)[]){return database().prepare('INSERT INTO rehearsal_write_guards(id,allowed) SELECT ?,CASE WHEN '+sql+' THEN 1 ELSE 0 END').bind(crypto.randomUUID(),...values)}
export function sessionGuard(request:Request,id:string,owner=false){return guard(`EXISTS(SELECT 1 FROM studio_sessions s JOIN rehearsal_projects p ON p.id=s.project_id LEFT JOIN studio_owner_credentials o ON o.project_id=p.id LEFT JOIN studio_admin_passwords a ON a.project_id=p.id WHERE s.token_hash=? AND s.project_id=? AND s.expires_at>? AND p.deleted_at IS NULL AND s.credential_version=CASE WHEN s.role='owner' THEN COALESCE(a.credential_version,o.credential_version) ELSE p.credential_version END AND (s.role='owner' OR p.archived_at IS NULL) ${owner?"AND s.role='owner'":''})`,digest(sessionToken(request)),id,Date.now())}
export async function authorize(request:Request,id:string,owner=false){const row=await database().prepare(`SELECT s.role FROM studio_sessions s JOIN rehearsal_projects p ON p.id=s.project_id LEFT JOIN studio_owner_credentials o ON o.project_id=p.id LEFT JOIN studio_admin_passwords a ON a.project_id=p.id WHERE s.token_hash=? AND s.project_id=? AND s.expires_at>? AND p.deleted_at IS NULL AND s.credential_version=CASE WHEN s.role='owner' THEN COALESCE(a.credential_version,o.credential_version) ELSE p.credential_version END AND (s.role='owner' OR p.archived_at IS NULL)`).bind(digest(sessionToken(request)),id,Date.now()).first<{role:'owner'|'editor'}>();if(!row)throw new HttpError(401,'项目访问已失效，请重新验证。');if(owner&&row.role!=='owner')throw new HttpError(403,'此操作需要管理员权限。');return row.role}
async function limit(scope:string,max:number,seconds:number){const expires=(Math.floor(Date.now()/1000/seconds)+1)*seconds*1000;const key=digest((await deploymentSalt())+':'+scope+':'+expires);const r=await database().prepare('INSERT INTO studio_limits VALUES (?,1,?) ON CONFLICT(scope_hash) DO UPDATE SET count=count+1 RETURNING count').bind(key,expires).first<{count:number}>();if(!r||r.count>max)throw new HttpError(429,'尝试过于频繁，请稍后重试。')}
export async function rateLimit(request:Request,scope:string,max:number,seconds:number){const ip=request.headers.get('CF-Connecting-IP')||'local';await limit('ip:'+ip+':'+scope,max,seconds)}
export async function projectLimit(id:string,scope:string,max:number,seconds:number){await limit('project:'+id+':'+scope,max,seconds)}
export async function globalLimit(scope:string,max:number,seconds:number){await limit('global:'+scope,max,seconds)}
export function audit(id:string,role:string,action:string){return database().prepare('INSERT INTO studio_audit VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),id,role,action,Date.now())}
export function sessionSeconds(){const n=Number(env.STUDIO_SESSION_DAYS||'7');return (Number.isInteger(n)&&n>=1&&n<=30?n:7)*86400}
export function sessionExpires(){return Date.now()+sessionSeconds()*1000}
export function sessionResponse(data:unknown,token:string,request:Request,status=200){const headers=new Headers({'Cache-Control':'private, no-store','Set-Cookie':setCookie('studio_session',token,sessionSeconds())});return Response.json({...data as object,...(nativeRequest(request)?{session_token:token}:{})},{status,headers})}
