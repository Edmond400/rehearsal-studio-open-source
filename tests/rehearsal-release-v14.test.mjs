import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
const require=createRequire(import.meta.url),{build}=require(require.resolve('esbuild',{paths:[dirname(require.resolve('wrangler/package.json'))]}));
const compiled=await build({stdin:{contents:"export * from './lib/rehearsal/turn-identity';export * from './lib/rehearsal/legacy-releases';export {DEFAULT_CONFIG} from './lib/rehearsal/model';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {identifyReleaseTurns,sameTurnContent,remapRecordedEvents,planLegacyReleases,DEFAULT_CONFIG}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const block=(id,memberId,text,slideIndex,extras={})=>({id,paragraphId:id,text,memberId,slideIndex,paragraphEnd:true,nonspoken:false,...extras});
const slide=(id,pageIndex)=>({id,pageIndex,mime:'image/png',bytes:25});
const hashes=new Map([['s1','a'.repeat(64)],['s2','b'.repeat(64)],['extra','c'.repeat(64)],['extra-replacement','d'.repeat(64)]]);
const p={
 id:'fixture',title:'示例',theme:'',status:'published',publishedAt:null,updatedAt:'2026-11-04T00:00:00.000Z',
 revision:1,scriptVersion:'script-1',deckVersion:'deck-1',algorithmVersion:DEFAULT_CONFIG.version,
 config:DEFAULT_CONFIG,members:[{id:'a',name:'甲',enabled:true},{id:'b',name:'乙',enabled:true}],
 blocks:[block('a1','a','这是甲的发言。',0),block('b1','b','这是乙的发言。',1)],
 slides:[slide('s1',0),slide('s2',1),slide('extra',2)],overrides:{}
};
const old=await identifyReleaseTurns(p,hashes);
assert(old.every((t,i)=>t.uid!==t.legacyTurnId&&t.ordinal===i));
const changed={...p,revision:2,scriptVersion:'script-2',blocks:[{...p.blocks[0],text:'甲修改自己的内容。'},p.blocks[1]]};
const next=await identifyReleaseTurns(changed,hashes,old);
assert.equal(next[0].uid,old[0].uid);
assert(!sameTurnContent(next[0],old[0]));
assert(sameTurnContent(next[1],old[1]),'changing one turn must not invalidate another');
const split={...p,blocks:[{...p.blocks[0],text:'这是甲的',paragraphEnd:false},block('a2','a','发言。',0),p.blocks[1]]};
assert(sameTurnContent((await identifyReleaseTurns(split,hashes,old))[0],old[0]),'a formatting split is not a spoken edit');
const deck={...p,slides:[slide('extra-replacement',0),slide('s2',1),slide('s1',2)],blocks:[{...p.blocks[0],slideIndex:2},p.blocks[1]],config:{...p.config,hardLimitSeconds:600}};
const reordered=await identifyReleaseTurns(deck,hashes,old);
assert(reordered.every((t,i)=>sameTurnContent(t,old[i])));
const events=[{t_ms:0,slide_index:0,source:'start'},{t_ms:500,slide_index:1,source:'manual'}];
assert.deepEqual(remapRecordedEvents(events,p,deck,hashes),[{...events[0],slide_index:2},events[1]]);
assert.equal(remapRecordedEvents([{...events[0],slide_index:2}],p,deck,hashes),null,'a manually viewed removed slide cannot be guessed by index');
const changedHash=new Map(hashes).set('s1','f'.repeat(64));
assert(!sameTurnContent((await identifyReleaseTurns(p,changedHash,old))[0],old[0]));
assert(sameTurnContent((await identifyReleaseTurns(p,changedHash,old))[1],old[1]));
const merged={...p,blocks:[p.blocks[0],{...p.blocks[1],memberId:'a'}]};
const [mergedTurn]=await identifyReleaseTurns(merged,hashes,old);
assert(!old.some(t=>t.uid===mergedTurn.uid),'speaker change and turn merge require a new identity');
const repeat={...p,blocks:[block('a1','a','重复',0),p.blocks[1],block('a2','a','重复',0)]};
const oldRepeat=await identifyReleaseTurns(repeat,hashes);
const noLineage={...repeat,blocks:repeat.blocks.map(b=>({...b,id:b.id+'new'}))};
const repeatNew=await identifyReleaseTurns(noLineage,hashes,oldRepeat);
assert(!oldRepeat.some(t=>t.uid===repeatNew[0].uid||t.uid===repeatNew[2].uid),'ambiguity never guesses a repeated turn');
assert.equal(repeatNew[1].uid,oldRepeat[1].uid);
const speakingOverride={...p,blocks:[{...p.blocks[0],spokenText:'实际读法。'},p.blocks[1]]};
assert(!sameTurnContent((await identifyReleaseTurns(speakingOverride,hashes,old))[0],old[0]));
const legacy={id:'audio1',memberId:'a',turnId:'turn-a1',scriptVersion:p.scriptVersion,deckVersion:p.deckVersion,algorithmVersion:p.algorithmVersion,durationMs:1000,events,snapshot:{blocks:[p.blocks[0]],slides:p.slides}};
const unresolved={...legacy,id:'audio2',snapshot:{slides:p.slides}};
const plan=await planLegacyReleases(p.id,changed,[p,changed],[legacy,unresolved],hashes);
assert.equal(plan.releases.length,2);
assert.equal(plan.head,plan.releases[1].id);
assert.deepEqual(plan.refs,[{recordingId:legacy.id,releaseId:plan.releases[0].id,turnUid:plan.releases[0].turns[0].uid}]);
assert.deepEqual(plan.unresolved,[unresolved.id]);
assert.deepEqual(await planLegacyReleases(p.id,changed,[p,changed],[legacy,unresolved],hashes),plan,'re-entry generates identical IDs');
assert.equal((await planLegacyReleases(p.id,null,[p],[legacy],hashes)).head,null);
const ambiguous=await planLegacyReleases(p.id,{...p,revision:3},[p],[legacy],hashes);
assert.deepEqual(ambiguous.unresolved,[legacy.id]);assert.equal(ambiguous.refs.length,0);
console.log('PASS per-turn identity, split/reorder stability, local edits and actual reading/slide changes, event remap, legacy snapshot planning and ambiguity isolation.');
