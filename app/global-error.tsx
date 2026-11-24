'use client';
export default function GlobalError({reset}:{error:Error & {digest?:string};reset:()=>void}) {
 return <html lang="zh-CN"><body style={{fontFamily:'system-ui,sans-serif',margin:'40px auto',maxWidth:680,padding:'0 20px',lineHeight:1.7}}>
  <main role="alert"><h1>Rehearsal Studio 暂时无法显示</h1>
   <p>请保留本地资料后重试。如问题持续，可联系开发者。</p>
   <p><a href="https://github.com/Edmond400/rehearsal-studio-open-source/issues">反馈与建议</a></p>
   <button type="button" onClick={()=>reset()}>重试</button>
  </main>
 </body></html>;
}
