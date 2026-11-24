export class HttpError extends Error { constructor(public status:number,message:string){super(message)} }
export function json(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Vary':'Cookie, Authorization'}})}
export function fail(error:unknown){if(error instanceof HttpError)return json({error:error.message},error.status);console.error('request-failed',error instanceof Error?error.message:'unknown');return json({error:'暂时无法完成操作，请稍后重试。你的填写内容仍保留在页面中。'},500)}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');const expected=env.PUBLIC_SITE_ORIGIN||new URL(request.url).origin;if((!origin || origin!==expected)&&!nativeRequest(request))throw new HttpError(403,'请求来源无效，请刷新页面重试。')}
export async function readBytes(request:Request,max:number){const len=Number(request.headers.get('content-length')||0);if(len>max)throw new HttpError(413,'提交内容过大。');const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max){await reader.cancel();throw new HttpError(413,'提交内容过大。')}chunks.push(part.value)}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}return bytes}
export async function readJson(request:Request){sameOrigin(request);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(415,'请通过页面表单提交。');const bytes=await readBytes(request,100000);try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new HttpError(400,'提交格式有误。')}}
import { env } from 'cloudflare:workers';
export function nativeRequest(request:Request){return !!env.NATIVE_APP_ORIGIN&&request.headers.get('origin')===env.NATIVE_APP_ORIGIN&&request.headers.get('X-Studio-Transport')==='bearer'}
export async function apiCors(request:Request,handle:()=>Promise<Response>){
 const nativeOrigin=env.NATIVE_APP_ORIGIN;
 if(request.method==='OPTIONS'){
  if(!nativeOrigin||request.headers.get('origin')!==nativeOrigin)return json({error:'请求来源无效'},403);
  const allowed=new Set(['content-type','x-studio-project','x-studio-session','x-studio-transport','x-studio-anonymous','x-rehearsal-metadata','range']);
  if((request.headers.get('access-control-request-headers')||'').split(',').some(h=>h.trim()&&!allowed.has(h.trim().toLowerCase())))return json({error:'请求头无效'},403);
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':nativeOrigin,'Access-Control-Allow-Methods':'GET,HEAD,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':[...allowed].join(','),'Access-Control-Max-Age':'300','Vary':'Origin'}});
 }
 const r=await handle();if(!nativeRequest(request))return r;
 const headers=new Headers(r.headers);headers.set('Access-Control-Allow-Origin',nativeOrigin!);headers.set('Access-Control-Expose-Headers','Content-Range,Content-Length,Accept-Ranges,ETag');headers.append('Vary','Origin');return new Response(r.body,{status:r.status,statusText:r.statusText,headers});
}
