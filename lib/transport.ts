'use client';
let apiOrigin='',native=false,anonymous='';
let fileSaver:((blob:Blob,name:string)=>Promise<void>)|undefined;
export function configureTransport(config:{apiOrigin:string;native:boolean;saveFile?:(blob:Blob,name:string)=>Promise<void>}){const u=new URL(config.apiOrigin);if(u.protocol!=='https:')throw new Error('API必须使用HTTPS');apiOrigin=u.origin;native=config.native;fileSaver=config.saveFile}
export function apiUrl(path:string){if(!path.startsWith('/api/'))throw new Error('无效API路径');return apiOrigin+path}
export function transportHeaders(){return native?{'X-Studio-Transport':'bearer',...(anonymous?{'X-Studio-Anonymous':anonymous}:{})}:{} as Record<string,string>}
export function acceptAnonymous(value:unknown){if(native&&typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))anonymous=value}
export function clearTransport(){anonymous=''}
export function apiFetch(path:string,init:RequestInit={}){const headers=new Headers(init.headers);for(const [k,v] of Object.entries(transportHeaders()))headers.set(k,v);return fetch(apiUrl(path),{...init,headers,credentials:native?'omit':init.credentials||'same-origin'})}
export async function saveBlob(blob:Blob,name:string){if(fileSaver)return fileSaver(blob,name);const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}

export function projectLink(id:string){return (apiOrigin||location.origin)+'/p/'+encodeURIComponent(id)}
