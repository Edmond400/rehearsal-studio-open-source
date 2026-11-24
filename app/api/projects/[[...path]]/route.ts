import {apiCors} from '@/lib/http';
import {handleProjects} from '@/lib/projects';
async function handle(request:Request,{params}:{params:Promise<{path?:string[]}>}){const path=(await params).path||[];return apiCors(request,()=>handleProjects(request,path))}
export {handle as GET,handle as POST,handle as DELETE,handle as HEAD,handle as OPTIONS};
