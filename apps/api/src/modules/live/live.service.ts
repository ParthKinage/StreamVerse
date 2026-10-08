import {
  DEFAULT_LIVE_PRICE_STRM,
  DOMAIN_EVENTS,
  LIVE_SEGMENT_MAX_BYTES,
  splitFee,
  weiToString,
  type CommitLiveSegmentRequest,
  type CreateLiveRequest,
  type LiveStatus,
  type LiveStreamDto,
  type LiveUploadUrlsResponse,
  type StartLiveRequest,
  type VideoDto,
} from '@tesor_gp/shared';
import { contentTypeFor } from '@tesor_gp/storage';
import type { Prisma } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { AppError, conflict, forbidden, notFound } from '../../middleware/errors';
import { fromWei, toWei, videoInclude } from '../common';
import { decorateVideos } from '../catalog';
import { requireCreatorProfile } from '../creator/creator.service';
import { validateAccessPriceWei } from '../purchase/purchase.service';
import { getFeeBps } from '../settlement';
import { assertTransition, FINISHED_STATES, SENDING_STATES } from './lifecycle';
import { liveManifestPath, liveRel, liveStoredPath, masterPlaylist, mediaPlaylist, writeLiveFile, type PlaylistSegment } from './media';

type Tx = Prisma.TransactionClient;
type StreamRow = Prisma.LiveStreamGetPayload<{ include: { video: { select: { title: true; accessPriceSTRM: true } } } }>;

/** Slack allowed between the pieces' total length and the wall-clock time since the stream started. */
const CLOCK_SLACK_MS = 30_000;
const UPLOAD_URL_TTL_SEC = 600;

async function lockStream(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "LiveStream" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw notFound('Stream not found');
}

/** The stream, if the signed-in user owns it. */
async function ownStream(ctx: AppContext, userId: string, id: string): Promise<StreamRow> {
  const profile = await requireCreatorProfile(ctx, userId);
  const stream = await ctx.prisma.liveStream.findUnique({ where: { id }, include: { video: { select: { title: true, accessPriceSTRM: true } } } });
  if (!stream) throw notFound('Stream not found');
  if (stream.creatorId !== profile.id) throw forbidden('This is not your stream');
  return stream;
}

/** Viewers whose player is still sending heartbeats. */
export async function viewerCount(ctx: AppContext, videoId: string): Promise<number> {
  const since = new Date(ctx.now().getTime() - ctx.env.SESSION_TIMEOUT_SEC * 1000);
  return ctx.prisma.watchSession.count({ where: { videoId, status: 'ACTIVE', lastHeartbeatAt: { gte: since } } });
}

async function toDto(ctx: AppContext, s: StreamRow): Promise<LiveStreamDto> {
  const [viewers, totals, last, sold, feeBps] = await Promise.all([
    viewerCount(ctx, s.videoId),
    ctx.prisma.liveSegment.aggregate({ where: { liveStreamId: s.id }, _sum: { durationMs: true } }),
    ctx.prisma.liveSegment.findFirst({ where: { liveStreamId: s.id }, orderBy: { index: 'desc' }, select: { index: true } }),
    ctx.prisma.videoPurchase.aggregate({ where: { videoId: s.videoId }, _sum: { amountSTRM: true }, _count: { _all: true } }),
    getFeeBps(ctx),
  ]);
  const gross = sold._sum.amountSTRM ? toWei(sold._sum.amountSTRM) : 0n;
  const peak = Math.max(s.peakViewers, viewers);
  if (peak > s.peakViewers) await ctx.prisma.liveStream.update({ where: { id: s.id }, data: { peakViewers: peak } });
  return {
    id: s.id,
    videoId: s.videoId,
    status: s.status,
    title: s.video.title,
    priceWei: weiToString(s.video.accessPriceSTRM ? toWei(s.video.accessPriceSTRM) : 0n),
    buyers: sold._count._all,
    saveAsVod: s.saveAsVod,
    createdAt: s.createdAt.toISOString(),
    startedAt: s.startedAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    endReason: s.endReason,
    viewers,
    peakViewers: peak,
    durationSeconds: Math.floor((totals._sum.durationMs ?? 0) / 1000),
    earnedWei: weiToString(splitFee(gross, feeBps).creator),
    initSeq: s.initSeq,
    nextIndex: last ? last.index + 1 : 0,
  };
}

