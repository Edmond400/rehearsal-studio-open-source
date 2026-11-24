import { HttpError } from '../http';
import { platformAdmin } from './access';
import { operationsOverview, operationsProject, type OperationsProject } from './operations';

const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const styles = `
:root{color-scheme:light;font:16px system-ui,sans-serif;color:#19242b;background:#f3f6f7}
*{box-sizing:border-box}body{margin:0}main{max-width:1060px;margin:auto;padding:clamp(16px,4vw,48px)}
header{border-bottom:1px solid #c6d6db;padding-bottom:16px}h1{font-size:clamp(28px,5vw,46px);margin:10px 0}
h2{font-size:20px;margin:0 0 12px}p{line-height:1.55;margin:8px 0}a{color:#13505e}
small,.muted{color:#4d6067}.panel{background:#fff;border:1px solid #c6d6db;border-radius:14px;padding:clamp(14px,3vw,24px);margin-top:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:10px}
.card{padding:12px;background:#edf5f5;border-radius:8px}.card span{display:block;font-size:14px;color:#425960}
.card strong{display:block;margin-top:4px;font-size:22px;overflow-wrap:anywhere}
form,nav{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:12px 0}
label{display:grid;gap:5px;font-size:14px}select,button{font:inherit;min-height:44px;border:1px solid #7d959b;border-radius:6px;background:#fff;padding:6px 10px}
button{background:#13505e;color:#fff;border-color:#13505e;cursor:pointer}a:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid #1b7f97;outline-offset:3px}
ul{margin:0;padding:0;list-style:none}.project-list li,.rank li{border-top:1px solid #e0e8ea;padding:12px 0}
.project-list a{font-weight:650;display:inline-block;max-width:100%;overflow-wrap:anywhere}.project-list p{font-size:14px;margin:4px 0 0}
.rank li{display:flex;justify-content:space-between;gap:10px}.rank a,code{overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:10px;margin:12px 0}dd{margin:0;overflow-wrap:anywhere}
`;
const states: Record<string, string> = { active: '有效', archived: '已归档', deleted: '已删除', draft: '草稿', published: '已发布', ended: '已结束' };
const visibility: Record<string, string> = { public: '公开', unlisted: '非公开' };
const html = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] ?? char));
const number = (value: number) => value.toLocaleString('zh-CN');
const bytes = (value: number | null) => value === null ? '暂不可用' : (value / 1048576).toFixed(2) + ' MiB';
const date = (value: string | number | null) => value === null ? '暂无记录' :
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const link = (id: string) => '/admin?project=' + encodeURIComponent(id);

function cards(items: [string, string | number][]) {
  return '<div class="cards">' + items.map(([label, value]) =>
    `<div class="card"><span>${html(label)}</span><strong>${html(typeof value === 'number' ? number(value) : value)}</strong></div>`).join('') + '</div>';
}

function page(title: string, content: string, status = 200) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${html(title)} · Rehearsal Studio</title><style>${styles}</style><body><main>
    <header><a href="/">Rehearsal Studio</a><h1>${html(title)}</h1></header>${content}</main></body></html>`, {
    status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function select(label: string, key: string, selected: string, values: [string, string][]) {
  return `<label>${html(label)}<select name="${key}">` + values.map(([value, text]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${html(text)}</option>`).join('') + '</select></label>';
}

