import { env } from 'cloudflare:workers';
import { database } from '../data';
import { cookie, digest, setCookie } from '../security';

const dayMs = 86_400_000;
const offset = 8 * 3_600_000;
const tokenPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const deviceCookie = '__Host-studio_ops_device';
const sessionCookie = '__Host-studio_ops_session';

export function studioDay(now: number, daysAgo = 0) {
  return new Date(now + offset - daysAgo * dayMs).toISOString().slice(0, 10);
}

export function studioDayStart(now: number, daysAgo = 0) {
  return new Date(studioDay(now, daysAgo) + 'T00:00:00+08:00').toISOString();
}

export async function pruneOperationsTelemetry() {
  const db = database();
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM studio_ops_sessions WHERE day < ?').bind(studioDay(now, 29)),
    db.prepare('DELETE FROM studio_ops_daily WHERE day < ?').bind(studioDay(now, 34)),
    db.prepare('DELETE FROM studio_ops_health WHERE day < ?').bind(studioDay(now, 34)),
  ]);
}

type HealthKind = 'upload_failed' | 'integrity' | 'quota' | 'server';

async function logFailure(response: Response, isUpload: boolean, day: string, r2Upload: boolean) {
  const kinds: HealthKind[] = [];
  if (response.status >= 500) kinds.push('server');
  if (isUpload && [400, 409, 413, 415, 422, 429, 500, 503].includes(response.status)) {
    kinds.push('upload_failed');
    if (response.status === 422) kinds.push('integrity');
    if (response.status === 409) {
      // Examine only the fixed failure category. Never write a response body to telemetry.
      const data = await response.json().catch(() => null) as {error?: string} | null;
      if (data?.error?.startsWith('存储容量不足。')) kinds.push('quota');
    }
  }
  if (!kinds.length) return;
  const db = database();
  const statements=kinds.map(kind => db.prepare(
    'INSERT INTO studio_ops_health VALUES (?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET count = count + 1'
  ).bind(day, kind));
  if(r2Upload&&kinds.includes('upload_failed'))statements.push(db.prepare(`INSERT INTO studio_r2_upload_failures VALUES (?,1,?)
    ON CONFLICT(day) DO UPDATE SET total=total+1,integrity=integrity+excluded.integrity`).bind(day,Number(response.status===422)));
  await db.batch(statements);
}

const rehearsalPrefix = /^(?:\/api\/rehearsal|\/api\/projects\/[a-zA-Z0-9_-]+)(\/.*)?$/;
const effectiveUse = /^\/(?:edit(?:\/(?:draft|publish|pptx|slides|preview-page))?|recordings|(?:uploads|r2-uploads)\/[^/]+\/finish|playback\/session)\/?$/;
const upload = /^\/(?:edit\/(?:pptx|slides|preview-page)|recordings|(?:uploads|r2-uploads)(?:\/[^/]+\/(?:\d+|finish))?)\/?$/;

export function observeOperations(request: Request, response: Response, context: ExecutionContext) {
  if (env.STUDIO_OPS_TELEMETRY !== '1') return response;
  const url = new URL(request.url);
  const match = rehearsalPrefix.exec(url.pathname);
  const path = match?.[1] ?? '';
  const day = studioDay(Date.now());
  if (response.status >= 400 && (match || url.pathname.startsWith('/api/projects'))) {
    const uploadFailure = request.method === 'POST' && upload.test(path);
    if (uploadFailure || response.status >= 500) {
      context.waitUntil(logFailure(response.clone(), uploadFailure, day, uploadFailure&&path.startsWith('/r2-uploads')&&env.STUDIO_R2_WRITES==='on').catch(() => console.warn('studio-ops-health-write-failed')));
    }
    return response;
  }
  const creation = url.pathname === '/api/projects' && response.status === 201;
  if (request.method !== 'POST' || (!creation && (!response.ok || !effectiveUse.test(path)))) return response;
  if (request.headers.get('Origin') !== url.origin || request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1') return response;

  const priorDevice = cookie(request, deviceCookie);
  const priorSession = cookie(request, sessionCookie);
  const device = tokenPattern.test(priorDevice) ? priorDevice : crypto.randomUUID();
  const session = tokenPattern.test(priorSession) ? priorSession : crypto.randomUUID();
  context.waitUntil((async () => {
    await database().prepare('INSERT OR IGNORE INTO studio_ops_sessions VALUES (?, ?, ?)')
      .bind(day, digest(device + ':' + session), digest(device)).run();
  })().catch(() => console.warn('studio-ops-session-write-failed')));

  const tracked = new Response(response.body, response);
  if (device !== priorDevice) tracked.headers.append('Set-Cookie', setCookie(deviceCookie, device, 30 * 86400));
  tracked.headers.append('Set-Cookie', setCookie(sessionCookie, session, 1800));
  return tracked;
}
