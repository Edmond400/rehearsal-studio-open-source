import {database} from './data';
import {type AdminCredential,verifyAdminPassword} from './admin-password';
import {HttpError} from './http';
import {audit,digest,equal,guard,randomSecret,rateLimit,projectLimit,sessionExpires} from './security';

export type ProjectCredential={
 password_hash:string|null;credential_version:number;archived_at:string|null;
 secret_digest:string|null;owner_version:number|null;
 algorithm:string|null;iterations:number|null;salt:string|null;verifier:string|null;admin_version:number|null;
};
export async function projectCredential(id:string){
 return database().prepare(`SELECT p.password_hash,p.credential_version,p.archived_at,
 o.secret_digest,o.credential_version AS owner_version,a.algorithm,a.iterations,a.salt,a.verifier,a.credential_version AS admin_version
 FROM rehearsal_projects p LEFT JOIN studio_owner_credentials o ON o.project_id=p.id
 LEFT JOIN studio_admin_passwords a ON a.project_id=p.id WHERE p.id=? AND p.deleted_at IS NULL`).bind(id).first<ProjectCredential>();
}
export function adminCredential(row:ProjectCredential|null):AdminCredential|null{
 return row?.admin_version==null?null:{algorithm:row.algorithm!,iterations:row.iterations!,salt:row.salt!,verifier:row.verifier!,credential_version:row.admin_version};
}
export async function reauthenticate(request:Request,id:string,password:unknown){
 await rateLimit(request,'reauth:'+id,8,900);await projectLimit(id,'reauth',50,900);
 const row=await projectCredential(id),admin=adminCredential(row);
 if(typeof password!=='string'||password.length<1||password.length>256)throw new HttpError(403,'请重新验证管理员凭证。');
 const verified=admin?await verifyAdminPassword(id,password,admin):!!row?.secret_digest&&equal(row.secret_digest,digest(password));
 if(!row||!verified)throw new HttpError(403,'管理员凭证不正确。');
 return {row,admin,proof:admin?guard('EXISTS(SELECT 1 FROM studio_admin_passwords WHERE project_id=? AND credential_version=? AND verifier=?)',id,admin.credential_version,admin.verifier):guard('EXISTS(SELECT 1 FROM studio_owner_credentials WHERE project_id=? AND credential_version=? AND secret_digest=?) AND NOT EXISTS(SELECT 1 FROM studio_admin_passwords WHERE project_id=?)',id,row.owner_version!,row.secret_digest!,id)};
}
export function ownerSessionStatements(id:string,version:number,action:string){
 const token=randomSecret();
 return {token,statements:[
  database().prepare("INSERT INTO studio_sessions VALUES (?,?,'owner',?,?)").bind(digest(token),id,version,sessionExpires()),
  audit(id,'owner',action)
 ]};
}
export function insertAdminPassword(id:string,a:AdminCredential){
 return database().prepare('INSERT INTO studio_admin_passwords(project_id,algorithm,iterations,salt,verifier,credential_version,upgraded_at) VALUES (?,?,?,?,?,?,?)').bind(id,a.algorithm,a.iterations,a.salt,a.verifier,a.credential_version,Date.now());
}
