'use client';
import {ErrorContact} from '@/components/developer-contact';
export default function ErrorPage({reset}:{error:Error & {digest?:string};reset:()=>void}) {
 return <section className="panel rh-pad" role="alert">
  <h1>页面遇到问题</h1>
  <p>当前页面未能正常完成操作。请保留已输入的内容，并尝试重试；不要重复提交尚未确认的上传。</p>
  <ErrorContact />
  <button className="btn" type="button" onClick={()=>reset()}>重试页面</button>
 </section>;
}
