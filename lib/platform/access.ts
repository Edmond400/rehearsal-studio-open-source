import {env} from 'cloudflare:workers';
import {createPublicKey,verify} from 'node:crypto';
import {HttpError} from '../http';

type AccessConfig={issuer:string;audience:string;subjects:string[]};
type AccessKey=JsonWebKey&{kid?:string};
type PlatformAdmin={role:'platform_admin';subject:string};

let keyCache:{issuer:string;keys:AccessKey[];expires:number}|undefined;
async function keys(issuer:string){
 if(keyCache?.issuer===issuer&&keyCache.expires>Date.now())return keyCache.keys;
 let result:Response;
 try{result=await fetch(issuer+'/cdn-cgi/access/certs',{redirect:'manual',signal:AbortSignal.timeout(5000)});}
 catch{throw new HttpError(503,'管理员认证服务暂不可用。');}
 if(!result.ok)throw new HttpError(503,'管理员认证服务暂不可用。');
 const body=await result.json() as {keys?:AccessKey[]};
 if(!Array.isArray(body.keys))throw new HttpError(503,'管理员认证服务暂不可用。');
 keyCache={issuer,keys:body.keys,expires:Date.now()+5*60*1000};
 return body.keys;
}

function decode(part:string){
 return JSON.parse(Buffer.from(part,'base64url').toString('utf8'));
}

export async function validateAccess(token:string,config:AccessConfig,getKeys=keys,now=Math.floor(Date.now()/1000)):Promise<PlatformAdmin>{
 const denied=()=>new HttpError(401,'请通过平台管理员身份验证。');
 if(token.length>12000||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(token))throw denied();
 const [head,body,signature]=token.split('.');
 let header,claims;
 try{header=decode(head);claims=decode(body);}catch{throw denied();}
 if(!header||!claims||header.alg!=='RS256'||typeof header.kid!=='string')throw denied();
 if(claims.iss!==config.issuer||claims.type!=='app'||!Array.isArray(claims.aud)||!claims.aud.includes(config.audience)
  ||!Number.isSafeInteger(claims.exp)||claims.exp<=now||!Number.isSafeInteger(claims.iat)
  ||claims.iat>now+30||claims.exp<=claims.iat||claims.exp-claims.iat>3600
  ||(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>now+30))
  ||typeof claims.sub!=='string'||!claims.sub||typeof claims.email!=='string'||!claims.email)throw denied();
 const jwk=(await getKeys(config.issuer)).find(key=>key.kid===header.kid&&key.kty==='RSA');
 if(!jwk)throw denied();
 let valid=false;
 try{valid=verify('RSA-SHA256',Buffer.from(head+'.'+body),createPublicKey({key:jwk as import('node:crypto').JsonWebKey,format:'jwk'}),Buffer.from(signature,'base64url'));}catch{}
 if(!valid)throw denied();
 if(!config.subjects.includes(claims.sub))throw new HttpError(403,'此身份没有平台管理权限。');
 return {role:'platform_admin',subject:claims.sub};
}

export async function platformAdmin(request:Request){
 const issuer=env.STUDIO_ACCESS_ISSUER??'',audience=env.STUDIO_ACCESS_AUDIENCE??'';
 const subjects=(env.STUDIO_PLATFORM_ADMIN_SUBJECTS??'').split(',').map(value=>value.trim()).filter(Boolean);
 if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)||!/^[a-f0-9]{64}$/.test(audience)||!subjects.length)
  throw new HttpError(403,'运营监测暂未启用。');
 return validateAccess(request.headers.get('Cf-Access-Jwt-Assertion')??'',{issuer,audience,subjects});
}
