import {env} from 'cloudflare:workers';
export function database():D1Database {if(!env.DB)throw new Error('独立汇报数据库尚未配置');return env.DB;}
