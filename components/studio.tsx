'use client';
import {ErrorContact} from '@/components/developer-contact';
import {clearTransport,projectLink} from '@/lib/transport';
import {useEffect,useState,useRef} from 'react';
import {CreationAttempt} from '@/lib/creation-client';
import {api} from '@/lib/client';
import {selectRehearsal,leaveRehearsal} from '@/lib/rehearsal/session';
import type {Project,Recording,Estimate,TurnProgress} from '@/lib/rehearsal/model';
import {formatTime} from '@/lib/rehearsal/model';
import {RehearsalAdmin} from './rehearsal/admin';
import {Practice} from './rehearsal/practice';
import {ReleasePlayback} from './rehearsal/release-playback';
import {EstimatePanel} from './rehearsal/shared';
import {ReadingPreview} from './rehearsal/reading-preview';
import {PresentationDownload} from './rehearsal/presentation-download';
import {AlgorithmNotes} from './rehearsal/algorithm-notes';
import {ProjectDirectory} from './project-directory';
import type {ProjectStatus} from './project-settings';
import {WorkspaceSidebar} from './workspace-sidebar';

type Data={project:Project|null;recordings:Recording[];progress:TurnProgress[];estimate:Estimate|null};
type Mode='home'|'create'|'join'|'upgrade';
type Role='owner'|'editor';
function inviteId(value:string){
 try{
  const url=new URL(value.trim()),id=url.pathname.match(/^\/p\/([a-zA-Z0-9_-]{1,80})\/?$/)?.[1];
  if(id&&url.origin===new URL(projectLink(id)).origin&&!url.username&&!url.password)return id;
 }catch{}
 throw new Error('请粘贴完整的汇报分享链接。');
}

