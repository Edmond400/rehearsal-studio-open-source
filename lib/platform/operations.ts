import { env } from 'cloudflare:workers';
import { database } from '../data';
import { HttpError } from '../http';
import { MAX_SITE_FILE_BYTES } from '../rehearsal/model';
import { mediaFileTable } from '../rehearsal/storage';
import { R2_SITE_MEDIA_BUDGET } from '../rehearsal/media-transfer';
import { studioDay, studioDayStart } from './telemetry';

const PAGE_SIZE = 20;
const projectIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const orders = {
  activity: 'lastActivityAt DESC',
  created: 'createdAt DESC',
  storage: 'fileBytes DESC',
};
const visibilityOptions = ['all', 'public', 'unlisted'] as const;
const stateOptions = ['all', 'active', 'archived', 'deleted'] as const;
const anomalyOptions = ['all', 'with', 'without'] as const;

type Options = {
  sort: keyof typeof orders;
  visibility: typeof visibilityOptions[number];
  state: typeof stateOptions[number];
  anomaly: typeof anomalyOptions[number];
  page: number;
};

function option<T extends string>(query: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const value = query.get(key);
  return allowed.find(candidate => value === candidate) ?? fallback;
}

function options(query: URLSearchParams): Options {
  const page = Number(query.get('page') ?? 1);
  return {
    sort: option(query, 'sort', ['activity', 'created', 'storage'], 'activity'),
    visibility: option(query, 'visibility', visibilityOptions, 'all'),
    state: option(query, 'state', stateOptions, 'all'),
    anomaly: option(query, 'anomaly', anomalyOptions, 'all'),
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

const metricsCte = (table:string) => `
WITH media AS (
  SELECT f.project_id, SUM(f.bytes) AS fileBytes, MAX(f.created_at) AS lastFileAt,
    SUM(CASE WHEN f.kind='pptx' THEN 1 ELSE 0 END) AS pptx,
    SUM(CASE WHEN f.kind='audio' THEN 1 ELSE 0 END) AS audio,
    SUM(CASE WHEN f.kind='slide' THEN 1 ELSE 0 END) AS previews
  FROM ${table} f GROUP BY f.project_id
), recording_counts AS (
  SELECT project_id, COUNT(*) AS retainedRecordings, MAX(submitted_at) AS lastRecordingAt
  FROM rehearsal_recordings GROUP BY project_id
), progress AS (
  SELECT project_id, MAX(submitted_at) AS lastProgressAt FROM rehearsal_turn_progress GROUP BY project_id
), uploads AS (
  SELECT project_id, COUNT(*) AS pendingUploads, SUM(CASE WHEN reserved=1 THEN bytes ELSE 0 END) AS reservedBytes,
    SUM(CASE WHEN expires_at<=? THEN 1 ELSE 0 END) AS expiredUploads
  FROM rehearsal_media_uploads GROUP BY project_id
), projects AS (
  SELECT p.id, p.title, p.status,
    CASE WHEN p.deleted_at IS NOT NULL THEN 'deleted' WHEN p.archived_at IS NOT NULL THEN 'archived' ELSE 'active' END AS lifecycle,
    COALESCE(v.visibility, 'unlisted') AS visibility, initial.changed_at AS createdAt,
    NULLIF(MAX(CASE WHEN p.revision>0 THEN p.updated_at ELSE '' END, COALESCE(m.lastFileAt,''),
      COALESCE(r.lastRecordingAt,''), COALESCE(progress.lastProgressAt,''), COALESCE(s.last_at,'')), '') AS lastActivityAt,
    COALESCE(m.fileBytes, 0) AS fileBytes, COALESCE(u.reservedBytes, 0) AS reservedBytes,
    COALESCE(m.pptx, 0) AS pptx, COALESCE(m.audio, 0) AS audio, COALESCE(m.previews, 0) AS previews,
    COALESCE(r.retainedRecordings, 0) AS retainedRecordings,
    COALESCE(u.pendingUploads, 0) AS pendingUploads, COALESCE(u.expiredUploads, 0) AS expiredUploads,
    COALESCE(s.total, 0) AS trackedRecordings
  FROM rehearsal_projects p
  LEFT JOIN rehearsal_versions initial ON initial.project_id=p.id AND initial.revision=0
  LEFT JOIN studio_project_visibility v ON v.project_id=p.id
  LEFT JOIN media m ON m.project_id=p.id LEFT JOIN uploads u ON u.project_id=p.id
  LEFT JOIN recording_counts r ON r.project_id=p.id LEFT JOIN progress ON progress.project_id=p.id
  LEFT JOIN studio_ops_project_recordings s ON s.project_id=p.id
)`;
const filters = ` WHERE (?='all' OR visibility=?) AND (?='all' OR lifecycle=?)
  AND (?='all' OR (?='with' AND expiredUploads>0) OR (?='without' AND expiredUploads=0))`;

export type OperationsProject = {
  id: string; title: string; status: string; lifecycle: string; visibility: string;
  createdAt: string | null; lastActivityAt: string | null; fileBytes: number; reservedBytes: number;
  pptx: number; audio: number; previews: number; retainedRecordings: number;
  pendingUploads: number; expiredUploads: number; trackedRecordings: number;
};

type CountRow = {
  projects: number; cumulativeProjects: number; active: number; public: number; unlisted: number; archived: number; deleted: number;
  unknownCreated: number; createdToday: number; createdWeek: number; activeWeek: number;
  withRecordings: number; retainedRecordings: number; trackedRecordings: number;
  fileBytes: number; reservedBytes: number; pendingUploads: number; expiredUploads: number;
};
type DetailRow = CountRow & {
  startedAt: number; devicesToday: number; devicesWeek: number; sessionsWeek: number;
  pptxWeek: number; recordingsWeek: number; cohort: number; converted: number; quota: number | null;
};
type StorageRow = {
 d1Files:number; d1Bytes:number; r2Files:number; r2Bytes:number; dualFiles:number; r2ReservedBytes:number;
 expiredR2Uploads:number; retiredObjects:number; missingManifests:number; r2UploadFailures:number; r2IntegrityFailures:number;
};
type HealthRow = {kind: string; count: number};
type MediaRow = {kind: 'pptx' | 'audio' | 'slide'; bytes: number};
type BatchRow = DetailRow | HealthRow | MediaRow | OperationsProject | {count: number};

export async function operationsOverview(query: URLSearchParams, now = Date.now()) {
  const db = database();
  const settings = options(query);
  const week = studioDay(now, 6);
  const today = studioDay(now);
  const weekStart = studioDayStart(now, 6);
  const todayStart = studioDayStart(now);
  const values = [now, settings.visibility, settings.visibility, settings.state, settings.state,
    settings.anomaly, settings.anomaly, settings.anomaly] as const;
  // A prior capacity migration may exist. Read its configured limit if present.
  const configurableQuota = !!await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='studio_site_file_usage'"
  ).first();
  const table=await mediaFileTable();
  const metrics=metricsCte(table);
  const storage=table==='studio_media_files'?await db.prepare(`SELECT
   (SELECT count(*) FROM studio_d1_media) AS d1Files,
   (SELECT COALESCE(sum(bytes),0) FROM studio_d1_media) AS d1Bytes,
   (SELECT count(*) FROM studio_r2_media) AS r2Files,
   (SELECT COALESCE(sum(f.bytes),0) FROM studio_r2_media m JOIN studio_media_files f ON f.id=m.file_id) AS r2Bytes,
   (SELECT count(*) FROM studio_r2_media WHERE state='dual') AS dualFiles,
   (SELECT COALESCE(sum(bytes),0) FROM studio_r2_uploads)
    +(SELECT COALESCE(sum(bytes),0) FROM studio_r2_upload_quarantine) AS r2ReservedBytes,
   (SELECT count(*) FROM studio_r2_uploads WHERE status<>'open' OR expires_at<=?)
    +(SELECT count(*) FROM studio_r2_upload_quarantine) AS expiredR2Uploads,
   (SELECT count(*) FROM studio_r2_verified v WHERE NOT EXISTS(SELECT 1 FROM studio_r2_media m WHERE m.object_key=v.object_key)) AS retiredObjects,
   (SELECT count(*) FROM studio_r2_media m WHERE substr(m.object_key,1,10)='studio/e3/'
     AND NOT EXISTS(SELECT 1 FROM studio_r2_verified v WHERE v.object_key=m.object_key)) AS missingManifests,
   (SELECT COALESCE(sum(total),0) FROM studio_r2_upload_failures WHERE day>=?) AS r2UploadFailures,
   (SELECT COALESCE(sum(integrity),0) FROM studio_r2_upload_failures WHERE day>=?) AS r2IntegrityFailures`)
   .bind(now,week,week).first<StorageRow>():null;
  const quota = configurableQuota ? '(SELECT max_bytes FROM studio_site_file_usage LIMIT 1)' : '?';
  const summary = db.prepare(metrics + `
    SELECT COUNT(*) AS projects, (SELECT total_projects FROM studio_ops_start WHERE id=1) AS cumulativeProjects, COUNT(*) FILTER (WHERE lifecycle='active') AS active,
      COUNT(*) FILTER (WHERE lifecycle='active' AND visibility='public') AS public,
      COUNT(*) FILTER (WHERE lifecycle='active' AND visibility='unlisted') AS unlisted,
      COUNT(*) FILTER (WHERE lifecycle='archived') AS archived,
      COUNT(*) FILTER (WHERE lifecycle='deleted') AS deleted,
      COUNT(*) FILTER (WHERE createdAt IS NULL) AS unknownCreated,
      COUNT(*) FILTER (WHERE createdAt>=?) AS createdToday,
      COUNT(*) FILTER (WHERE createdAt>=?) AS createdWeek,
      COUNT(*) FILTER (WHERE lifecycle='active' AND lastActivityAt>=?) AS activeWeek,
      COUNT(*) FILTER (WHERE retainedRecordings>0 OR trackedRecordings>0 OR id IN (SELECT project_id FROM progress)) AS withRecordings,
      COALESCE(SUM(retainedRecordings),0) AS retainedRecordings,
      (SELECT total_recordings FROM studio_ops_start WHERE id=1) AS trackedRecordings,
      COALESCE(SUM(fileBytes),0) AS fileBytes, COALESCE(SUM(reservedBytes),0) AS reservedBytes,
      COALESCE(SUM(pendingUploads),0) AS pendingUploads, COALESCE(SUM(expiredUploads),0) AS expiredUploads,
      (SELECT started_at FROM studio_ops_start WHERE id=1) AS startedAt,
      (SELECT COUNT(DISTINCT device) FROM studio_ops_sessions WHERE day=?) AS devicesToday,
      (SELECT COUNT(DISTINCT device) FROM studio_ops_sessions WHERE day>=?) AS devicesWeek,
      (SELECT COUNT(DISTINCT session) FROM studio_ops_sessions WHERE day>=?) AS sessionsWeek,
      (SELECT COALESCE(SUM(pptx),0) FROM studio_ops_daily WHERE day>=?) AS pptxWeek,
      (SELECT COALESCE(SUM(recordings),0) FROM studio_ops_daily WHERE day>=?) AS recordingsWeek,
      COUNT(*) FILTER (WHERE unixepoch(createdAt)*1000 >= (SELECT started_at FROM studio_ops_start WHERE id=1)) AS cohort,
      COUNT(*) FILTER (WHERE trackedRecordings>0 AND unixepoch(createdAt)*1000 >= (SELECT started_at FROM studio_ops_start WHERE id=1)) AS converted,
      ${quota} AS quota
    FROM projects`).bind(now, todayStart, weekStart, weekStart, today, week, week, week, week,
      ...(configurableQuota ? [] : [MAX_SITE_FILE_BYTES]));
  const [aggregate, media, health, total, projects, ranking] = await db.batch<BatchRow>([
    summary,
    db.prepare(`SELECT kind, SUM(bytes) AS bytes FROM ${table} GROUP BY kind`),
    db.prepare('SELECT kind, SUM(count) AS count FROM studio_ops_health WHERE day>=? GROUP BY kind').bind(week),
    db.prepare(metrics + ' SELECT COUNT(*) AS count FROM projects' + filters).bind(...values),
    db.prepare(metrics + ' SELECT * FROM projects' + filters +
      ` ORDER BY ${orders[settings.sort]}, id LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (settings.page - 1) * PAGE_SIZE),
    db.prepare(metrics + ' SELECT id, title, fileBytes FROM projects WHERE fileBytes>0 ORDER BY fileBytes DESC, id LIMIT 5').bind(now),
  ]);
  const data = aggregate.results[0] as DetailRow;
  if (!data || !Number.isFinite(data.startedAt)) throw new HttpError(503, '运营统计迁移尚未生效。');
  return {
    ...data,
    collectedAt: now,
    storage: storage?{...storage,r2Budget:R2_SITE_MEDIA_BUDGET}:null,
    databaseBytes: aggregate.meta.size_after > 0 ? aggregate.meta.size_after : null,
    telemetryEnabled: env.STUDIO_OPS_TELEMETRY === '1',
    projectsPage: projects.results as OperationsProject[],
    ranking: ranking.results as Pick<OperationsProject, 'id' | 'title' | 'fileBytes'>[],
    media: media.results as MediaRow[],
    health: health.results as HealthRow[],
    filters: settings,
    filteredProjects: (total.results[0] as {count: number}).count,
    pageSize: PAGE_SIZE,
  };
}

export async function operationsProject(id: string, now = Date.now()) {
  if (!projectIdPattern.test(id)) throw new HttpError(404, '汇报不存在。');
  const result = await database().prepare(metricsCte(await mediaFileTable()) + ' SELECT * FROM projects WHERE id=?')
    .bind(now, id).first<OperationsProject>();
  if (!result) throw new HttpError(404, '汇报不存在。');
  return result;
}
