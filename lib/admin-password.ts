import {env} from 'cloudflare:workers';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {HttpError} from './http';

export const ADMIN_ALGORITHM='pbkdf2-sha256-v1';
export const ADMIN_ITERATIONS=16000;
const encoder=new TextEncoder();
export type AdminCredential={algorithm:string;iterations:number;salt:string;verifier:string;credential_version:number};

export function validAdminPassword(password:string){
 const length=Array.from(password).length;
 if(length<8||length>128||password!==password.trim()||/[\u0000-\u001f\u007f]/.test(password))return false;
 return true;
}
export function requireAdminPassword(password:string){
 if(!validAdminPassword(password))throw new HttpError(400,'管理员密码至少 8 位，可使用纯数字，请妥善保管。');
}
export function passwordPepperConfigured(){return /^[a-f0-9]{64}$/i.test(env.STUDIO_PASSWORD_PEPPER||'')}
function pepper(){
 if(!passwordPepperConfigured())throw new HttpError(503,'密码服务暂不可用，请稍后重试。');
 return Buffer.from(env.STUDIO_PASSWORD_PEPPER!,'hex');
}
function domainDigest(purpose:string,parts:string[]){
 return createHmac('sha256',pepper()).update(JSON.stringify([purpose,...parts])).digest();
}
export function protectedCodeDigest(id:string,code:string){return 'v14:'+domainDigest('project-code',[id,code]).toString('hex')}
export function creationInputDigest(requestId:string,input:string){return domainDigest('creation-input',[requestId,input]).toString('hex')}
async function derive(id:string,password:string,salt:string,iterations:number){
 const input=Uint8Array.from(domainDigest('admin-password',[id,password]));
 const key=await crypto.subtle.importKey('raw',input,'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations},key,256);
 return Buffer.from(bits);
}
export async function newAdminCredential(id:string,password:string,version=1):Promise<AdminCredential>{
 requireAdminPassword(password);
 const salt=randomBytes(16).toString('hex');
 return {algorithm:ADMIN_ALGORITHM,iterations:ADMIN_ITERATIONS,salt,verifier:(await derive(id,password,salt,ADMIN_ITERATIONS)).toString('hex'),credential_version:version};
}
export async function verifyAdminPassword(id:string,password:string,credential:AdminCredential|null):Promise<boolean>{
 // Do equivalent KDF work for a missing credential to avoid a cheap existence oracle.
 const valid=credential?.algorithm===ADMIN_ALGORITHM&&Number.isInteger(credential.iterations)&&credential.iterations>=10000&&credential.iterations<=100000&&/^[a-f0-9]{32}$/.test(credential.salt)&&/^[a-f0-9]{64}$/.test(credential.verifier);
 const result=await derive(id,password,valid?credential.salt:'0'.repeat(32),valid?credential.iterations:ADMIN_ITERATIONS);
 const matched=timingSafeEqual(result,Buffer.from(valid?credential.verifier:'0'.repeat(64),'hex'));
 return !!valid&&matched;
}
