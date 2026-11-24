'use client';
import {useRef,useState} from 'react';
export function FilePicker({label,hint,accept,multiple=false,disabled=false,onFiles}:{
 label:string;hint?:string;accept:string;multiple?:boolean;disabled?:boolean;
 onFiles:(files:FileList|null)=>void;
}){
 const input=useRef<HTMLInputElement>(null),[selected,setSelected]=useState('');
 return <div className="rh-file-picker">
  <span className="rh-file-picker-label">{hint??label}</span>
  <div className="rh-file-picker-control">
   <button type="button" disabled={disabled} onClick={()=>input.current?.click()}>选择文件</button>
   <span className="rh-file-summary" aria-live="polite">{selected||'尚未选择文件'}</span>
  </div>
  <input ref={input} className="rh-visually-hidden" aria-label={label} type="file" accept={accept} multiple={multiple} disabled={disabled}
   onChange={e=>{const files=e.currentTarget.files;if(files?.length){
    setSelected(Array.from(files).map(file=>file.name).join('、'));onFiles(files);
   }e.currentTarget.value='';}}/>
 </div>;
}
