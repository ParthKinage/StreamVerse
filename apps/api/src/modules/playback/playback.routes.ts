import fs from 'node:fs';
import path from 'node:path';
import { Router, type Response } from 'express';
import { HEARTBEAT_INTERVAL_SEC, SEGMENT_BUDGET_FACTOR, SEGMENT_BUDGET_SLACK_SEC } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, forbidden, notFound, unauthenticated } from '../../middleware/errors';
import { PLAYBACK_COOKIE, signPlaybackToken, verifyPlaybackToken } from './token';

const SEGMENT_EXT = new Set(['.ts', '.m4s', '.aac', '.mp4']);
const ALLOWED_EXT = new Set(['.m3u8', ...SEGMENT_EXT]);
const DEFAULT_SEGMENT_SEC = 4;

export const verifiedKey = (sessionId: string): string => `watch:verified:${sessionId}`;
export const servedKey = (sessionId: string): string => `watch:served:${sessionId}`;
const durKey = (videoId: string): string => `hlsdur:${videoId}`;

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

async function recordDurations(ctx: AppContext, videoId: string, relPlaylist: string, file: string): Promise<void> {
  const text = await fs.promises.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const dir = path.posix.dirname(relPlaylist);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i] ?? '');
    const uri = lines[i + 1];
    if (m && uri && !uri.startsWith('#')) fields[path.posix.normalize(path.posix.join(dir, uri.trim()))] = m[1] as string;
  }
  if (Object.keys(fields).length) await ctx.redis.hset(durKey(videoId), fields);
}

export function playbackRoutes(ctx: AppContext): Router {
  const router = Router();

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
      select: { userId: true, videoId: true, status: true, verifiedDurationSeconds: true },
    });
    if (!session || session.userId !== verdict.claims.uid) throw forbidden('Session not found for this token', 'PLAYBACK_TOKEN_INVALID');
    if (session.status !== 'ACTIVE') throw forbidden('Session is not active', 'SESSION_NOT_ACTIVE');

    const parts = (req.params.splat as unknown as string[]) ?? [];
    const rel = parts.join('/');
    const ext = path.extname(rel).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw notFound();
    const file = ctx.storage.resolveHlsPath(session.videoId, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw notFound();

    if (ext === '.m3u8') {
      void recordDurations(ctx, session.videoId, rel, file).catch(() => undefined);
      res.setHeader('Cache-Control', 'no-store');
      res.type('application/vnd.apple.mpegurl').sendFile(file);
      return;
    }

    // Segment budget: media seconds served may not run far ahead of server-verified watch time.
    const durRaw = await ctx.redis.hget(durKey(session.videoId), path.posix.normalize(rel)).catch(() => null);
    const segmentSec = durRaw ? Number(durRaw) : DEFAULT_SEGMENT_SEC;
    const verifiedRaw = await ctx.redis.get(verifiedKey(sessionId)).catch(() => null);
    const verified = verifiedRaw !== null ? Number(verifiedRaw) : session.verifiedDurationSeconds;
    const served = Number((await ctx.redis.get(servedKey(sessionId)).catch(() => null)) ?? 0);
    const budget = SEGMENT_BUDGET_FACTOR * verified + SEGMENT_BUDGET_SLACK_SEC;
    if (served + segmentSec > budget) {
      res.setHeader('Retry-After', String(HEARTBEAT_INTERVAL_SEC));
      throw new AppError(429, 'SEGMENT_BUDGET_EXCEEDED', 'Playback is ahead of verified watch time; retry after the next heartbeat');
    }
    await ctx.redis.incrbyfloat(servedKey(sessionId), segmentSec).catch(() => undefined);
    await ctx.redis.expire(servedKey(sessionId), 86_400).catch(() => undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.type(ext === '.ts' ? 'video/mp2t' : 'application/octet-stream').sendFile(file);
  });

  return router;
}
