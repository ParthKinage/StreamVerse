import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoDto } from '@tesor_gp/shared';
import { isObjectKey } from '@tesor_gp/storage';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../middleware/errors';
import { videoInclude, videoToDto } from '../common';
import { requireCreatorProfile } from './creator.service';

export const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
export const THUMBNAIL_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Custom thumbnails live in their own version folder ("custom-<time>"), so a new one gets a new, cacheable URL. */
const CUSTOM_RE = /(?:^|[\\/])custom-[a-z0-9]+[\\/]thumbnail\.jpg$/;

/** True when the creator chose this picture; processing and live streams then leave it alone. */
export function isCustomThumbnail(thumbnailPath: string | null | undefined): boolean {
  return Boolean(thumbnailPath && CUSTOM_RE.test(thumbnailPath));
}

/**
 * Turns any JPEG, PNG or WebP into a standard JPEG at most 1280 px wide, with FFmpeg run from an argument list (no
 * shell). Re-encoding means only a clean, decoded picture is ever served, whatever the uploaded file contained.
 */
export function toThumbnailJpeg(ffmpegPath: string, input: string, output: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-v', 'error', '-y', '-i', input, '-vf', "scale=w='min(1280,iw)':h=-2", '-frames:v', '1', '-q:v', '3', output], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Converting the image took too long'));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) resolve();
      else reject(new Error('Not a readable image'));
    });
  });
}

/** Sets the creator's own picture as the video's thumbnail (any of their videos, including live streams and recordings). */
export async function setCustomThumbnail(ctx: AppContext, userId: string, videoId: string, uploadedFile: string): Promise<VideoDto> {
  const profile = await requireCreatorProfile(ctx, userId);
  const video = await ctx.prisma.video.findFirst({ where: { id: videoId, creatorId: profile.id, archivedAt: null }, select: { id: true, thumbnailPath: true } });
  if (!video) throw notFound('Video not found');

  const version = `custom-${Date.now().toString(36)}`;
  const converted = path.join(ctx.storage.uploadDir, `${version}-${video.id}.jpg`);
  try {
    await toThumbnailJpeg(ctx.env.FFMPEG_PATH, uploadedFile, converted).catch(() => {
      throw badRequest('UPLOAD_INVALID', 'That file is not a picture we can read. Use a JPEG, PNG or WebP image.');
    });
    let stored: string;
    const s3 = ctx.storage.s3;
    if (s3) {
      stored = `hls/${video.id}/${version}/thumbnail.jpg`;
      await s3.putFile(stored, converted, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
    } else {
      const target = ctx.storage.resolveHlsPath(video.id, path.join(version, 'thumbnail.jpg'));
      if (!target) throw notFound('Video not found');
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(converted, target);
      stored = target;
    }
    const updated = await ctx.prisma.video.update({ where: { id: video.id }, data: { thumbnailPath: stored }, include: videoInclude });
    // The previous custom picture is no longer used.
    if (isCustomThumbnail(video.thumbnailPath) && video.thumbnailPath !== stored) {
      const old = video.thumbnailPath as string;
      await (isObjectKey(old) ? s3?.deleteKey(old) : fs.promises.rm(old, { force: true }))?.catch(() => undefined);
    }
    return videoToDto(updated);
  } finally {
    await fs.promises.rm(converted, { force: true }).catch(() => undefined);
  }
}