export async function createStream(ctx: AppContext, userId: string, input: CreateLiveRequest): Promise<LiveStreamDto> {
  const profile = await requireCreatorProfile(ctx, userId);
  const price = validateAccessPriceWei(input.priceWei, DEFAULT_LIVE_PRICE_STRM);
  const stream = await ctx.prisma.$transaction(async (tx) => {
    // The video row holds what viewers see and pay for; it stays out of the catalog (PROCESSING) until the stream ends.
    const video = await tx.video.create({
      data: {
        title: input.title,
        description: input.description ?? '',
        category: input.category ?? 'General',
        tags: input.tags ?? [],
        creatorId: profile.id,
        originalFilePath: '',
        // Sold by one price for permanent access; the rate per minute does not apply.
        ratePerMinuteSTRM: '0',
        accessPriceSTRM: fromWei(price),
        processingStatus: 'PROCESSING',
      },
    });
    await tx.video.update({ where: { id: video.id }, data: { hlsManifestPath: liveManifestPath(ctx, video.id) } });
    return tx.liveStream.create({
      data: { creatorId: profile.id, videoId: video.id, saveAsVod: input.saveAsVod ?? true },
      include: { video: { select: { title: true, accessPriceSTRM: true } } },
    });
  });
  ctx.events.emit(DOMAIN_EVENTS.STREAM_CREATED, { streamId: stream.id, videoId: stream.videoId });
  return toDto(ctx, stream);
}

export async function getOwnStream(ctx: AppContext, userId: string, id: string): Promise<LiveStreamDto> {
  return toDto(ctx, await ownStream(ctx, userId, id));
}

export async function listOwnStreams(ctx: AppContext, userId: string): Promise<{ items: LiveStreamDto[] }> {
  const profile = await requireCreatorProfile(ctx, userId);
  const rows = await ctx.prisma.liveStream.findMany({
    where: { creatorId: profile.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { video: { select: { title: true, accessPriceSTRM: true } } },
  });
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))) };
}

/**
 * The browser is about to send (again). Each call starts a new run with its own init piece, so a creator who reloads
 * the page or switches camera carries on in the same stream.
 */
export async function startSending(ctx: AppContext, userId: string, id: string, info: StartLiveRequest): Promise<LiveStreamDto> {
  await ownStream(ctx, userId, id);
  const row = await ctx.prisma.$transaction(async (tx) => {
    await lockStream(tx, id);
    const s = await tx.liveStream.findUniqueOrThrow({ where: { id } });
    const to: LiveStatus = s.status === 'LIVE' ? 'LIVE' : 'STARTING';
    assertTransition(s.status, to);
    const used = await tx.liveSegment.count({ where: { liveStreamId: id, initSeq: s.initSeq } });
    return tx.liveStream.update({
      where: { id },
      data: {
        status: to,
        // A run that never sent a piece keeps its number, so the numbers in the playlist stay dense.
        initSeq: s.status === 'CREATED' || used === 0 ? s.initSeq : s.initSeq + 1,
        codecs: info.codecs,
        width: info.width,
        height: info.height,
        bandwidth: info.bandwidth,
        startedAt: s.startedAt ?? ctx.now(),
        lastPieceAt: ctx.now(),
      },
      include: { video: { select: { title: true, accessPriceSTRM: true } } },
    });
  });
  return toDto(ctx, row);
}

