import {mergeDraft, sameDraftValue} from './draft-merge';
import {newRehearsalId, type Project} from './model';

export function draftBody(project: Project) {
 const {id, releaseId, scriptVersion, deckVersion, algorithmVersion, updatedAt, ...body} = project;
 return {...body, status: 'draft' as const};
}

export type DraftState = 'synced'|'editing'|'saving'|'offline'|'conflict'|'auth'|'error';
type Result = {project: Project};
export type DraftTransmission = {base: Project; project: Project; id: string};
type Save = (base: number, id: string, document: ReturnType<typeof draftBody>) => Promise<Result>;
export class DraftClient {
 base: Project;
 local: Project;
 state: DraftState = 'synced';
 detail = '';
 private sent: DraftTransmission | undefined;
 get pending() {return this.sent;}
 private running: Promise<boolean> | undefined;
 private conflictBase: Project | undefined;
 constructor(project: Project, private save: Save, private read: () => Promise<Project>, private onChange: () => void) {
  this.base = project;
  this.local = project;
 }
 get dirty() {
  const comparable = (p: Project) => ({...draftBody(p),revision:0,config:{...p.config,version:''}});
  return !!this.sent || !sameDraftValue(comparable(this.local),comparable(this.base));
 }
 edit(project: Project) {
  this.local = project;
  if (this.state !== 'conflict' && this.state !== 'saving') this.state = this.dirty ? 'editing' : 'synced';
  this.onChange();
 }
 recover(base: Project, project: Project, transmission?:DraftTransmission) {
  const current = this.base;
  const merged = mergeDraft(base,project,current);
  if (merged.project) {
   if(transmission?.base.revision===current.revision)this.sent=transmission;
   this.edit(merged.project);
  }
  else {
   this.local = project;
   this.base = base;
   this.conflictBase = current;
   this.state = 'conflict';
   this.detail = merged.conflicts.join('、');
   this.onChange();
  }
 }
 discard() {
  if(this.state==='saving')return;
  this.base=this.conflictBase??this.base;
  this.local=this.base;
  this.sent=undefined;
  this.conflictBase=undefined;
  this.state='synced';
  this.onChange();
 }
 async resolve(useLocal: boolean) {
  if (this.state !== 'conflict' || !this.conflictBase) return;
  this.base = this.conflictBase;
  this.conflictBase = undefined;
  if (!useLocal) this.local = this.base;
  this.sent = undefined;
  this.state = useLocal ? 'editing' : 'synced';
  this.onChange();
 }
 sync() {
  if (this.running) return this.running;
  this.running = this.perform().finally(() => { this.running = undefined; this.onChange(); });
  return this.running;
 }
 private async perform() {
  if (this.state === 'conflict') return false;
  if (!this.dirty && !this.sent) return true;
  const sent = this.sent ??= {base:this.base, project:this.local, id:newRehearsalId()};
  this.state = 'saving';
  this.onChange();
  try {
   const response = await this.save(sent.base.revision, sent.id, {...draftBody(sent.project),revision:sent.base.revision});
   this.base = response.project;
   this.sent = undefined;
   // Preserve the edited object and all undo snapshots. Revision metadata is
   // attached only when sending a request.
   if (this.local === sent.project) this.local = response.project;
   this.state = this.dirty ? 'editing' : 'synced';
   return true;
  } catch (error) {
   const status = (error as {status?:number}).status;
   this.detail = (error as Error).message;
   if (status === 409) {
    try {
     const server = await this.read();
     const merged = mergeDraft(sent.base,this.local,server);
     this.sent = undefined;
     if (merged.project) {
      this.base = server;
      this.local = merged.project;
      this.state = this.dirty ? 'editing' : 'synced';
      return true;
     }
     this.conflictBase = server;
     this.detail = merged.conflicts.join('、');
     this.state = 'conflict';
    } catch { this.state = 'offline'; }
   } else if (status === 401 || status === 403) this.state = 'auth';
   else if (status && status < 500) { this.sent = undefined; this.state = 'error'; }
   else this.state = 'offline';
   return false;
  }
 }
}
