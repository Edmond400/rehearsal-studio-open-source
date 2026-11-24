import './globals.css';
import './v15.css';
import {DeveloperContact} from '@/components/developer-contact';
export const metadata={title:'Rehearsal Studio｜模拟汇报',robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body><header className="studio-header"><a href="/" className="studio-header-brand"><span className="studio-header-logo">R</span> Rehearsal Studio</a><nav><a href="/download">Android 测试版</a> · <a href="/privacy">隐私</a> · <a href="/about">关于</a></nav></header><aside className="rs-contact-banner" aria-label="公测问题反馈"><strong>公测问题反馈</strong><DeveloperContact /></aside><main className="studio-main">{children}</main><footer className="rs-contact-footer"><DeveloperContact /></footer></body></html>}
