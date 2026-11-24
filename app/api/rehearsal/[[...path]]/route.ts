import {apiCors} from '@/lib/http';
import {handleRehearsal} from '@/lib/rehearsal/service';
export const dynamic='force-dynamic';
type Context={params:Promise<{path?:string[]}>};
export async function GET(request:Request,context:Context){const path=(await context.params).path||[];return apiCors(request,()=>handleRehearsal(request,path))}
export const HEAD=GET;
export const POST=GET;

export const OPTIONS=GET;
