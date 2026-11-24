'use client';
import {apiFetch,acceptAnonymous} from './transport';
import {selectRehearsal,rehearsalHeaders} from './rehearsal/session';
export class ApiError extends Error {
 constructor(public status:number,message:string){super(message);this.name='ApiError'}
}
export async function api(path:string,body?:unknown,method='POST'){
 const c=new AbortController(),timer=setTimeout(()=>c.abort(),20000);
 try{const r=await apiFetch(path,{method:body===undefined?'GET':method,headers:{...rehearsalHeaders(),...(body===undefined?{}:{'Content-Type':'application/json'})},credentials:'same-origin',cache:'no-store',signal:c.signal,body:body===undefined?undefined:JSON.stringify(body)});const data:any=await r.json();if(!r.ok)throw new ApiError(r.status,data.error||'操作失败');acceptAnonymous(data.anonymous_token);if(data.project_id&&data.session_token)selectRehearsal(data.project_id,data.session_token);return data}finally{clearTimeout(timer)}
}
