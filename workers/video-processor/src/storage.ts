import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { S3Store, hlsPrefix } from '@tesor_gp/storage';
import { MediaError } from './ffmpeg';
import { transcode, type TranscodeDeps, type TranscodeJobData, type TranscodeJobResult } from './transcode';

/**
 * Object-storage job: download the original to a temp folder, transcode it there, upload the result to a new
 * version folder (`hls/<videoId>/<version>/`) and return object keys. The temp folder is always removed, so the
 * small container disk only ever holds one job's files.
 */
export async function transcodeFromStore(store: S3Store, data: TranscodeJobData, deps: TranscodeDeps): Promise<TranscodeJobResult> {
  const head = await store.head(data.inputPath);
  if (!head) throw new MediaError('The uploaded file is missing from storage', true);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `sv-${data.videoId.replace(/[^A-Za-z0-9_-]/g, '')}-`));
  try {
    const input = path.join(work, `source${path.extname(data.inputPath).toLowerCase()}`);
    await store.downloadToFile(data.inputPath, input);
    const out = path.join(work, 'out');
    const result = await transcode({ ...data, inputPath: input, outputDir: out }, deps);
    const prefix = hlsPrefix(data.videoId, `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`);
    // Files in a version folder never change, so any cache may keep them for as long as it likes.
    await store.putDirectory(prefix, out, { cacheControl: () => 'private, max-age=31536000, immutable' });
    return { ...result, manifestPath: `${prefix}master.m3u8`, thumbnailPath: `${prefix}thumbnail.jpg` };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
