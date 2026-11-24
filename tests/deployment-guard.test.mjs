import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const dir=mkdtempSync(tmpdir()+'/studio-deploy-'),script=resolve('scripts/assert-independent-deploy.mjs'),safe=JSON.parse(readFileSync('wrangler.json','utf8'));
const write=(path,value)=>writeFileSync(dir+'/'+path,JSON.stringify(value));
const run=()=>spawnSync(process.execPath,[script],{cwd:dir,encoding:'utf8'}).status;
try{
 write('wrangler.json',safe);assert.equal(run(),0);
 for(const change of [c=>c.d1_databases=[],c=>c.d1_databases[0].database_id='other-database',c=>c.routes=[{pattern:'class.example.invalid'}],c=>c.routes=['*.class.example.invalid/*'],c=>c.triggers={crons:['0 * * * *']},c=>c.r2_buckets=[{binding:'BUCKET'}],c=>c.r2_buckets[0].bucket_name='another-bucket',c=>c.r2_buckets[0].preview_bucket_name='another-bucket',c=>c.r2_buckets.push({...c.r2_buckets[0]}),c=>delete c.vars.STUDIO_R2_READS,c=>c.vars.STUDIO_R2_WRITES='on',c=>c.services=[{binding:'OTHER',service:'yi68-classroom'}]]){
  const bad=structuredClone(safe);change(bad);write('wrangler.json',bad);assert.notEqual(run(),0,'unexpected resource must be refused');
 }
 write('wrangler.json',safe);mkdirSync(dir+'/.wrangler/deploy',{recursive:true});mkdirSync(dir+'/dist/server',{recursive:true});
 write('.wrangler/deploy/config.json',{configPath:'../../dist/server/wrangler.json',auxiliaryWorkers:[]});write('dist/server/wrangler.json',{...safe,triggers:{}});assert.equal(run(),0,'generated empty triggers are harmless');
 const oldConfig=structuredClone(safe);delete oldConfig.vars.STUDIO_R2_READS;delete oldConfig.r2_buckets;
 write('dist/server/wrangler.json',oldConfig);assert.notEqual(run(),0,'stale generated output cannot omit the R2 read binding');
 const stale=structuredClone(safe);stale.name='yi68-classroom';write('dist/server/wrangler.json',stale);assert.notEqual(run(),0,'stale generated output cannot deploy the class service');
 // The default branch contains a manual release workflow as a dispatcher,
 // but it must NEVER deploy due to an ordinary push or pull request.
 const release=readFileSync(resolve('.github/workflows/v15-production.yml'),'utf8');
 assert.match(release,/^  workflow_dispatch:/m,'V1.5 release must require manual dispatch');
 assert.doesNotMatch(release,/^  (push|pull_request|schedule):/m,'V1.5 must not deploy on ordinary pushes, PRs or cron');
 assert.match(release,/github\.ref == 'refs\/heads\/release\/v1\.5'/,'release branch allowlist missing');
 assert.match(release,/inputs\.confirmation == 'V1\.5-R2-COMPAT-E3'/,'manual confirmation missing');
 assert.match(release,/^    environment: production$/m,'production environment gate missing');
 assert.match(release,/0013_r2_uploads\.sql/,'E3 migration must be explicit');
 const deployIndex=release.indexOf('pnpm exec wrangler versions upload');
 const verifyIndex=release.indexOf('pnpm exec wrangler versions view');
 const promoteIndex=release.indexOf('pnpm exec wrangler versions deploy');
 assert(deployIndex>0&&deployIndex<verifyIndex&&verifyIndex<promoteIndex,'candidate metadata must be verified before promotion');
 assert.match(release,/wrangler versions upload --no-x-provision --name rehearsal-studio\b/,'production deployment must use only existing resources');
 const verification=release.slice(verifyIndex,promoteIndex);
 assert.match(verification,/bucket_name !== 'rehearsal-studio-media'/,'candidate R2 bucket must be checked');
 assert.match(verification,/binding\.name === 'STUDIO_R2_WRITES'/,'candidate must reject the R2 write flag');
 assert.match(release,/versions deploy "\$\{version\}@100" --name rehearsal-studio --yes/);
 for(const marker of ['node scripts/assert-independent-deploy.mjs','Require successful CI for this exact release SHA',
   'wrangler deployments list --name rehearsal-studio',
   'wrangler d1 time-travel info rehearsal-studio','python scripts/d1-readonly-backup.py',
   'wrangler deploy --dry-run']){
  const index=release.indexOf(marker);
  assert(index>=0&&index<deployIndex,'mandatory release preflight step missing or located after deployment: '+marker);
 }
 const backupTests=spawnSync('python',['tests/d1-readonly-backup.test.py'],{encoding:'utf8'});
 assert.equal(backupTests.status,0,'read-only backup must pass lossless restore, consistency and foreign-key regressions: '+backupTests.stderr);
 const checks=readFileSync(resolve('.github/workflows/v15-checks.yml'),'utf8');
 for(const marker of ['pnpm test:v15','pnpm test:v14','bash scripts/run-v15-browser-ci.sh','node tests/studio-r2-write.test.mjs'])
  assert(checks.includes(marker),'release CI must cover '+marker);
 assert.match(release,/^  e3-writes:\s*$/m,'R2 write workflow must be separate from the guarded reader');
 assert.doesNotMatch(checks,/\bpnpm deploy\b|wrangler deploy(?! --dry-run)/,'development CI must not deploy');
 console.log('PASS deployment isolation: exact Worker/D1, only the confirmed read-only R2 target and permitted schedule, generated-config redirect checked.');
}finally{rmSync(dir,{recursive:true,force:true})}
