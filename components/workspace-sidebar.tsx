'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';
import {ProjectSettings,type ProjectStatus} from './project-settings';

type Area='edit'|'practice'|'playback';
type Versions={revision:number;changed_at:string}[];
export function WorkspaceSidebar({id,title,role,status,onStatus,onDeleted,active,onNavigate,onReload,onCopy,onExit,children,projectStatus}:{
 id:string;title:string;role:'owner'|'editor';status:ProjectStatus|null;projectStatus:string;children:React.ReactNode;
 onStatus:(s:ProjectStatus)=>void;onDeleted:()=>void;active:Area;
 onNavigate:(area:Area)=>void;onReload:()=>Promise<void>;onCopy:()=>void;onExit:()=>void;
}){
 const [collapsed,setCollapsed]=useState(false),[mobile,setMobile]=useState(false);
 const [drawer,setDrawer]=useState<'settings'|'versions'|null>(null);
 const [versions,setVersions]=useState<Versions>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [loading,setLoading]=useState(false);
 const closeButton=useRef<HTMLButtonElement>(null),opener=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{
  if(!drawer)return;
  closeButton.current?.focus();
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();setDrawer(null)}
   if(event.key==='Tab'){
    const node=document.querySelector<HTMLElement>('.rh-drawer-panel');
    const tabbable=Array.from(node?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])')||[]);
    const first=tabbable[0],last=tabbable.at(-1);
    if(!first||!last)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
   }
  };
  document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('keydown',key);opener.current?.focus()};
 },[drawer]);
 async function open(kind:'settings'|'versions',trigger:HTMLButtonElement){
  opener.current=trigger;setMobile(false);setError('');setDrawer(kind);
  if(kind==='versions'){
   setLoading(true);
   try{const data=await api('/api/projects/'+id+'/versions');setVersions(data.versions)}
   catch(e){setError((e as Error).message)}
   finally{setLoading(false)}
  }
 }
 async function restore(revision:number){
  if(busy||!confirm('恢复为新草稿版本？当前已发布材料保留，请恢复后重新核对。'))return;
  setBusy(true);setError('');
  try{
   const current=await api('/api/rehearsal/edit');
   await api('/api/projects/'+id+'/restore',{revision,expected_revision:current.project.revision});
   setDrawer(null);await onReload();
  }catch(e){setError((e as Error).message)}
  finally{setBusy(false)}
 }
 const areas:[Area,string,string][]=[['edit','材料与编排','▤'],['practice','个人练习','◉'],['playback','全组回放','▷']];
 const panel=<aside className={'rh-workspace-sidebar'+(mobile?' is-open':'')+(collapsed?' is-mini':'')} aria-label="项目工作台导航">
  <div className="rh-side-brand"><span className="rh-side-mark" aria-hidden="true">R</span>{!collapsed&&<span><strong>Rehearsal Studio</strong><small>小组汇报工作空间</small></span>}</div>
  <button className="rh-side-toggle" type="button" onClick={()=>setCollapsed(!collapsed)} aria-label={collapsed?'展开导航':'收起导航'}>{collapsed?'»':'« 收起侧栏'}</button>
  <nav className="rh-side-links" aria-label="工作步骤">
   {areas.map(([value,label,icon])=><button type="button" key={value} title={label} aria-current={active===value?'page':undefined} onClick={()=>{onNavigate(value);setMobile(false)}}>
    <span className="rh-side-icon" aria-hidden="true">{icon}</span>{!collapsed&&label}</button>)}
  </nav>
  <div className="rh-side-links rh-side-management">
   {!collapsed&&<span className="rh-side-heading">项目管理</span>}
   <button type="button" title="复制邀请链接" onClick={()=>{onCopy();setMobile(false)}}><span className="rh-side-icon" aria-hidden="true">↗</span>{!collapsed&&'邀请链接'}</button>
   {role==='owner'&&status&&<button type="button" title="项目设置" aria-expanded={drawer==='settings'} onClick={e=>void open('settings',e.currentTarget)}><span className="rh-side-icon" aria-hidden="true">⚙</span>{!collapsed&&'项目设置'}</button>}
   <button type="button" title="版本恢复" aria-expanded={drawer==='versions'} onClick={e=>void open('versions',e.currentTarget)}><span className="rh-side-icon" aria-hidden="true">↺</span>{!collapsed&&'版本恢复'}</button>
  </div>
  <div className="rh-side-bottom"><button type="button" title="退出本汇报" className="rh-side-exit" onClick={onExit}>退出汇报</button><a href="https://class.example.invalid" target="_blank" rel="noopener noreferrer" title="艺68班级服务站"><span className="rh-side-icon" aria-hidden="true">↗</span>{!collapsed&&'艺68班级服务站'}</a>{!collapsed&&<small>{role==='owner'?'管理员权限':'小组成员'}</small>}</div>
 </aside>;
 return <div className={'rh-sidebar-layout'+(collapsed?' is-mini':'')}>
  <button className="rh-mobile-nav" type="button" aria-expanded={mobile} aria-controls="rh-studio-navigation" onClick={()=>setMobile(x=>!x)}>☰ 项目导航</button>
  {mobile&&<button type="button" className="rh-mobile-scrim" aria-label="关闭项目导航" onClick={()=>setMobile(false)} />}
  <div id="rh-studio-navigation" className="rh-sidebar-position">{panel}</div>
  <div className="rh-workspace-content">
   <header className="rh-workspace-topbar"><div><p className="eyebrow">当前汇报 / {areas.find(([v])=>v===active)?.[1]}</p><h2>{title}</h2></div><span className="rh-status-pill">{projectStatus==='published'?'已发布':projectStatus==='ended'?'已结束':'草稿'}</span></header>
   {children}
  </div>
  {drawer&&<div className="rh-drawer-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setDrawer(null)}}>
   <section className="rh-drawer-panel" role="dialog" aria-modal="true" aria-label={drawer==='settings'?'项目设置':'版本恢复'}>
    <div className="rh-drawer-header"><strong>{drawer==='settings'?'项目设置':'版本恢复'}</strong><button ref={closeButton} type="button" onClick={()=>setDrawer(null)}>关闭</button></div>
    {drawer==='settings'&&role==='owner'&&status&&<ProjectSettings id={id} status={status} onStatus={onStatus} onDelete={()=>{setDrawer(null);onDeleted()}} />}
    {drawer==='versions'&&<div className="rh-drawer-versions">{loading?<p>正在读取版本…</p>:versions.length?versions.map(v=><div key={v.revision} className="rh-version-row"><span>版本 r{v.revision}<small>{v.changed_at}</small></span><button disabled={busy} onClick={()=>void restore(v.revision)}>恢复为草稿</button></div>):<p>暂无可恢复版本。</p>}{error&&<p role="alert" className="callout error">{error}<ErrorContact /></p>}</div>}
   </section>
  </div>}
 </div>;
}
