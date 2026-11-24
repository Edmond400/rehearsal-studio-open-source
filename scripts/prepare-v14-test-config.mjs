import {readFileSync,writeFileSync,existsSync} from 'node:fs';

const output='dist/server/wrangler.v14-test.json';
const localDb='577b8104-6d2d-4ba2-9240-c2c274eae4ff';
const [databaseId=localDb]=process.argv.slice(2);
if(process.argv.length>3||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId)){
 throw new Error('Expected an isolated D1 UUID or no argument for local testing');
}
const source=JSON.parse(readFileSync('wrangler.json','utf8'));
const generated=JSON.parse(readFileSync('dist/server/wrangler.json','utf8'));
if(source.d1_databases.concat(generated.d1_databases).some(db=>db.database_id.toLowerCase()===databaseId.toLowerCase())){
 throw new Error('Refusing to use a production D1 binding in the test build');
}
if(generated.main!=='index.js'||generated.assets?.directory!=='../client'||!existsSync('dist/server/index.js')){
 throw new Error('Build the V1.4 candidate before preparing its test configuration');
}
const test={
 name:'rehearsal-studio-v14-perf-test',
 main:generated.main,
 compatibility_date:generated.compatibility_date,
 compatibility_flags:generated.compatibility_flags,
 rules:generated.rules,
 assets:{directory:'../client'},
 workers_dev:true,
 preview_urls:false,
 observability:{enabled:true},
 // Synthetic 64-hex pepper belongs ONLY in this isolated, local test config.
 vars:{NATIVE_APP_ORIGIN:'https://localhost',STUDIO_PASSWORD_PEPPER:'a'.repeat(64)},
 d1_databases:[{binding:'DB',database_name:'rehearsal-studio-v14-perf-test-db',database_id:databaseId,migrations_dir:'../../migrations'}]
};
writeFileSync(output,JSON.stringify(test,null,2)+'\n');
console.log(output, databaseId===localDb?'(local fixture ID)': '(isolated D1 ID supplied)');
