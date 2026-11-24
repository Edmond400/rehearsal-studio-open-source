'use client';
let selected='',token='',epoch=0;
const key='studio.project';
function restore(){if(!selected)try{const id=sessionStorage.getItem(key)||'';if(/^[a-zA-Z0-9_-]{1,80}$/.test(id))selected=id}catch{}}
export function rehearsalProject(){restore();return selected}
export function rehearsalHeaders(){restore();return {...(selected?{'X-Studio-Project':selected}:{}),...(token?{'X-Studio-Session':token}:{})} as Record<string,string>}
export function rehearsalScope(){restore();return selected+':'+token+':'+epoch}
export function selectRehearsal(id:string,value?:string){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('汇报标识无效');if(value!==undefined)token=value;else if(selected!==id)token='';selected=id;epoch++;try{sessionStorage.setItem(key,id)}catch{}}
export function leaveRehearsal(){selected='';token='';epoch++;try{sessionStorage.removeItem(key)}catch{}}
