import {mergeFragments, scriptSpans} from './editing';
import {newRehearsalId, type Block, type Project} from './model';

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
export const scriptText = (blocks: Block[]) => scriptSpans(blocks).map(s => s.separator + s.block.text).join('');

function paragraphs(blocks: Block[]) {
 const groups: Block[][] = [];
 for (const block of blocks) {
  const current = groups.at(-1);
  if (current?.[0].paragraphId === block.paragraphId) current.push(block);
  else groups.push([block]);
 }
 return groups.map(parts => ({parts, text: parts.map(b => normalize(b.text)).join('')}));
}

export function reconcileScript(project: Project, value: string, id = newRehearsalId) {
 const text = normalize(value);
 if (text.length > 80000) throw new Error('讲稿总长度不能超过 80000 字符。');
 if (text === scriptText(project.blocks)) return {blocks: project.blocks, warnings: [] as string[]};
 const before = paragraphs(project.blocks);
 const after = text.split(/\n{2,}/).filter(Boolean);
 const used = new Set<number>();
 const matched = new Map<number, number>();
 const warnings = new Set<string>();
 for (const [index, paragraph] of after.entries()) {
  const exact = before.flatMap((p, i) => p.text === paragraph ? [i] : []);
  if (exact.length === 1 && after.indexOf(paragraph) === after.lastIndexOf(paragraph)) {
   matched.set(index, exact[0]);
   used.add(exact[0]);
  }
 }
 const newBlock = (text: string, paragraphId: string, sample?: Block): Block => ({
  id: id(), paragraphId, text, memberId: sample?.memberId ?? null, slideIndex: sample?.slideIndex ?? null,
  nonspoken: sample?.nonspoken ?? false, paragraphEnd: false
 });
 const result: Block[] = [];
 const sameTextAcrossBreaks=before.map(p=>p.text).join('')===after.join('');
 if(sameTextAcrossBreaks){
  const spans: {start:number;end:number;block:Block}[]=[];
  let offset=0;
  for(const {parts} of before)for(const b of parts){
   const block={...b,text:normalize(b.text)};
   spans.push({start:offset,end:offset+block.text.length,block});offset+=block.text.length;
  }
  const usedIds=new Set<string>(),usedParagraphs=new Set<string>();
  let start=0,cursor=0;
  for(const paragraph of after){
   const end=start+paragraph.length,source=spans[cursor]?.block.paragraphId;
   const paragraphId=source&&!usedParagraphs.has(source)?source:id();
   usedParagraphs.add(paragraphId);
   while(cursor<spans.length&&spans[cursor].start<end){
    const span=spans[cursor],left=Math.max(start,span.start),right=Math.min(end,span.end);
    if(right>left){
     const b=span.block,whole=left===span.start&&right===span.end;
     if(!whole&&(b.spokenText!==undefined||b.manualSpeechSeconds!==undefined||b.longPause||b.chartAction||b.formulaAction||b.extraSeconds)){
      warnings.add('段落边界切过特殊读法或停顿，请核对。');
     }
     const stable=usedIds.has(b.id)?id():b.id;
     usedIds.add(stable);
     result.push({...whole?b:newBlock(b.text.slice(left-span.start,right-span.start),paragraphId,b),id:stable,paragraphId,paragraphEnd:right===end});
    }
    if(span.end>end)break;
    cursor++;
   }
   start=end;
  }
 }
 for (const [index, paragraph] of (sameTextAcrossBreaks?[]:after).entries()) {
  const original = matched.get(index);
  if (original !== undefined) {
   result.push(...before[original].parts);
   continue;
  }
  // Only infer edits within the same unambiguous positional paragraph.
  const old = before[index];
  if (!old || used.has(index) || before.length !== after.length ||
      before.some((p, i) => i !== index && p.text === old.text)) {
   result.push({...newBlock(paragraph, id()), paragraphEnd: true});
   warnings.add('无法确认部分段落的原有分工，请用格式刷重新分配。');
   continue;
  }
  let left = 0, right = 0;
  while (left < paragraph.length && left < old.text.length && paragraph[left] === old.text[left]) left++;
  while (right < paragraph.length - left && right < old.text.length - left &&
         paragraph[paragraph.length - 1 - right] === old.text[old.text.length - 1 - right]) right++;
  const oldEnd = old.text.length - right;
  const changed = paragraph.slice(left, paragraph.length - right);
  const paragraphId = old.parts[0].paragraphId;
  const ranges = scriptSpans(old.parts.map(b => ({...b, text: normalize(b.text)})));
  const signature = (b: Block) => JSON.stringify([b.memberId, b.slideIndex, b.nonspoken]);
  const affected = ranges.filter(r => r.start < oldEnd && r.end > left);
  const nearby = changed ? ranges.filter(r => r.start <= left && r.end >= oldEnd) : [];
  const sample = left + right > 0 && nearby.length && nearby.every(r => signature(r.block) === signature(nearby[0].block))
   ? nearby[0].block : undefined;
  const emitted = new Set<string>();
  function retained(from: number, to: number) {
   return ranges.flatMap(r => {
    const a = Math.max(from, r.start), z = Math.min(to, r.end);
    if (a >= z) return [];
    const block = r.block;
    const blockId = emitted.has(block.id) ? id() : block.id;
    emitted.add(block.id);
    if (a === r.start && z === r.end) return [{...block, paragraphEnd: false}];
    if (block.spokenText !== undefined || block.manualSpeechSeconds !== undefined || block.spellOut?.length ||
        block.longPause || block.chartAction || block.formulaAction || block.extraSeconds) {
     warnings.add('修改涉及特殊读法或停顿，请核对新稿。历史版本保留原设置。');
    }
    return [{...newBlock(old.text.slice(a, z), paragraphId, block), id: blockId}];
   });
  }
  const leading = retained(0, left);
  const whole = sample && affected.length === 1 && !leading.some(b => b.id === sample.id) && affected[0].end <= oldEnd;
  const pieces = [...leading,
   ...(changed ? [{...newBlock(changed, paragraphId, sample), ...(whole ? {id: sample.id} : {})}] : []),
   ...retained(oldEnd, old.text.length)];
  if (changed && !sample) warnings.add('新文字跨越分工边界或缺少可靠匹配，请重新分配。');
  if (affected.some(r => r.block.spokenText !== undefined || r.block.manualSpeechSeconds !== undefined ||
                         r.block.spellOut?.length || r.block.longPause || r.block.chartAction || r.block.formulaAction || r.block.extraSeconds)) {
   warnings.add('修改涉及特殊读法或停顿，请核对新稿。历史版本保留原设置。');
  }
  if (pieces.length) pieces[pieces.length - 1] = {...pieces.at(-1)!, paragraphEnd: true};
  result.push(...pieces);
 }
 const bounded = result.flatMap(b => {
  if (b.text.length <= 20000) return [b];
  const parts: Block[] = [];
  for (let i = 0; i < b.text.length;) {
   let end = Math.min(i + 20000, b.text.length);
   if (end < b.text.length && /[\uD800-\uDBFF]/.test(b.text[end - 1])) end--;
   parts.push({...b, id: i ? id() : b.id, text: b.text.slice(i, end), paragraphEnd: end === b.text.length && b.paragraphEnd});
   i = end;
  }
  return parts;
 });
 const blocks = mergeFragments(bounded);
 if (blocks.length > 500) throw new Error('分工范围超过 500 个，请缩小本次修改范围。');
 return {blocks, warnings: [...warnings]};
}