/** Signed URLs (object storage) or API URLs (local disk) to PUT the stream's files to. */
export async function uploadUrls(ctx: AppContext, userId: string, id: string, names: string[]): Promise<LiveUploadUrlsResponse> {
  const s = await ownStream(ctx, userId, id);
  if (!SENDING_STATES.includes(s.status)) throw conflict('LIVE_NOT_ACTIVE', 'This stream is not sending');
  const expiresAt = new Date(ctx.now().getTime() + UPLOAD_URL_TTL_SEC * 1000).toISOString();
  const s3 = ctx.storage.s3;
  const items = await Promise.all(
    names.map(async (name) => {
      const contentType = contentTypeFor(name);
      if (s3) {
        const url = await s3.signedPutUrl(liveStoredPath(ctx, s.videoId, liveRel(name)), contentType, UPLOAD_URL_TTL_SEC);
        return { name, url, method: 'PUT' as const, headers: { 'Content-Type': contentType }, viaApi: false };
      }
      return { name, url: `/creator/live/${id}/files/${name}`, method: 'PUT' as const, headers: { 'Content-Type': contentType }, viaApi: true };
    }),
  );
  return { items, expiresAt };
}

/** Local disk only: the API receives the file itself. */
export async function storeFile(ctx: AppContext, userId: string, id: string, name: string, body: Buffer): Promise<void> {
  if (ctx.storage.s3) throw conflict('NOT_AVAILABLE_IN_THIS_MODE', 'Upload the file to the signed URL instead');
  const s = await ownStream(ctx, userId, id);
  if (!SENDING_STATES.includes(s.status)) throw conflict('LIVE_NOT_ACTIVE', 'This stream is not sending');
  if (!body.length || body.length > LIVE_SEGMENT_MAX_BYTES) throw new AppError(413, 'UPLOAD_TOO_LARGE', 'The piece is empty or too large');
  await writeLiveFile(ctx, s.videoId, liveRel(name), body);
}

/**
 * A piece has been uploaded: add it to the playlist. Pieces must arrive in order, belong to the current run, and their
 * total length may not run ahead of the clock (so a sender cannot bill viewers for time that has not passed).
 */
export async function commitSegment(ctx: AppContext, userId: string, id: string, input: CommitLiveSegmentRequest): Promise<{ status: LiveStatus; nextIndex: number }> {
  await ownStream(ctx, userId, id);
  const result = await ctx.prisma.$transaction(async (tx) => {
    await lockStream(tx, id);
    const s = await tx.liveStream.findUniqueOrThrow({ where: { id } });
    if (!SENDING_STATES.includes(s.status)) throw conflict('LIVE_NOT_ACTIVE', 'This stream is not sending');
    if (input.initSeq !== s.initSeq) throw conflict('LIVE_SEGMENT_INVALID', 'This piece belongs to an earlier connection', { initSeq: s.initSeq });

    const existing = await tx.liveSegment.findUnique({ where: { liveStreamId_index: { liveStreamId: id, index: input.index } } });
    if (existing) {
      // A retried request: fine if it is the same piece.
      if (existing.initSeq === input.initSeq && existing.durationMs === input.durationMs) return { status: s.status, nextIndex: input.index + 1, first: false };
      throw conflict('LIVE_SEGMENT_INVALID', 'A different piece already has this number');
    }
    const last = await tx.liveSegment.findFirst({ where: { liveStreamId: id }, orderBy: { index: 'desc' }, select: { index: true } });
    if (last && input.index <= last.index) throw conflict('LIVE_SEGMENT_INVALID', 'Pieces must be sent in order', { nextIndex: last.index + 1 });

    const sent = await tx.liveSegment.aggregate({ where: { liveStreamId: id }, _sum: { durationMs: true } });
    const elapsed = ctx.now().getTime() - (s.startedAt ?? ctx.now()).getTime();
    if ((sent._sum.durationMs ?? 0) + input.durationMs > elapsed + CLOCK_SLACK_MS) {
      throw conflict('LIVE_SEGMENT_INVALID', 'The pieces add up to more time than has passed since the stream started');
    }

    await tx.liveSegment.create({ data: { liveStreamId: id, index: input.index, initSeq: input.initSeq, durationMs: input.durationMs } });
    const to: LiveStatus = 'LIVE';
    assertTransition(s.status, to);
    await tx.liveStream.update({ where: { id }, data: { status: to, lastPieceAt: ctx.now() } });
    return { status: to, nextIndex: input.index + 1, first: s.status !== 'LIVE' };
  });
  if (result.first) {
    const s = await ctx.prisma.liveStream.findUniqueOrThrow({ where: { id }, select: { videoId: true } });
    ctx.events.emit(DOMAIN_EVENTS.STREAM_STARTED, { streamId: id, videoId: s.videoId });
  }
  return { status: result.status, nextIndex: result.nextIndex };
}