async function dashboard(query: URLSearchParams) {
  const data = await operationsOverview(query);
  const { filters } = data;
  const stored = (kind: string) => bytes(data.media.find(media => media.kind === kind)?.bytes ?? 0);
  const health = (kind: string) => data.telemetryEnabled ? number(data.health.find(row => row.kind === kind)?.count ?? 0) : '暂未启用';
  const anonymous = (value: number) => data.telemetryEnabled ? number(value) : '暂未启用';
  const pages = Math.max(1, Math.ceil(data.filteredProjects / data.pageSize));
  const pagination = (pageNumber: number, label: string) => {
    const params = new URLSearchParams({sort:filters.sort, visibility:filters.visibility, state:filters.state,
      anomaly:filters.anomaly, page:String(pageNumber)});
    return `<a href="/admin?${html(params.toString())}">${label}</a>`;
  };
  return page('运营监测中心', `
    <p class="muted">V0.1 · 数据更新于 ${html(date(data.collectedAt))}（北京时间）</p>
    <section class="panel"><h2>运营概览</h2>${cards([
      ['累计项目（可核实）',data.cumulativeProjects],['当前在库项目',data.projects],['有效项目',data.active],['有效公开项目',data.public],['有效非公开项目',data.unlisted],
      ['归档项目',data.archived],['今日新增',data.createdToday],['近 7 天新增',data.createdWeek],['近 7 天活跃项目',data.activeWeek],
      ['有录音提交记录的项目',data.withRecordings],['当前保留录音',data.retainedRecordings],
      ['采集以来录音提交',data.trackedRecordings],['近 7 天录音提交',data.recordingsWeek],
    ])}<p class="muted">活跃依据已保存的编辑、媒体提交或录音。累计项目以启用时在库项目为起点。录音累计从 ${html(date(data.startedAt))} 起采集，历史提交数不完整。
      ${data.unknownCreated ? `有 ${number(data.unknownCreated)} 个项目缺少可确认的创建时间。` : ''}</p></section>
    <section class="panel"><h2>使用情况</h2>${cards([
      ['今日匿名设备估计',anonymous(data.devicesToday)],['近 7 天匿名设备估计',anonymous(data.devicesWeek)],
      ['近 7 天有效会话',anonymous(data.sessionsWeek)],['近 7 天成功上传 PPTX',data.pptxWeek],
      ['创建后首次提交录音',data.cohort ? `${Math.round(100 * data.converted / data.cohort)}%（${number(data.converted)}/${number(data.cohort)}）` : '暂无样本'],
    ])}<p class="muted">匿名设备按启用统计后浏览器中的第一方标识估算。连续使用的间隔小于 30 分钟计为同一会话。当前设备口径覆盖同源网页，独立 APK 不计入。
      转化样本为采集启用后创建且仍在库的项目。</p></section>
    <section class="panel"><h2>媒体与存储</h2>${cards([
      ['逻辑媒体占用',bytes(data.fileBytes)],['当前逻辑配额',bytes(data.quota)],['上传预留容量',bytes(data.reservedBytes)],
      ['D1 物理占用',bytes(data.databaseBytes)],['PPTX',stored('pptx')],['录音',stored('audio')],['预览文件',stored('slide')],
    ])}${data.storage?cards([
      ['D1 媒体副本',bytes(data.storage.d1Bytes)],['D1 媒体文件',data.storage.d1Files],
      ['R2 媒体副本',bytes(data.storage.r2Bytes)],['R2 媒体文件',data.storage.r2Files],['D1/R2 双副本文件',data.storage.dualFiles],
      ['R2 逻辑预算',bytes(data.storage.r2Budget)],['R2 上传预留',bytes(data.storage.r2ReservedBytes)],
      ['R2 到期或取消上传',data.storage.expiredR2Uploads],['R2 已退役对象待核查',data.storage.retiredObjects],
      ['R2 缺少校验记录',data.storage.missingManifests],
      ['近 7 天 R2 上传失败',data.telemetryEnabled?data.storage.r2UploadFailures:'暂未启用'],
      ['近 7 天 R2 完整性失败',data.telemetryEnabled?data.storage.r2IntegrityFailures:'暂未启用']
    ])+'<p class="muted">逻辑媒体总量按平台文件去重。双副本会分别计入 D1 与 R2。R2 数值来自 D1 索引和预留，实际存储与计费以 Cloudflare 为准。</p>':''}${data.ranking.length ? '<h3>项目占用排行</h3><ul class="rank">' + data.ranking.map(project =>
      `<li><a href="${link(project.id)}">${html(project.title)}</a><span>${bytes(project.fileBytes)}</span></li>`).join('') + '</ul>' : ''}</section>
    <section class="panel"><h2>平台健康</h2>${cards([
      ['近 7 天上传失败',health('upload_failed')],['近 7 天文件校验失败',health('integrity')],
      ['近 7 天配额不足',health('quota')],['近 7 天 API 服务端错误',health('server')],
      ['未完成上传',data.pendingUploads],['已过期未清理',data.expiredUploads],
    ])}<p class="muted">统计查询正常。上传失败按服务端收到的失败请求计数，包含重试。浏览器断网和未到达服务端的请求不计入。</p></section>
    <section class="panel"><h2>全部项目</h2>
      <form action="/admin" method="get">
        ${select('排序','sort',filters.sort,[['activity','最近活动'],['created','最近创建'],['storage','媒体占用']])}
        ${select('可见性','visibility',filters.visibility,[['all','全部'],['public','公开'],['unlisted','非公开']])}
        ${select('项目状态','state',filters.state,[['all','全部'],['active','有效'],['archived','归档'],['deleted','已删除']])}
        ${select('过期上传','anomaly',filters.anomaly,[['all','全部'],['with','有'],['without','无']])}
        <button>筛选</button>
      </form>
      <p class="muted">符合条件 ${number(data.filteredProjects)} 个 · 第 ${number(filters.page)} / ${number(pages)} 页</p>
      <ul class="project-list">${data.projectsPage.map(project => `<li>
        <a href="${link(project.id)}">${html(project.title)}</a>
        <p>${html(visibility[project.visibility] ?? project.visibility)} · ${html(states[project.lifecycle] ?? project.lifecycle)} · ${bytes(project.fileBytes)}
        · 最近活动 ${html(date(project.lastActivityAt))}</p></li>`).join('')}</ul>
      ${data.projectsPage.length === 0 ? '<p>本页没有项目。</p>' : ''}
      <nav aria-label="项目分页">${filters.page > 1 ? pagination(filters.page - 1,'上一页') : ''}
      ${filters.page < pages ? pagination(filters.page + 1,'下一页') : ''}</nav>
    </section>`);
}

