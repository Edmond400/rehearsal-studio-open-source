'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/client';
import {formatTime} from '@/lib/rehearsal/model';

type Entry={id:string;title:string;duration_seconds:number;status:'draft'|'published'|'ended';updated_at:string};
const statuses={draft:'准备中',published:'已发布',ended:'已结束'};
export function ProjectDirectory({open}:{open:(id:string)=>void}){
 const [input,setInput]=useState(''),[query,setQuery]=useState(''),[rows,setRows]=useState<Entry[]>([]),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const run=useRef(0);
 async function load(q:string,cursor?:string){
  const generation=++run.current;setBusy(true);setError('');
  try{
   const params=new URLSearchParams({q,...(cursor?{cursor}:{})});
   const r=await api('/api/projects/directory?'+params);
   if(generation!==run.current)return;
   const incoming:Entry[]=r.projects;
   setRows(prev=>cursor?[...prev,...incoming.filter(x=>!prev.some(p=>p.id===x.id))]:incoming);
   setNext(r.next_cursor);
  }catch(e){if(generation===run.current)setError((e as Error).message)}
  finally{if(generation===run.current)setBusy(false)}
 }
 useEffect(()=>{void load('');return()=>{run.current++}},[]);
 return <section className="panel rh-pad">
  <h2>公开汇报</h2>
  <form className="rh-actions" onSubmit={e=>{e.preventDefault();setQuery(input.trim());setRows([]);setNext(null);void load(input.trim())}}>
   <label>按名称搜索<input type="search" value={input} maxLength={80} onChange={e=>setInput(e.target.value)}/></label>
   <button disabled={busy}>搜索</button>
  </form>
  {error&&<p className="callout error" role="alert">{error}<ErrorContact /> <button onClick={()=>void load(query)}>重试</button></p>}
  <ul>{rows.map(r=><li key={r.id}><button onClick={()=>open(r.id)}>{r.title}</button> <span className="muted">{formatTime(r.duration_seconds)} · {statuses[r.status]} · {new Date(r.updated_at).toLocaleString('zh-CN')}</span></li>)}</ul>
  {busy?<p role="status">正在加载目录…</p>:!error&&!rows.length?<p>没有找到公开汇报。</p>:null}
  {next&&<button disabled={busy} onClick={()=>void load(query,next)}>加载更多</button>}
 </section>;
}
