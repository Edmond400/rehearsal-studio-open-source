import {Studio} from '@/components/studio';
export default async function Page({params}:{params:Promise<{id:string}>}){return <Studio initialId={(await params).id}/>}
