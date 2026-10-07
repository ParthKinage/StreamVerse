import fs from 'node:fs';
import path from 'node:path';
import { contentTypeFor } from '@tesor_gp/storage';
import type { AppContext } from '../../context';
import { notFound } from '../../middleware/errors';

/**
 * Where a live stream's files go. They sit in a "live" folder of the stream's video, next to where a transcode would put
 * its versions:  hls/<videoId>/live/master.m3u8, hls/<videoId>/live/src/{init_N.mp4, seg_NNNNNN.m4s, index.m3u8}
 * (object storage) or the same layout under HLS_OUTPUT_DIR (local disk).
 */
export const LIVE_DIR = 'live';
export const LIVE_RENDITION = 'src';

export function liveManifestPath(ctx: AppContext, videoId: string): string {
  if (ctx.storage.s3) return `hls/${videoId}/${LIVE_DIR}/master.m3u8`;
  const file = ctx.storage.resolveHlsPath(videoId, path.join(LIVE_DIR, 'master.m3u8'));
  if (!file) throw notFound('Video not found');
  return file;
}

/** Relative path of a file inside the live folder ("src/seg_000001.m4s", "thumbnail.jpg", "master.m3u8"). */
export function liveRel(name: string): string {
  return name === 'thumbnail.jpg' || name === 'master.m3u8' ? name : `${LIVE_RENDITION}/${name}`;
}

export function liveKey(videoId: string, rel: string): string {
  return `hls/${videoId}/${LIVE_DIR}/${rel}`;
}

function localFile(ctx: AppContext, videoId: string, rel: string): string {
  const file = ctx.storage.resolveHlsPath(videoId, path.join(LIVE_DIR, ...rel.split('/')));
  if (!file) throw notFound('Video not found');
  return file;
}

/** Path (local) or key (object storage) to store in the video row, e.g. for the thumbnail. */
export function liveStoredPath(ctx: AppContext, videoId: string, rel: string): string {
  return ctx.storage.s3 ? liveKey(videoId, rel) : localFile(ctx, videoId, rel);
}

export async function writeLiveFile(ctx: AppContext, videoId: string, rel: string, body: Uint8Array | string, cacheControl?: string): Promise<void> {
  if (ctx.storage.s3) {
    await ctx.storage.s3.putBytes(liveKey(videoId, rel), body, { contentType: contentTypeFor(rel), ...(cacheControl ? { cacheControl } : {}) });
    return;
  }
  const file = localFile(ctx, videoId, rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, body);
}

export interface PlaylistSegment {
  index: number;
  initSeq: number;
  durationMs: number;
}

export interface StreamInfo {
  codecs: string | null;
  width: number | null;
  height: number | null;
  bandwidth: number | null;
}

export function masterPlaylist(info: StreamInfo): string {
  const attrs = [`BANDWIDTH=${info.bandwidth ?? 2_500_000}`];
  if (info.width && info.height) attrs.push(`RESOLUTION=${info.width}x${info.height}`);
  if (info.codecs) attrs.push(`CODECS="${info.codecs}"`);
  return ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-STREAM-INF:${attrs.join(',')}`, `${LIVE_RENDITION}/index.m3u8`, ''].join('\n');
}

/**
 * The media playlist. While live it has no end tag, so players keep reloading it and start near the newest piece; the
 * final version is a normal video playlist. A new init piece (the creator reconnected) is announced with a
 * discontinuity, because its timestamps start again from zero.
 */
export function mediaPlaylist(segments: PlaylistSegment[], final: boolean): string {
  const target = Math.max(1, ...segments.map((s) => Math.ceil(s.durationMs / 1000)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.index ?? 0}`];
  lines.push(final ? '#EXT-X-PLAYLIST-TYPE:VOD' : '#EXT-X-PLAYLIST-TYPE:EVENT');
  let run: number | undefined;
  for (const s of segments) {
    if (s.initSeq !== run) {
      if (run !== undefined) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXT-X-MAP:URI="init_${s.initSeq}.mp4"`);
      run = s.initSeq;
    }
    lines.push(`#EXTINF:${(s.durationMs / 1000).toFixed(3)},`, `seg_${String(s.index).padStart(6, '0')}.m4s`);
  }
  if (final) lines.push('#EXT-X-ENDLIST');
  lines.push('');
  return lines.join('\n');
}
