import {HttpError} from '../http';
import {authorize} from '../security';
export function requestProject(request:Request){const id=request.headers.get('X-Studio-Project');if(!id||!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new HttpError(400,'请输入项目ID');return id}
export async function requireRehearsal(request:Request,routeId?:string){const id=routeId??requestProject(request);await authorize(request,id);return id}
export async function listProjects(_admin=false):Promise<never>{throw new HttpError(404,'不提供项目目录')}
export async function enterRehearsal(_request:Request):Promise<Response>{throw new HttpError(404,'请通过指定项目链接加入')}
export async function manageProject(_request:Request):Promise<Response>{throw new HttpError(404,'请通过独立项目接口管理')}