export function Studio({initialId=''}:{initialId?:string}){
 const [mode,setMode]=useState<Mode>(initialId?'join':'home'),[id,setId]=useState(initialId),[link,setLink]=useState(''),[title,setTitle]=useState(''),[minutes,setMinutes]=useState(15);
 const [code,setCode]=useState(''),[adminPassword,setAdminPassword]=useState(''),[hidden,setHidden]=useState(false),[secret,setSecret]=useState(''),[role,setRole]=useState<Role|null>(null);
 const [data,setData]=useState<Data|null>(null),[editing,setEditing]=useState(false),[member,setMember]=useState(''),[practicing,setPracticing]=useState(false);
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState<ProjectStatus|null>(null),[versions,setVersions]=useState<{revision:number;changed_at:string}[]>([]);
 const creation=useRef<CreationAttempt|null>(null);
 if(!creation.current)creation.current=new CreationAttempt();

 function chooseProject(pid:string){setId(pid);setSecret('');setAdminPassword('');setLink('');setMode('join');setError('')}
 useEffect(()=>{if(initialId){setId(initialId);setMode('join')}},[initialId]);
 useEffect(()=>{
  const back=(e:Event)=>{
   if(e.defaultPrevented)return;
   if(practicing||editing){e.preventDefault();if(confirm('请先保存讲稿或录音，确定返回？')){setPracticing(false);setEditing(false)}return}
   if(mode!=='home'&&!data){e.preventDefault();setMode('home');setSecret('');setAdminPassword('');setId('')}
  };
  window.addEventListener('studio:native-back',back);return()=>window.removeEventListener('studio:native-back',back);
 },[practicing,editing,mode,data]);
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn()}catch(e){setMessage('');setError((e as Error).message)}finally{setBusy(false)}}
 async function load(pid=id,activeRole=role){selectRehearsal(pid);const result=await api('/api/rehearsal');const settings=activeRole==='owner'?await api('/api/projects/'+pid+'/owner/status'):null;setData(result);setStatus(settings);return result}
 async function create(){
  await run(async()=>{
   const r=await creation.current!.submit({title,seconds:Math.round(minutes*60),code,admin_password:adminPassword,visibility:hidden?'unlisted':'public'},()=>setMessage('正在完成创建验证…'));
   selectRehearsal(r.project_id);setId(r.project_id);setRole('owner');setCode('');setAdminPassword('');setTitle('');setMode('join');
   await load(r.project_id,'owner');setEditing(true);setMessage('汇报已创建，可以开始编排。');
  });
 }
 async function enter(){
  await run(async()=>{
   const pid=id||inviteId(link);selectRehearsal(pid);setId(pid);
   const r=await api('/api/projects/'+pid+'/session',{password:secret});
   if(r.legacy_upgrade_required){setMode('upgrade');return}
   setRole(r.role);setSecret('');setMessage('');await load(pid,r.role);
  });
 }
 async function upgrade(){
  await run(async()=>{
   await api('/api/projects/'+id+'/owner/upgrade',{owner_key:secret,admin_password:adminPassword});
   setRole('owner');setSecret('');setAdminPassword('');setMode('join');await load(id,'owner');setMessage('管理员密码已启用，原管理密钥已失效。');
  });
 }
 function reset(){
  leaveRehearsal();clearTransport();setData(null);setRole(null);setEditing(false);setMember('');setPracticing(false);setMode('home');setId('');setLink('');setStatus(null);setVersions([]);setSecret('');setAdminPassword('');
 }
 async function exit(){if(editing&&!window.dispatchEvent(new Event('studio:leave-editor',{cancelable:true})))return;if(!confirm('请先保存未同步的讲稿或录音。确认退出？'))return;await run(async()=>{await api('/api/projects/'+id+'/logout',{});reset();setMessage('已退出。')})}
 const [workspace,setWorkspace]=useState<'practice'|'playback'>('practice');
 const p=data?.project;
 return <div className="rh-root">
  {!data&&<div className="page-heading"><div><p className="eyebrow">独立模拟汇报平台</p><h1>{p?.title||(data?'汇报工作台':'让小组汇报，从容开场。')}</h1></div></div>}
  {error&&<p className="callout error" role="alert">{error}<ErrorContact /></p>}{message&&<p role="status">{message}</p>}
  {!data&&<section className="panel rh-pad">
   {mode==='home'?<><p>无需注册。创建汇报或选择公开汇报，输入项目密码，即可和组员共同编排、练习和回放。</p><div className="rh-actions"><button className="btn" onClick={()=>{setError('');setMode('create')}}>创建汇报</button><button onClick={()=>chooseProject('')}>通过分享链接加入</button></div></>:
   <form onSubmit={e=>{e.preventDefault();void (mode==='create'?create():mode==='upgrade'?upgrade():enter())}}>
    <h2>{mode==='create'?'创建汇报':mode==='upgrade'?'设置管理员密码':'进入汇报'}</h2>
    {mode==='create'?<>
     <div className="rh-grid"><label>汇报名称<input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>规定时长（分钟）<input required type="number" min={1} max={180} value={minutes} onChange={e=>setMinutes(+e.target.value)}/></label></div>
     <label>四位项目密码<input required type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={code} onChange={e=>setCode(e.target.value)}/></label>
     <label><input type="checkbox" checked={hidden} onChange={e=>setHidden(e.target.checked)}/>隐藏汇报，仅通过分享链接加入</label>
    </>:mode==='join'?<>
     {!id&&<label>汇报分享链接<input required type="url" value={link} onChange={e=>setLink(e.target.value)}/></label>}
     <label>项目密码或管理员密码<input required type="password" maxLength={256} autoComplete="current-password" value={secret} onChange={e=>setSecret(e.target.value)}/></label>
     <p className="muted">旧项目的管理员可在这里输入原管理密钥，完成一次性升级。</p>
    </>:<p>旧密钥已验证。设置新密码后，使用新密码进入；旧密钥和旧管理会话将失效。项目仍保持隐藏。</p>}
    {(mode==='create'||mode==='upgrade')&&<><label>管理员密码<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={adminPassword} onChange={e=>setAdminPassword(e.target.value)}/></label><p className="muted">管理员密码至少 8 位，可使用纯数字，请妥善保管。</p></>}
    <div className="rh-actions"><button className="btn" disabled={busy}>{busy?'正在处理…':mode==='create'?'创建并进入':mode==='upgrade'?'启用管理员密码':'验证并进入'}</button><button type="button" disabled={busy} onClick={()=>{setMode('home');setId('');setSecret('');setAdminPassword('');setError('')}}>返回首页</button></div>
   </form>}
  </section>}
  {!data&&mode==='home'&&<><ProjectDirectory open={chooseProject}/><p className="rh-origin-note">Rehearsal Studio 起源于艺68班级服务站的模拟汇报工具。<a href="https://class.example.invalid" target="_blank" rel="noopener noreferrer">访问班级服务站 ↗</a></p></>}
  {data&&<WorkspaceSidebar
   id={id} title={p?.title||'未命名汇报'} role={role==='owner'?'owner':'editor'}
   projectStatus={p?.status||'draft'} status={status}
   onStatus={setStatus} onDeleted={()=>{reset();setMessage('项目及关联数据已永久删除。')}}
   active={editing?'edit':workspace}
   onExit={()=>void exit()}
   onCopy={()=>void run(async()=>{await navigator.clipboard.writeText(projectLink(id));setMessage('邀请链接已复制，密码请另行分享。')})}
   onReload={async()=>{setEditing(false);await load()}}
   onNavigate={area=>{
    if(area==='edit'){if(practicing&&!confirm('进入编排前请保存未提交录音。继续？'))return;setPracticing(false);setEditing(true);return;}
    if(editing&&!window.dispatchEvent(new Event('studio:leave-editor',{cancelable:true})))return;
    if(area==='playback'&&practicing&&!confirm('切换到全组回放前请提交或备份当前录音。继续？'))return;
    setWorkspace(area);setEditing(false);if(area==='playback')setPracticing(false);
    if(editing)void run(async()=>{await load()});
   }}>
   {editing?<RehearsalAdmin configured group ownerAccess={role==='owner'} onBack={()=>{setEditing(false);void run(async()=>{await load()})}}/>:p?<>{workspace==='practice'&&<><section className="panel rh-pad"><h2>{p.title}</h2><p>{p.theme}</p><p>规定时长 {formatTime(p.config.hardLimitSeconds)}</p><div className="rh-name-grid">{p.members.filter(m=>m.enabled).map(m=><button key={m.id} aria-pressed={member===m.id} onClick={()=>{if(practicing&&!confirm('切换姓名前请先提交或保存当前录音。继续？'))return;setMember(m.id);setPracticing(p.status==='published')}}>{m.name}</button>)}</div></section>{practicing&&data.estimate&&<Practice key={p.id+member+p.scriptVersion+p.deckVersion} project={p} memberId={member} estimate={data.estimate} recordings={data.recordings} progress={data.progress} onSubmitted={async()=>{await load()}}/>}</>}{workspace==='playback'&&<ReleasePlayback project={p} recordings={data.recordings}/>}{data.estimate&&<EstimatePanel project={p} estimate={data.estimate} recordings={data.recordings}/>}<ReadingPreview project={p}/><PresentationDownload project={p}/><details className="rh-method-fold"><summary>关于自动测算</summary><AlgorithmNotes config={p.config} updatedAt={p.updatedAt}/></details></>:<section className="panel rh-pad"><p>材料还未发布，请进入共同编排工作台准备讲稿与 PPT。</p></section>}
  </WorkspaceSidebar>}
 </div>;
}
