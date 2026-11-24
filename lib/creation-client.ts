import {api,ApiError} from './client';

export type CreationInput={title:string;seconds:number;code:string;admin_password:string;visibility?:'public'|'unlisted'};
type CreationBody=CreationInput&{challenge:string;solution:string;request_id:string};
type Dependencies={
 request:(path:string,body:unknown)=>Promise<any>;
 solve:(nonce:string,onProgress:()=>void)=>Promise<string>;
 requestId:()=>string;
};

export function requireCreationCrypto(){
 if(!globalThis.crypto?.subtle)throw new Error('创建汇报需要 HTTPS 安全连接。请使用正式 HTTPS 地址打开。');
}
export async function solveCreationProof(nonce:string,onProgress:()=>void){
 requireCreationCrypto();
 for(let i=0;i<3000000;i+=64){
  const values=await Promise.all(Array.from({length:64},(_,j)=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(nonce+':'+(i+j)))));
  const found=values.findIndex(b=>new Uint8Array(b)[0]===0&&new Uint8Array(b)[1]===0);
  if(found>=0)return String(i+found);
  if(i%4096===0){onProgress();await new Promise(r=>setTimeout(r,0))}
 }
 throw new Error('创建验证未完成，请重试。');
}

// Retain the exact request after a lost response. A confirmed result releases it,
// so another project on the same page always starts with a new request ID.
export class CreationAttempt{
 private body:CreationBody|undefined;
 private active:{signature:string;result:Promise<any>}|undefined;
 private dependencies:Dependencies;
 constructor(dependencies:Partial<Dependencies>={}){
  this.dependencies={request:api,solve:solveCreationProof,requestId:()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join(''),...dependencies};
 }
 submit(input:CreationInput,onProgress:()=>void){
  const signature=JSON.stringify(this.input(input));
  if(this.active)return this.active.signature===signature?this.active.result:Promise.reject(new Error('创建正在处理，请等待本次结果。'));
  const result=this.perform(input,onProgress);
  this.active={signature,result};
  void result.then(()=>{this.active=undefined},()=>{this.active=undefined});
  return result;
 }
 private async perform(input:CreationInput,onProgress:()=>void){
  if(this.body&&JSON.stringify(this.input(this.body))!==JSON.stringify(this.input(input)))throw new Error('上一次创建结果尚未确认。请恢复原填写内容并重试，确认后再创建其他项目。');
  if(!this.body){
   if(this.dependencies.solve===solveCreationProof)requireCreationCrypto();
   onProgress();
   const challenge=await this.dependencies.request('/api/projects/challenge',{});
   this.body={...input,challenge:challenge.nonce,solution:await this.dependencies.solve(challenge.nonce,onProgress),request_id:this.dependencies.requestId()};
  }
  try{
   const result=await this.dependencies.request('/api/projects',this.body);
   this.body=undefined;
   return result;
  }catch(error){
   // These responses guarantee that creation was rejected. A fresh verification
   // is safe after correcting fields or an expired challenge. Unknown outcomes
   // keep the request, including a concurrent-create 409, to prevent duplicates.
   if(error instanceof ApiError&&(error.status===400||error.status===403))this.body=undefined;
   throw error;
  }
 }
 private input(v:CreationInput):CreationInput{return {title:v.title,seconds:v.seconds,code:v.code,admin_password:v.admin_password,visibility:v.visibility??'public'}}
}
