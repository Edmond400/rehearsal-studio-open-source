'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';
import {formatTime,type Project,type Recording} from '@/lib/rehearsal/model';
import {GroupPlayback} from './playback';

type Release = {release_id:string;release_no:number;created_at:string};
type View = {project:Project;recordings:Recording[];choices:{turn_uid:string;selection_revision:number}[];
 turns:{uid:string;ordinal:number;memberId:string}[]};
type Manifest = {project:Project;recordings:Recording[];expires:number};

export function ReleasePlayback({project,recordings}:{project:Project;recordings:Recording[]}) {
 const [versions,setVersions]=useState<Release[]>([]),[release,setRelease]=useState(project.releaseId??'');
 const [view,setView]=useState<View|null>(null),[manifest,setManifest]=useState<Manifest|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef(0);
 async function load(id:string) {
  const token=++request.current;
  try {
   const result=await api('/api/rehearsal/releases/'+encodeURIComponent(id));
   if(token===request.current)setView(result);
  } catch(e) {if(token===request.current)setError((e as Error).message);}
 }
 useEffect(()=>{
  if(!project.releaseId)return;
  let active=true;
  void api('/api/rehearsal/releases').then(result=>{if(active)setVersions(result.releases)}).catch(e=>{if(active)setError(e.message)});
  return()=>{active=false};
 },[project.releaseId]);
 useEffect(()=>{
  if(release)void load(release);
  return()=>{request.current++};
 },[release]);
 async function select(uid:string,id:string,revision:number) {
  setBusy(true);setError('');
  try {
   await api('/api/rehearsal/playback/choice',{release_id:release,turn_uid:uid,recording_id:id||null,selection_revision:revision});
  } catch(e) {setError((e as Error).message);}
  finally{await load(release);setBusy(false);}
 }
 async function start() {
  setBusy(true);setError('');
  try {setManifest(await api('/api/rehearsal/playback/session',{release_id:release}));}
  catch(e){setError((e as Error).message);}
  finally{setBusy(false);}
 }
 if(!project.releaseId)return <GroupPlayback project={project} recordings={recordings}/>;
 return <section className="panel rh-pad">
  <h2>全组回放</h2>
  <div className="rh-actions">
   <label>发布版本<select value={release} disabled={busy} onChange={e=>{setView(null);setManifest(null);setError('');setRelease(e.target.value)}}>
    {!versions.some(v=>v.release_id===release)&&<option value={release}>当前版本</option>}
    {versions.map(v=><option key={v.release_id} value={v.release_id}>第 {v.release_no} 版{v.release_id===project.releaseId?'（当前）':''}</option>)}
   </select></label>
   <button disabled={busy} onClick={()=>void load(release)}>刷新录音选择</button>
   <button className="btn" disabled={busy||!view} onClick={()=>void start()}>{busy?'处理中…':manifest?'按最新选择重新播放':'开始整场回放'}</button>
  </div>
  {view?.turns.map(t=>{
   const options=view.recordings.filter(r=>r.turnUid===t.uid);
   const revision=view.choices.find(c=>c.turn_uid===t.uid)?.selection_revision??0;
   const name=view.project.members.find(m=>m.id===t.memberId)?.name??'组员';
   return <label key={t.uid}>第 {t.ordinal+1} 轮 · {name}<select disabled={busy||!options.length}
    value={options.find(r=>r.selected)?.id??''} onChange={e=>void select(t.uid,e.target.value,revision)}>
    <option value="">{options.length?'使用最新录音':'暂无可用录音'}</option>
    {options.map(r=><option value={r.id} key={r.id}>{new Date(r.submittedAt).toLocaleString()} · {formatTime(r.durationMs/1000)}</option>)}
   </select></label>;
  })}
  {error&&<p role="alert" className="callout error">{error}<ErrorContact /></p>}
  {manifest&&<GroupPlayback key={manifest.expires} project={manifest.project} recordings={manifest.recordings} autoStart/>}
 </section>;
}