/** The thumbnail has been uploaded: show it on the stream's card. */
export async function setThumbnail(ctx: AppContext, userId: string, id: string): Promise<void> {
  const s = await ownStream(ctx, userId, id);
  const stored = liveStoredPath(ctx, s.videoId, liveRel('thumbnail.jpg'));
  if (!(await ctx.storage.exists(stored))) throw new AppError(400, 'UPLOAD_NOT_FOUND', 'The thumbnail has not arrived yet');
  await ctx.prisma.video.update({ where: { id: s.videoId }, data: { thumbnailPath: stored } });
}

async function playlistSegments(ctx: AppContext, streamId: string): Promise<PlaylistSegment[]> {
  return ctx.prisma.liveSegment.findMany({ where: { liveStreamId: streamId }, orderBy: { index: 'asc' }, select: { index: true, initSeq: true, durationMs: true } });
}

/**
 * Ends a stream: ENDING, then the recording is written as a normal video (or dropped), then ENDED. Safe to call twice.
 * A stream that never started is simply cancelled (FAILED).
 */
export async function endStream(ctx: AppContext, id: string, reason: string): Promise<void> {
  const claimed = await ctx.prisma.$transaction(async (tx) => {
    await lockStream(tx, id);
    const s = await tx.liveStream.findUniqueOrThrow({ where: { id } });
    if (FINISHED_STATES.includes(s.status) || s.status === 'ENDING') return null;
    if (s.status === 'CREATED') {
      assertTransition(s.status, 'FAILED');
      await tx.liveStream.update({ where: { id }, data: { status: 'FAILED', endedAt: ctx.now(), endReason: 'CANCELLED' } });
      await tx.video.update({ where: { id: s.videoId }, data: { archivedAt: ctx.now(), isPublished: false } });
      return null;
    }
    assertTransition(s.status, 'ENDING');
    return tx.liveStream.update({ where: { id }, data: { status: 'ENDING', endReason: reason } });
  });
  if (!claimed) return;

  const segments = await playlistSegments(ctx, id);
  const totalMs = segments.reduce((sum, s) => sum + s.durationMs, 0);
  try {
    if (claimed.saveAsVod && segments.length > 0) {
      // Write the final playlists; from now on the video plays like any uploaded one.
      await writeLiveFile(ctx, claimed.videoId, liveRel('index.m3u8'), mediaPlaylist(segments, true));
      await writeLiveFile(ctx, claimed.videoId, 'master.m3u8', masterPlaylist(claimed));
      await ctx.prisma.$transaction([
        ctx.prisma.video.update({
          where: { id: claimed.videoId },
          data: { processingStatus: 'COMPLETED', transcodeProgress: 100, durationSeconds: Math.round(totalMs / 1000), isPublished: true },
        }),
        ctx.prisma.liveStream.update({ where: { id }, data: { status: 'ENDED', endedAt: ctx.now() } }),
      ]);
    } else {
      await ctx.prisma.$transaction([
        ctx.prisma.video.update({ where: { id: claimed.videoId }, data: { archivedAt: ctx.now(), isPublished: false, durationSeconds: Math.round(totalMs / 1000) } }),
        ctx.prisma.liveStream.update({ where: { id }, data: { status: 'ENDED', endedAt: ctx.now() } }),
      ]);
      // Pieces viewers already paid for stay paid; nothing will play them again, so the files can go.
      await ctx.storage.deleteVideoMedia(claimed.videoId).catch((err) => ctx.logger.warn({ err: (err as Error).message, streamId: id }, 'could not delete live files'));
    }
  } catch (err) {
    ctx.logger.error({ err: (err as Error).message, streamId: id }, 'saving the live recording failed');
    await ctx.prisma.$transaction([
      ctx.prisma.liveStream.update({ where: { id }, data: { status: 'FAILED', endedAt: ctx.now(), endReason: 'SAVE_FAILED' } }),
      ctx.prisma.video.update({ where: { id: claimed.videoId }, data: { archivedAt: ctx.now(), isPublished: false } }),
    ]);
  }
  ctx.events.emit(DOMAIN_EVENTS.STREAM_ENDED, { streamId: id, videoId: claimed.videoId, reason });
}

