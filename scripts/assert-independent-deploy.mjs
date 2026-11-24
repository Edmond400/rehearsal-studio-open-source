import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
function assertIndependent(path, expectedR2Reads){
 const cfg=JSON.parse(readFileSync(path,'utf8'));
 const db=cfg.d1_databases;
 const crons=cfg.triggers?.crons;
 const r2=cfg.r2_buckets??[];
 const r2Reads=cfg.vars?.STUDIO_R2_READS==='on';
 if(cfg.vars?.STUDIO_R2_WRITES!==undefined||!Array.isArray(r2)||
    (expectedR2Reads!==undefined&&r2Reads!==expectedR2Reads)||
    (r2Reads?(r2.length!==1||r2[0]?.binding!=='STUDIO_MEDIA'||
      r2[0]?.bucket_name!=='rehearsal-studio-media'||r2[0]?.preview_bucket_name!==undefined||
      r2[0]?.jurisdiction!==undefined||r2[0]?.remote===true):r2.length!==0))
  throw new Error('Refusing deployment: unexpected media bucket or storage mode');
 if(crons!==undefined&&(!Array.isArray(crons)||crons.length>1||crons.some(cron=>cron!=='0 19 * * *')))
  throw new Error('Refusing deployment: unexpected scheduled trigger');
 if(cfg.name!=='rehearsal-studio'||Object.keys(cfg.triggers||{}).some(k=>k!=='crons')||cfg.routes?.length||!Array.isArray(db)||db.length!==1||db[0].binding!=='DB'||db[0].database_name!=='rehearsal-studio'||db[0].database_id!=='00000000-0000-4000-8000-000000000001'||cfg.services?.length)throw new Error('Refusing deployment: isolated resource invariant failed');
 return r2Reads;
}
const r2Reads=assertIndependent('wrangler.json');
// Vite redirects Wrangler to generated configuration. Check that exact target as
// well as source configuration, so stale output cannot deploy another service.
const redirect='.wrangler/deploy/config.json';
if(existsSync(redirect)){
 const cfg=JSON.parse(readFileSync(redirect,'utf8'));
 if(cfg.auxiliaryWorkers?.length)throw new Error('Refusing deployment: unexpected auxiliary Workers');
 assertIndependent(resolve(dirname(redirect),cfg.configPath),r2Reads);
}
console.log('PASS independent deployment resource guard');
