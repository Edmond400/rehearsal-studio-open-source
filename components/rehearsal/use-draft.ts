'use client';
import {useEffect, useRef, useState} from 'react';
import {api} from '@/lib/client';
import {DraftClient} from '@/lib/rehearsal/draft-client';
import {clearPendingDraft, pendingDrafts, writePendingDraft, type PendingDraft} from '@/lib/rehearsal/draft-recovery';
import {newRehearsalId,type Project} from '@/lib/rehearsal/model';

const labels = {synced:'草稿已保存',editing:'等待自动保存',saving:'正在保存草稿',offline:'连接中断，等待重试',
 conflict:'检测到协作冲突',auth:'会话已失效',error:'草稿需要检查'};

export function useDraft() {
 const client=useRef<DraftClient|null>(null);
 const [,render]=useState(0);
 const [composing,setComposing]=useState(false);
 const [backups,setBackups]=useState<PendingDraft[]>([]);
 const [backupEnabled,setBackupEnabled]=useState(true);
 const [storageError,setStorageError]=useState('');
 const [leaveWarning,setLeaveWarning]=useState(false);
 const key=useRef('');
 const queue=useRef<Promise<unknown>>(Promise.resolve());
 const dirtySince=useRef(0);
 const confirmed=useRef(false);
 const current=client.current;
 const local=current?.local;
 const dirty=!!current?.dirty;
 const state=current?.state;
 function storage(operation:()=>Promise<unknown>) {
  queue.current=queue.current.catch(()=>{}).then(operation).catch(()=>setStorageError('本浏览器无法写入本地恢复副本。'));
  return queue.current;
 }
 function notify() {
  const draft=client.current;
  render(n=>n+1);
  if (draft?.dirty && !dirtySince.current) dirtySince.current=Date.now();
  if (!draft?.dirty) {dirtySince.current=0;setLeaveWarning(false);}
 }
 function connect(project:Project) {
  key.current ||= newRehearsalId();
  const session=client.current=new DraftClient(project,
   (base_revision,mutation_id,document)=>api('/api/rehearsal/edit/draft',{base_revision,mutation_id,document}),
   async()=>(await api('/api/rehearsal/edit/draft')).project,notify);
  if (!confirmed.current) {
   confirmed.current=true;
   void pendingDrafts(project.id).then(rows=>setBackups(rows.filter(row=>row.key!==key.current))).catch(()=>setStorageError('本浏览器无法读取本地恢复副本。'));
  }
  notify();
  return session;
 }
 useEffect(()=>{
  if (!current) return;
  const tabKey=key.current;
  if (dirty && backupEnabled && local) {
   const entry={key:tabKey,projectId:local.id,base:current.base,local,pending:current.pending,updated:Date.now()};
   void storage(()=>writePendingDraft(entry));
  } else void storage(()=>clearPendingDraft(tabKey));
 },[current,local,dirty,backupEnabled,current?.base,current?.pending]);
 useEffect(()=>{
  if (!current || !dirty || state!=='editing' || composing) return;
  const timer=setTimeout(()=>void current.sync(),Math.max(0,Math.min(3000,15000-(Date.now()-dirtySince.current))));
  return ()=>clearTimeout(timer);
 },[current,local,dirty,state,composing]);
 useEffect(()=>{
  const online=()=>{if (!composing && client.current?.state==='offline') void client.current.sync();};
  window.addEventListener('online',online);
  return ()=>window.removeEventListener('online',online);
 },[composing]);
 useEffect(()=>{
  const onExit=(e:Event)=>{
   if(!client.current?.dirty)return;
   if(e.type==='beforeunload'){e.preventDefault();return}
   e.preventDefault();e.stopImmediatePropagation();setLeaveWarning(true);
  };
  window.addEventListener('beforeunload',onExit);
  window.addEventListener('studio:native-back',onExit,true);
  window.addEventListener('studio:leave-editor',onExit);
  return ()=>{
   window.removeEventListener('beforeunload',onExit);
   window.removeEventListener('studio:native-back',onExit,true);
   window.removeEventListener('studio:leave-editor',onExit);
  };
 },[]);
 function restore(row:PendingDraft) {
  if (!client.current || client.current.dirty) return;
  client.current.recover(row.base,row.local,row.pending);
  setBackups(list=>list.filter(b=>b.key!==row.key));
  // The recovered editor owns this copy only after persisting under its own key.
  if (backupEnabled && client.current.dirty) {
   const {base,local,pending}=client.current;
   void storage(async()=>{
    await writePendingDraft({key:key.current,projectId:local.id,base,local,pending,updated:Date.now()});
    await clearPendingDraft(row.key);
   });
  }
 }
 async function flush() {
  const session=client.current;
  if (!session || composing) return null;
  for (let attempt=0; attempt<4; attempt++) {
   if (!await session.sync()) return null;
   if (!session.dirty) return session.base;
  }
  return null;
 }
 return {client, current, local, connect, dirty, state, leaveWarning, label:labels[state??'synced'], composing,setComposing, flush, backups,restore,
  backupEnabled,setBackupEnabled,storageError,
  discard:(row:PendingDraft)=>{void storage(()=>clearPendingDraft(row.key));setBackups(list=>list.filter(b=>b.key!==row.key));}};
}
