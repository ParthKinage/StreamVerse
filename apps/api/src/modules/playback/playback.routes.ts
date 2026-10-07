import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import { isObjectKey } from '@tesor_gp/storage';
import type { AppContext } from '../../context';
import { AppError, forbidden, notFound, unauthenticated } from '../../middleware/errors';
import { chargeSegment } from '../watch/charges';
import { PlaylistCache, resolveMediaKey } from './playlist';
import { PLAYBACK_COOKIE, signPlaybackToken, verifyPlaybackToken } from './token';

/** A segment file name on the 4-second grid, e.g. "480p/seg_012.ts". The index is the same in every rendition. */
const SEGMENT_RE = /^([A-Za-z0-9_-]+)\/seg_(\d{1,6})\.ts$/;
const DEFAULT_SEGMENT_MS = 4000;
/** The browser follows the redirect at once, so the signed segment URL only has to live briefly. */
const SEGMENT_URL_TTL_SEC = 120;

/** Sets (or renews) the cookie that authorises playback of one session. */
export function setPlaybackCookie(ctx: Pick<AppContext, 'env' | 'now'>, res: Response, sessionId: string, userId: string): void {
  const ttl = ctx.env.PLAYBACK_TOKEN_TTL_SEC;
  const exp = Math.floor(ctx.now().getTime() / 1000) + ttl;
  res.cookie(PLAYBACK_COOKIE, signPlaybackToken({ sid: sessionId, uid: userId, exp }, ctx.env.PLAYBACK_SIGNING_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.env.NODE_ENV === 'production',
    path: `/playback/${sessionId}/`,
    maxAge: ttl * 1000,
  });
}

export const mediaMissing = (): AppError => new AppError(404, 'MEDIA_MISSING', 'The video files are no longer in storage. The creator needs to upload the video again.');

/** Segment durations (ms) by file name, read from a media playlist's #EXTINF lines. */
export function segmentDurations(playlist: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = playlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i] ?? '');
    const uri = lines[i + 1]?.trim();
    if (m && uri && !uri.startsWith('#')) out.set(path.posix.basename(uri), Math.round(Number(m[1]) * 1000));
  }
  return out;
}

/** Where a video's files are, behind one interface: the API's disk (local) or the bucket (s3). */
interface MediaSource {
  readText(rel: string): Promise<string | undefined>;
  sendSegment(rel: string, res: Response): Promise<void>;
}

function mediaSource(ctx: AppContext, cache: PlaylistCache, videoId: string, manifestPath: string | null): MediaSource {
  const s3 = ctx.storage.s3;
  if (s3) {
    if (!manifestPath || !isObjectKey(manifestPath)) throw mediaMissing();
    const keyOf = (rel: string): string => {
      const key = resolveMediaKey(manifestPath, rel);
      if (!key) throw notFound();
      return key;
    };
    return {
      readText: (rel) => cache.get(keyOf(rel), (k) => s3.getText(k)),
      async sendSegment(rel, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, await s3.signedGetUrl(keyOf(rel), SEGMENT_URL_TTL_SEC));
      },
    };
  }
  const fileOf = (rel: string): string => {
    const file = ctx.storage.resolveHlsPath(videoId, rel);
    if (!file) throw notFound();
    return file;
  };
  return {
    readText: (rel) => cache.get(fileOf(rel), (f) => fs.promises.readFile(f, 'utf8').catch(() => undefined)),
    async sendSegment(rel, res) {
      const file = fileOf(rel);
      if (!fs.existsSync(file)) throw notFound();
      res.setHeader('Cache-Control', 'no-store');
      res.type('video/mp2t').sendFile(file);
    },
  };
}

export function playbackRoutes(ctx: AppContext): Router {
  const router = Router();
  const playlists = new PlaylistCache();

  router.get('/playback/:sessionId/*splat', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const token = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${PLAYBACK_COOKIE}=`))
      ?.slice(PLAYBACK_COOKIE.length + 1);
    if (!token) throw unauthenticated('Playback token missing');

    const verdict = verifyPlaybackToken(decodeURIComponent(token), ctx.env.PLAYBACK_SIGNING_SECRET, Math.floor(ctx.now().getTime() / 1000));
    if (!verdict.ok) throw new AppError(401, 'PLAYBACK_TOKEN_INVALID', verdict.reason === 'expired' ? 'Playback token expired' : 'Invalid playback token');
    if (verdict.claims.sid !== sessionId) throw forbidden('This token belongs to another session', 'PLAYBACK_TOKEN_INVALID');

    const session = await ctx.prisma.watchSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, videoId: true, status: true, video: { select: { hlsManifestPath: true } } },
    });
    if (!session || session.userId !== verdict.claims.uid) throw forbidden('Session not found for this token', 'PLAYBACK_TOKEN_INVALID');
    if (session.status !== 'ACTIVE') throw forbidden('Session is not active', 'SESSION_NOT_ACTIVE');

    const rel = path.posix.normalize(((req.params.splat as unknown as string[]) ?? []).join('/'));
    const media = mediaSource(ctx, playlists, session.videoId, session.video.hlsManifestPath);

    if (path.posix.extname(rel).toLowerCase() === '.m3u8') {
      const text = await media.readText(rel);
      if (text === undefined) throw rel === 'master.m3u8' ? mediaMissing() : notFound();
      res.setHeader('Cache-Control', 'no-store');
      res.type('application/vnd.apple.mpegurl').send(text);
      return;
    }

    const seg = SEGMENT_RE.exec(rel);
    if (!seg) throw notFound();
    const playlist = await media.readText(`${seg[1]}/index.m3u8`);
    if (playlist === undefined) throw notFound();
    const durationMs = segmentDurations(playlist).get(path.posix.basename(rel));
    if (durationMs === undefined) throw notFound();

    // Pay for the piece first (once per viewer, ever); only then hand it over.
    await chargeSegment(ctx, sessionId, Number(seg[2]), durationMs || DEFAULT_SEGMENT_MS);
    await media.sendSegment(rel, res);
  });

  return router;
}
