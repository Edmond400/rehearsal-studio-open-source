import { env } from 'cloudflare:workers';
import { database } from '../data';
import { HttpError } from '../http';
import type { FileMetadata } from './storage';

type Location = {object_key: string; state: 'dual' | 'r2'};

export async function r2Location(file: FileMetadata) {
  if (env.STUDIO_R2_READS !== 'on') return null;
  return database().prepare('SELECT object_key,state FROM studio_r2_media WHERE file_id=?')
    .bind(file.id).first<Location>();
}

async function matchesObject(file: FileMetadata, location: Location, object: R2Object) {
  if(object.size!==file.bytes)return false;
  if(location.object_key.startsWith('studio/e3/')){
    const manifest=await database().prepare('SELECT etag FROM studio_r2_verified WHERE object_key=? AND bytes=? AND hash=?')
      .bind(location.object_key,file.bytes,file.hash).first<{etag:string}>();
    return !!manifest&&manifest.etag===object.etag;
  }
  const hash = object.checksums.sha256;
  return !!hash && Buffer.from(hash).toString('hex') === file.hash;
}

export async function readR2(
  file: FileMetadata, location: Location, start: number, end: number, head: true
): Promise<R2Object | null>;
export async function readR2(
  file: FileMetadata, location: Location, start: number, end: number, head?: false
): Promise<R2ObjectBody | null>;
export async function readR2(file: FileMetadata, location: Location, start: number, end: number, head = false) {
  try {
    const bucket = env.STUDIO_MEDIA;
    if (!bucket) throw new Error('Private R2 binding unavailable');
    const range = start === 0 && end === file.bytes ? undefined : {offset:start, length:end-start};
    const object = head ? await bucket.head(location.object_key)
      : await bucket.get(location.object_key, range ? {range} : undefined);
    if (!object || !await matchesObject(file, location, object)) {
      if (object && 'body' in object) await (object as R2ObjectBody).body.cancel();
      throw new Error('Media object missing or inconsistent');
    }
    return object;
  } catch {
    console.warn('studio-r2-media-read-failed', location.state);
    if (location.state === 'dual') return null;
    throw new HttpError(503,'媒体暂不可用，请稍后重试。');
  }
}
