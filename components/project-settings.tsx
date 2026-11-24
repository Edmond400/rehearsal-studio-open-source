'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useState} from 'react';
import {api} from '@/lib/client';
import {saveBlob} from '@/lib/transport';

export type ProjectStatus={visibility:'public'|'unlisted';archived_at:string|null;legacy_upgrade_required:number;bytes:number;max_bytes:number};
type Action='code'|'password'|'visibility'|'archive'|'delete';
export function ProjectSettings({id,status,onStatus,onDelete}:{id:string;status:ProjectStatus;onStatus:(status:ProjectStatus)=>void;onDelete:()=>void}){
 const [action,setAction]=useState<Action|null>(null),[password,setPassword]=useState(''),[newValue,setNewValue]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const owner=(path:string,body?:unknown)=>api('/api/projects/'+id+'/owner/'+path,body);
 function choose(action:Action|null){setAction(action);setPassword('');setNewValue('');setError('');setMessage('')}
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function submit(){
  if(!action)return;
  await run(async()=>{
   if(action==='code')await owner('code',{password,code:newValue});
   if(action==='password')await owner('password',{password,new_password:newValue});
   if(action==='visibility')await owner('visibility',{password,visibility:status.visibility==='public'?'unlisted':'public'});
   if(action==='archive')await owner('archive',{password,archived:!status.archived_at});
   if(action==='delete'){
    if(!confirm('永久删除本项目及全部关联讲稿、文件、录音和历史版本？此操作无法恢复。'))return;
    await api('/api/projects/'+id,{password,confirm:true},'DELETE');onDelete();return;
   }
   choose(null);setMessage('设置已更新。');onStatus(await owner('status'));
  });
 }
 const labels={code:'修改项目密码',password:'修改管理员密码',visibility:status.visibility==='public'?'从目录隐藏':'列入公开目录',archive:status.archived_at?'恢复项目':'归档项目',delete:'永久删除项目'};
 return <section className="panel rh-pad"><h3>项目属性与权限</h3>
  <p>目录：{status.visibility==='public'?'公开':'仅凭链接加入'} · 文件 {(status.bytes/1048576).toFixed(2)} / {(status.max_bytes/1048576).toFixed(0)} MiB</p>
  <div className="rh-actions">{(Object.keys(labels) as Action[]).map(a=><button key={a} disabled={busy} onClick={()=>choose(a)}>{labels[a]}</button>)}
   <button disabled={busy} onClick={()=>void run(async()=>{const manifest=await owner('export');await saveBlob(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'}),'project-'+id+'.json');setMessage('已导出项目清单；文件内容仍可通过项目下载。')})}>导出资料清单</button>
  </div>
  {action&&<form onSubmit={e=>{e.preventDefault();void submit()}}>
   <h3>{labels[action]}</h3>
   {action==='code'&&<p>修改后，原组员会话将失效。</p>}
   {action==='visibility'&&status.visibility==='unlisted'&&<p>目录将显示名称、时长、状态和更新时间。讲稿和录音仍需密码。</p>}
   <label>当前管理员密码<input type="password" required maxLength={256} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
   {action==='code'&&<label>新项目密码<input type="password" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={newValue} onChange={e=>setNewValue(e.target.value)}/></label>}
   {action==='password'&&<label>新管理员密码<input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={newValue} onChange={e=>setNewValue(e.target.value)}/></label>}
   {action==='password'&&<p className="muted">管理员密码至少 8 位，可使用纯数字，请妥善保管。</p>}<div className="rh-actions"><button className="btn" disabled={busy}>确认{labels[action]}</button><button type="button" disabled={busy} onClick={()=>choose(null)}>取消</button></div>
  </form>}
  {error&&<p role="alert" className="callout error">{error}<ErrorContact /></p>}{message&&<p role="status">{message}</p>}
 </section>;
}