export async function endOwnStream(ctx: AppContext, userId: string, id: string): Promise<LiveStreamDto> {
  await ownStream(ctx, userId, id);
  await endStream(ctx, id, 'ENDED_BY_CREATOR');
  return getOwnStream(ctx, userId, id);
}

/** Streams that are live now, busiest first. */
export async function listLiveNow(ctx: AppContext, viewerId?: string): Promise<{ items: VideoDto[] }> {
  const rows = await ctx.prisma.video.findMany({
    where: { archivedAt: null, liveStream: { is: { status: 'LIVE' } } },
    include: videoInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const videos = await decorateVideos(ctx, rows, viewerId);
  const counts = await Promise.all(rows.map((r) => viewerCount(ctx, r.id)));
  const items = videos.map((v, i) => ({ ...v, live: v.live ? { ...v.live, viewers: counts[i] ?? 0 } : v.live }));
  items.sort((a, b) => (b.live?.viewers ?? 0) - (a.live?.viewers ?? 0));
  return { items };
}

// ---------- viewer side ----------

export interface LiveMediaInfo {
  id: string;
  status: LiveStatus;
  codecs: string | null;
  width: number | null;
  height: number | null;
  bandwidth: number | null;
}

/** True while the playlist has to be built from the database (the final files are written when the stream ends). */
export function isOnAir(live: { status: LiveStatus } | null | undefined): boolean {
  return Boolean(live) && (live?.status === 'STARTING' || live?.status === 'LIVE' || live?.status === 'ENDING');
}

const playlistMemo = new Map<string, { text: string; until: number }>();

/** The live media playlist, shared by all viewers for one second so many viewers cost one query. */
export async function livePlaylist(ctx: AppContext, live: LiveMediaInfo, rel: string): Promise<string | undefined> {
  if (rel === 'master.m3u8') return masterPlaylist(live);
  if (rel !== 'src/index.m3u8') return undefined;
  const now = ctx.now().getTime();
  const hit = playlistMemo.get(live.id);
  if (hit && hit.until > now) return hit.text;
  const text = mediaPlaylist(await playlistSegments(ctx, live.id), false);
  if (playlistMemo.size > 500) playlistMemo.clear();
  playlistMemo.set(live.id, { text, until: now + 1000 });
  return text;
}

export async function liveSegmentDurationMs(ctx: AppContext, streamId: string, index: number): Promise<number | undefined> {
  const row = await ctx.prisma.liveSegment.findUnique({ where: { liveStreamId_index: { liveStreamId: streamId, index } }, select: { durationMs: true } });
  return row?.durationMs;
}

// ---------- housekeeping ----------

/** Ends streams whose sender went quiet (closed tab, lost network). Their recording is kept as usual. */
export async function reapIdleStreams(ctx: AppContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.env.LIVE_IDLE_TIMEOUT_SEC * 1000);
  const idle = await ctx.prisma.liveStream.findMany({
    where: { status: { in: ['STARTING', 'LIVE'] }, lastPieceAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  });
  for (const s of idle) await endStream(ctx, s.id, 'CREATOR_DISCONNECTED').catch((err) => ctx.logger.warn({ err: (err as Error).message, streamId: s.id }, 'ending idle stream failed'));
  return idle.length;
}

export function startLiveReaper(ctx: AppContext, everyMs = 15_000): { stop(): void } {
  const timer = setInterval(() => void reapIdleStreams(ctx).catch((err) => ctx.logger.warn({ err: (err as Error).message }, 'live reaper tick failed')), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
