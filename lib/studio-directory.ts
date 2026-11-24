import {database} from './data';
import {HttpError,json} from './http';
import {rateLimit} from './security';

export const visibilityValues=['public','unlisted'] as const;
const iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const projectId=/^[a-zA-Z0-9_-]{1,80}$/;
export async function directory(request:Request){
 const url=new URL(request.url),q=(url.searchParams.get('q')||'').trim(),raw=url.searchParams.get('cursor')||'',limitRaw=url.searchParams.get('limit')||'20';
 if(q.length>80||/[%_*?\p{Cc}]/u.test(q)||raw.length>256||!/^\d{1,2}$/.test(limitRaw))throw new HttpError(400,'目录搜索条件无效。');
 const limit=Number(limitRaw);
 if(limit<1||limit>20)throw new HttpError(400,'每页最多 20 条。');
 let cursor:{t:string;i:string;q:string}|null=null;
 if(raw){
  try{
   if(!/^[a-zA-Z0-9_-]+$/.test(raw))throw new Error();
   cursor=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
   if(!cursor||!iso.test(cursor.t)||!projectId.test(cursor.i)||cursor.q!==q)throw new Error();
  }catch{throw new HttpError(400,'目录页码已失效，请重新搜索。')}
 }
 await rateLimit(request,'directory',100,60);
 const rows=(await database().prepare(`SELECT p.id,p.title,CAST(json_extract(p.document_json,'$.config.hardLimitSeconds') AS INTEGER) AS duration_seconds,p.status,p.updated_at
 FROM rehearsal_projects p JOIN studio_project_visibility v ON v.project_id=p.id AND v.visibility='public'
 WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
 AND (?='' OR instr(lower(p.title),lower(?))>0)
 AND (? IS NULL OR p.updated_at<? OR (p.updated_at=? AND p.id<?))
 ORDER BY p.updated_at DESC,p.id DESC LIMIT ?`).bind(q,q,cursor?.t??null,cursor?.t??null,cursor?.t??null,cursor?.i??null,limit+1).all<{id:string;title:string;duration_seconds:number;status:string;updated_at:string}>()).results;
 const projects=rows.slice(0,limit),last=projects.at(-1);
 return json({projects,next_cursor:rows.length>limit&&last?Buffer.from(JSON.stringify({t:last.updated_at,i:last.id,q})).toString('base64url'):null});
}
