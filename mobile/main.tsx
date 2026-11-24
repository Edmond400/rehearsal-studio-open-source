import React from 'react';
import {createRoot} from 'react-dom/client';
import {Capacitor} from '@capacitor/core';
import {App} from '@capacitor/app';
import {Filesystem,Directory} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {Studio} from '../components/studio';
import {configureTransport} from '../lib/transport';
import '../app/globals.css';
import '../app/v15.css';
const apiOrigin=import.meta.env.VITE_API_ORIGIN;
if(!apiOrigin||new URL(apiOrigin).protocol!=='https:')throw new Error('构建时必须明确设置HTTPS API地址');
const native=Capacitor.isNativePlatform();
configureTransport({apiOrigin,native,saveFile:native?async(blob,name)=>{
 const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('无法准备下载文件'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(blob)});
 const path='exports/'+Date.now()+'-'+name.replace(/[\\/:*?"<>|]/g,'_');await Filesystem.writeFile({path,data,directory:Directory.Cache,recursive:true});const file=await Filesystem.getUri({path,directory:Directory.Cache});await Share.share({title:name,url:file.uri,dialogTitle:'保存或分享文件'});
}:undefined});
if(native){
 App.addListener('backButton',()=>{const event=new Event('studio:native-back',{cancelable:true});if(window.dispatchEvent(event))void App.minimizeApp()});
 App.addListener('appStateChange',({isActive})=>{window.dispatchEvent(new CustomEvent('studio:app-state',{detail:{isActive}}))});
}
const params=new URLSearchParams(location.search),id=params.get('project')||'';
createRoot(document.getElementById('root')!).render(<React.StrictMode><header className="studio-header"><strong>Rehearsal Studio</strong><a href={new URL('/privacy',apiOrigin).href} target="_blank" rel="noreferrer">隐私说明</a></header><main className="studio-main"><Studio initialId={id}/></main></React.StrictMode>);
