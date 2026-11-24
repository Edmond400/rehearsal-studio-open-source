import type {Project} from './model';

const canonical = (value: unknown): unknown => {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonical(child)]));
 return value;
};
export const sameDraftValue = (a: unknown, b: unknown) => a===b || JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function paragraphGroups(blocks: Project['blocks']) {
 const groups = new Map<string, Project['blocks']>();
 for (const block of blocks) {
  const group = groups.get(block.paragraphId) ?? [];
  group.push(block);
  groups.set(block.paragraphId, group);
 }
 return groups;
}

export function mergeDraft(base: Project, local: Project, server: Project) {
 const conflicts: string[] = [];
 const choose = <T>(a: T, b: T, c: T, label: string): T => {
  if (sameDraftValue(b, a)) return c;
  if (sameDraftValue(c, a) || sameDraftValue(b, c)) return b;
  conflicts.push(label);
  return c;
 };
 const baseDeck = [base.slides, base.sourceDeck], localDeck = [local.slides, local.sourceDeck], serverDeck = [server.slides, server.sourceDeck];
 if ((!sameDraftValue(baseDeck, localDeck) && !sameDraftValue(base.blocks, server.blocks)) ||
     (!sameDraftValue(baseDeck, serverDeck) && !sameDraftValue(base.blocks, local.blocks))) {
  conflicts.push('PPT 页序与讲稿映射');
 }
 let blocks = server.blocks;
 if (sameDraftValue(base.blocks, server.blocks)) blocks = local.blocks;
 else if (!sameDraftValue(base.blocks, local.blocks) && !sameDraftValue(local.blocks, server.blocks)) {
  const a = paragraphGroups(base.blocks), b = paragraphGroups(local.blocks), c = paragraphGroups(server.blocks);
  const order = choose([...a.keys()], [...b.keys()], [...c.keys()], '段落顺序');
  const groups = new Map([...new Set([...a.keys(), ...b.keys(), ...c.keys()])].map(key =>
   [key, choose(a.get(key), b.get(key), c.get(key), '第 ' + ([...a.keys()].indexOf(key) + 1 || '新') + ' 段')]));
  blocks = order.flatMap(key => groups.get(key) ?? []);
 }
 const merged = {...server, blocks};
 for (const field of ['title','theme','publishedAt','members','slides','sourceDeck','overrides'] as const) {
  Object.assign(merged, {[field]: choose(base[field], local[field], server[field], field)});
 }
 for (const key of Object.keys(base.config) as (keyof Project['config'])[]) {
  if (key === 'version') continue;
  merged.config = {...merged.config, [key]: choose(base.config[key], local.config[key], server.config[key], key)};
 }
 const members = new Set(merged.members.map(m => m.id));
 if (blocks.some(b => b.memberId && !members.has(b.memberId))) conflicts.push('组员与分工');
 return conflicts.length ? {conflicts: [...new Set(conflicts)]} : {project: merged, conflicts: []};
}
