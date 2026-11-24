'use client';
import {ErrorContact} from '@/components/developer-contact';
import {useEffect,useRef,useState} from 'react';
import {saveBlob} from '@/lib/transport';
import {mergeDraft} from '@/lib/rehearsal/draft-merge';
import {reconcileScript,scriptText} from '@/lib/rehearsal/script-reconcile';
import type {Project} from '@/lib/rehearsal/model';
import {FullScriptAssignment} from './full-script-assignment';

type Change = {before:Project;after:Project};
export function ScriptEditor({project,onChange}:{project:Project;onChange:(project:Project)=>void}) {
 const [mode,setMode]=useState<'brush'|'text'>('brush');
 const [past,setPast]=useState<Change[]>([]),[future,setFuture]=useState<Change[]>([]);
 const [warnings,setWarnings]=useState<string[]>([]),[error,setError]=useState('');
 const [input,setInput]=useState<string|null>(null);
 const applied=useRef(scriptText(project.blocks));
 const visible=scriptText(project.blocks);
 useEffect(()=>{if(visible!==applied.current){applied.current=visible;setInput(null)}},[visible]);
 function change(next:Project) {
  if(next===project)return;
  setPast(list=>[...list.slice(-29),{before:project,after:next}]);setFuture([]);
  onChange(next);
 }
 function travel(undo:boolean) {
  const change=(undo?past:future).at(-1);
  if(!change)return;
  const merged=mergeDraft(undo?change.after:change.before,undo?change.before:change.after,project);
  if(!merged.project){setError('当前段落已被其他编辑修改，无法安全撤销或重做。');return;}
  onChange(merged.project);setInput(null);setError('');
  if(undo){setPast(past.slice(0,-1));setFuture([...future,change]);}
  else {setFuture(future.slice(0,-1));setPast([...past,change]);}
 }
 function apply(text:string) {
  try {
   const result=reconcileScript(project,text);
   setWarnings(result.warnings);setError('');setInput(text);applied.current=scriptText(result.blocks);
   if(result.blocks!==project.blocks)change({...project,blocks:result.blocks,overrides:{}});
  } catch(e) {setInput(text);setError((e as Error).message);}
 }
 return <section className="panel rh-pad">
  <h2>讲稿分工与 PPT 关联</h2>
  <div className="rh-actions">
   <button aria-pressed={mode==='brush'} onClick={()=>{if(!error){setInput(null);setMode('brush');}}}>分工与关联</button>
   <button aria-pressed={mode==='text'} onClick={()=>setMode('text')}>修改讲稿</button>
   <button disabled={!past.length} onClick={()=>travel(true)}>撤销</button>
   <button disabled={!future.length} onClick={()=>travel(false)}>重做</button>
  </div>
  {mode==='brush'?<FullScriptAssignment project={project} onChange={change}/>:<label>汇报全文
   <textarea rows={14} value={input??scriptText(project.blocks)} onChange={e=>{
    if ((e.nativeEvent as InputEvent).isComposing) setInput(e.target.value);
    else apply(e.target.value);
   }} onCompositionEnd={e=>apply(e.currentTarget.value)}/>
  </label>}
  {warnings.map(warning=><p className="callout" key={warning}>{warning}</p>)}
  {error&&<p className="callout error" role="alert">{error}<ErrorContact />{input!==null&&<button onClick={()=>void saveBlob(new Blob([input],{type:'text/plain'}),'讲稿.txt')}>导出当前文字</button>}</p>}
 </section>;
}
