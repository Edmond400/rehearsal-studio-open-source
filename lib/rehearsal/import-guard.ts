/** Import never acts as an implicit delete. */
export function normalizeImportedScript(input:string):string{
 if(typeof input!=='string')throw new Error('无法读取讲稿文本。');
 const normalized=input.replace(/\r\n?/g,'\n').replace(/^\uFEFF/,'').trim();
 if(!normalized)throw new Error('讲稿为空；原有内容未被替换。');
 if(normalized.length>80000)throw new Error('讲稿总长度不能超过 80000 字符。');
 return normalized.replace(/(?<!\n)\n(?!\n)/g,'\n\n');
}
export function importParagraphCount(text:string){return text.split(/\n{2,}/).filter(part=>part.trim()).length;}