function projectPage(project: OperationsProject) {
  const fields: [string, string | number][] = [
    ['项目标识',project.id],['创建时间',date(project.createdAt)],['最近有效活动',date(project.lastActivityAt)],
    ['可见性',visibility[project.visibility] ?? project.visibility],['项目状态',states[project.lifecycle] ?? project.lifecycle],
    ['发布状态',states[project.status] ?? project.status],['PPTX',project.pptx],['预览文件',project.previews],
    ['音频文件',project.audio],['当前保留录音',project.retainedRecordings],['逻辑媒体占用',bytes(project.fileBytes)],
    ['上传预留容量',bytes(project.reservedBytes)],['存储后端','D1'],['未完成上传',project.pendingUploads],
    ['已过期未清理',project.expiredUploads],
  ];
  return page(project.title, `<p><a href="/admin">返回运营监测中心</a></p><section class="panel"><h2>项目详情</h2><dl>` +
    fields.map(([label,value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join('') + '</dl></section>');
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers });
}

export function isOperationsPath(path: string) {
  return ['/admin', '/api/admin', '/platform-admin', '/api/platform-admin']
    .some(root => path === root || path.startsWith(root + '/'));
}

export async function handleOperations(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const api = path.startsWith('/api/');
  try {
    await platformAdmin(request);
    if (request.method !== 'GET') throw new HttpError(405, '运营监测仅支持读取。');
    if (path === '/admin') {
      const id = url.searchParams.get('project');
      return id === null ? await dashboard(url.searchParams) : projectPage(await operationsProject(id));
    }
    if (path === '/api/admin') return json(await operationsOverview(url.searchParams));
    const detail = /^\/api\/admin\/projects\/([a-zA-Z0-9_-]{1,80})$/.exec(path);
    if (detail) return json(await operationsProject(detail[1]));
    throw new HttpError(404, '页面不存在。');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 503;
    const message = error instanceof HttpError ? error.message : '运营数据暂不可用。';
    return api ? json({error:message}, status) : page('运营监测中心', '<p>' + html(message) + '</p>', status);
  }
}
