// Standard wrapper from the locked official @capacitor/cli package, never a credential.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const archive=gunzipSync(readFileSync('node_modules/@capacitor/cli/assets/android-template.tar.gz'));
let found=false;
for(let pos=0;pos+512<=archive.length;){const h=archive.subarray(pos,pos+512),name=h.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(h.subarray(124,136).toString().replace(/\0.*$/s,'').trim()||'0',8);if(!name)break;if(name.endsWith('gradle/wrapper/gradle-wrapper.jar')){mkdirSync('android/gradle/wrapper',{recursive:true});writeFileSync('android/gradle/wrapper/gradle-wrapper.jar',archive.subarray(pos+512,pos+512+size));found=true;break}pos+=512+Math.ceil(size/512)*512}
if(!found)throw new Error('Locked Capacitor template has no Gradle wrapper');
console.log('Prepared official Capacitor Gradle wrapper');
