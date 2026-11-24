import type {PreviewPage} from './pptx-preview';

export type DeckJob={id:string;projectId:string;name:string;file:Blob;updated:number};
type StoredPage={jobId:string;index:number;page:PreviewPage};
const ttl=72*3600000;
function open(){
 return new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('studio-deck-imports',1);
  request.onupgradeneeded=()=>{
   request.result.createObjectStore('jobs',{keyPath:'id'});
   request.result.createObjectStore('pages',{keyPath:['jobId','index']}).createIndex('job','jobId');
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(new Error('浏览器本地导入数据库暂不可用。'));
 });
}
async function action<T>(names:string[],mode:IDBTransactionMode,work:(tx:IDBTransaction)=>IDBRequest<T>|void){
 const db=await open();
 try{
  return await new Promise<T|undefined>((resolve,reject)=>{
   const tx=db.transaction(names,mode);
   const request=work(tx);
   tx.oncomplete=()=>resolve(request?.result);
   tx.onabort=()=>reject(tx.error??new Error('无法保存本地导入进度。'));
  });
 }finally{db.close();}
}
export const rememberDeck=(job:DeckJob)=>action(['jobs'],'readwrite',tx=>tx.objectStore('jobs').put(job));
export const rememberPage=(jobId:string,index:number,page:PreviewPage)=>action(['pages'],'readwrite',tx=>tx.objectStore('pages').put({jobId,index,page} satisfies StoredPage));
export async function recoveredPages(jobId:string){
 const rows=await action(['pages'],'readonly',tx=>tx.objectStore('pages').index('job').getAll(jobId) as IDBRequest<StoredPage[]>);
 return new Map((rows??[]).map(row=>[row.page.path,row.page]));
}
export async function forgetDeck(id:string){
 await action(['jobs','pages'],'readwrite',tx=>{
  tx.objectStore('jobs').delete(id);
  const cursor=tx.objectStore('pages').index('job').openCursor(IDBKeyRange.only(id));
  cursor.onsuccess=()=>{const row=cursor.result;if(row){row.delete();row.continue();}};
 });
}
export async function recoverDecks(projectId:string){
 const jobs=await action(['jobs'],'readonly',tx=>tx.objectStore('jobs').getAll() as IDBRequest<DeckJob[]>);
 const active=(jobs??[]).filter(job=>Date.now()-job.updated<ttl);
 await Promise.all((jobs??[]).filter(job=>!active.includes(job)).map(job=>forgetDeck(job.id)));
 return active.filter(job=>job.projectId===projectId).sort((a,b)=>b.updated-a.updated);
}
