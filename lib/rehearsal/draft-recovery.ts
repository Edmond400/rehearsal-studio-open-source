import type {DraftTransmission} from './draft-client';
import type {Project} from './model';

export type PendingDraft = {key: string; projectId: string; base: Project; local: Project; pending?:DraftTransmission; updated: number};
const ttl = 72 * 3600000;

async function store<T>(mode: IDBTransactionMode, operation: (s: IDBObjectStore) => IDBRequest<T>) {
 const db = await new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('studio-draft-recovery', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('pending', {keyPath: 'key'});
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('本地备份数据库暂不可用'));
  request.onsuccess = () => resolve(request.result);
 });
 try {
  return await new Promise<T>((resolve, reject) => {
   const tx = db.transaction('pending', mode);
   const request = operation(tx.objectStore('pending'));
   tx.oncomplete = () => resolve(request.result);
   tx.onabort = () => reject(tx.error ?? new Error('本地备份写入失败'));
  });
 } finally { db.close(); }
}
export const writePendingDraft = (draft: PendingDraft) => store('readwrite', s => s.put(draft));
export const clearPendingDraft = (key: string) => store('readwrite', s => s.delete(key));
export async function pendingDrafts(projectId: string) {
 const rows = await store('readonly', s => s.getAll() as IDBRequest<PendingDraft[]>);
 const now = Date.now();
 await Promise.all(rows.filter(row => now - row.updated > ttl).map(row => clearPendingDraft(row.key)));
 return rows.filter(row => row.projectId === projectId && now - row.updated <= ttl).sort((a,b) => b.updated-a.updated);
}
