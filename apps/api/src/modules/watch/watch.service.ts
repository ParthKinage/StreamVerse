import crypto from 'node:crypto';
import {
  DOMAIN_EVENTS,
  HEARTBEAT_GRACE_SEC,
  START_MIN_BALANCE_SECONDS,
  VIEW_MIN_SECONDS,
  costForSeconds,
  splitFee,
  weiToString,
  type EndSessionResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HistoryItem,
  type StartSessionResponse,
  type VideoDto,
} from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { AppError, conflict, forbidden, notFound } from '../../middleware/errors';
import { decodeCursor, encodeCursor, fromWei, toWei, videoInclude } from '../common';
import { decorateVideos, publicVideoWhere } from '../catalog';
import { signEndToken } from '../playback';
import { enqueueSettlement, getFeeBps, settlementKeyFor } from '../settlement';
import { ensureManagedWallet, isManaged } from '../managed/wallets';
import { getBalances } from '../wallet';
import { paidSecondsFor } from './charges';

type Tx = Prisma.TransactionClient;

interface FinalizeOutcome {
  settlementId: string | null;
  verifiedSeconds: number;
  chargedWei: bigint;
  /** true when this call performed the transition (false if the session had already ended) */
  transitioned: boolean;
}

const PG_LOCK_NS = 7_340_002;

async function lockSession(tx: Tx, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "WatchSession" WHERE id = ${sessionId} FOR UPDATE`;
  return rows.length > 0;
}

/** Ends a session inside a transaction: creates the settlement (if anything was charged) and counts the view. */
async function finalizeInTx(ctx: AppContext, tx: Tx, sessionId: string, reason: string, feeBps: number): Promise<FinalizeOutcome | null> {
  if (!(await lockSession(tx, sessionId))) return null;
  const s = await tx.watchSession.findUniqueOrThrow({ where: { id: sessionId }, include: { video: { select: { creatorId: true, id: true } } } });
  const charged = toWei(s.chargedSTRM);
  if (s.status !== 'ACTIVE' && s.status !== 'PAUSED') {
    const existing = await tx.paymentSettlement.findFirst({ where: { sessionId }, select: { id: true } });
    return { settlementId: existing?.id ?? null, verifiedSeconds: s.verifiedDurationSeconds, chargedWei: charged, transitioned: false };
  }
  let settlementId: string | null = null;
  if (charged > 0n) {
    const { fee, creator } = splitFee(charged, feeBps);
    const row = await tx.paymentSettlement.create({
      data: {
        settlementKey: settlementKeyFor(sessionId),
        sessionId,
        userId: s.userId,
        creatorId: s.video.creatorId,
        videoId: s.videoId,
        watchedSeconds: s.verifiedDurationSeconds,
        amountSTRM: fromWei(charged),
        platformFeeSTRM: fromWei(fee),
        creatorEarningsSTRM: fromWei(creator),
      },
    });
    settlementId = row.id;
  }
  const countView = s.verifiedDurationSeconds >= VIEW_MIN_SECONDS && !s.viewCounted;
  await tx.watchSession.update({
    where: { id: sessionId },
    data: { status: 'COMPLETED', endedAt: ctx.now(), endReason: reason, ...(countView ? { viewCounted: true } : {}) },
  });
  if (countView) await tx.video.update({ where: { id: s.videoId }, data: { viewsCount: { increment: 1 } } });
  return { settlementId, verifiedSeconds: s.verifiedDurationSeconds, chargedWei: charged, transitioned: true };
}

/** Post-commit work for an ended session. Demo-bank settlement is a quick database transaction, so it is awaited and the wallet is current when the call returns. */
async function afterFinalize(ctx: AppContext, sessionId: string, outcome: FinalizeOutcome): Promise<void> {
  if (!outcome.transitioned) return;
  ctx.events.emit(DOMAIN_EVENTS.SESSION_ENDED, { sessionId });
  if (outcome.settlementId) {
    ctx.events.emit(DOMAIN_EVENTS.SETTLEMENT_CREATED, { settlementId: outcome.settlementId });
    if (ctx.env.PAYMENTS_MODE === 'bank') await enqueueSettlement(ctx);
    else void enqueueSettlement(ctx);
  }
}

export async function finalizeSession(ctx: AppContext, sessionId: string, reason: string): Promise<FinalizeOutcome | null> {
  const feeBps = await getFeeBps(ctx);
  const outcome = await ctx.prisma.$transaction((tx) => finalizeInTx(ctx, tx, sessionId, reason, feeBps));
  if (outcome) await afterFinalize(ctx, sessionId, outcome);
  return outcome;
}

export interface StartResult {
  response: StartSessionResponse;
  userId: string;
}

export async function startSession(ctx: AppContext, userId: string, videoId: string): Promise<StartResult> {
  const video = await ctx.prisma.video.findFirst({
    where: { id: videoId, ...publicVideoWhere },
    include: { creator: { select: { userId: true, user: { select: { walletAddress: true } } } } },
  });
  if (!video) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This video is not available');

  const own = video.creator.userId === userId;
  // The creator's own videos are free to them; everyone else pays the rate per second they are sent.
  const rate = own ? 0n : toWei(video.ratePerMinuteSTRM);
  const free = rate === 0n;

  // Payments need wallets on both sides (moved here from the old unlock step).
  if (!free && isManaged(ctx)) {
    await ensureManagedWallet(ctx, userId);
    if (!video.creator.user.walletAddress) await ensureManagedWallet(ctx, video.creator.userId);
  } else if (!free && ctx.env.PAYMENTS_MODE === 'chain') {
    if (!video.creator.user.walletAddress) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This creator cannot receive payments yet');
    const viewer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { walletAddress: true } });
    if (!viewer.walletAddress) throw new AppError(402, 'WALLET_NOT_LINKED', 'Link your wallet to watch paid videos');
  }

  let available = (await getBalances(ctx.prisma, userId)).available;
  const paidSeconds = await paidSecondsFor(ctx, userId, videoId);
  // Starting needs about a minute of balance, unless everything left to watch has already been paid for.
  const unpaidSeconds = Math.max(0, video.durationSeconds - paidSeconds);
  const needed = costForSeconds(Math.min(START_MIN_BALANCE_SECONDS, unpaidSeconds), rate);
  if (!free && unpaidSeconds > 0 && available < needed) {
    throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Add money to start watching', { requiredWei: weiToString(needed), availableWei: weiToString(available) });
  }

  const feeBps = await getFeeBps(ctx);
  const ended: Array<{ id: string; outcome: FinalizeOutcome }> = [];
  const last = await ctx.prisma.watchSession.findFirst({
    where: { userId, videoId },
    orderBy: { startedAt: 'desc' },
    select: { lastPlaybackTime: true },
  });
  const sessionId = crypto.randomUUID();
  const session = await ctx.prisma.$transaction(async (tx) => {
    // One concurrent stream per user: serialise starts per user, then end whatever is still open.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PG_LOCK_NS}, hashtext(${userId}))`;
    const open = await tx.watchSession.findMany({ where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } });
    for (const o of open) {
      const outcome = await finalizeInTx(ctx, tx, o.id, 'SUPERSEDED', feeBps);
      if (outcome) ended.push({ id: o.id, outcome });
    }
    return tx.watchSession.create({
      data: {
        id: sessionId,
        userId,
        videoId,
        playbackToken: crypto.randomBytes(24).toString('base64url'),
        ratePerMinuteSTRM: fromWei(rate),
        lastHeartbeatAt: ctx.now(),
        startedAt: ctx.now(),
      },
    });
  });
  for (const e of ended) await afterFinalize(ctx, e.id, e.outcome);
  available = (await getBalances(ctx.prisma, userId)).available;

  ctx.events.emit(DOMAIN_EVENTS.SESSION_STARTED, { sessionId: session.id, userId, videoId });

  const resume = last && video.durationSeconds > 0 && last.lastPlaybackTime < video.durationSeconds - 5 ? Math.floor(last.lastPlaybackTime) : 0;
  return {
    userId,
    response: {
      sessionId: session.id,
      endToken: signEndToken(session.id, ctx.env.PLAYBACK_SIGNING_SECRET),
      manifestUrl: `/playback/${session.id}/master.m3u8`,
      heartbeatIntervalSec: ctx.env.HEARTBEAT_INTERVAL_SEC,
      resumePositionSec: resume,
      availableWei: weiToString(available),
      free,
      ratePerMinuteWei: weiToString(rate),
      paidSeconds,
      accessUntil: null,
    },
  };
}

export interface HeartbeatResult {
  response: HeartbeatResponse;
  renewCookie: boolean;
}

export async function heartbeat(ctx: AppContext, userId: string, sessionId: string, input: HeartbeatRequest): Promise<HeartbeatResult> {
  const result = await ctx.prisma.$transaction(async (tx) => {
    if (!(await lockSession(tx, sessionId))) throw notFound('Session not found');
    const s = await tx.watchSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (s.userId !== userId) throw forbidden('Not your session');

    // Idempotent retry of the previous heartbeat.
    if (input.sequence === s.lastSequence && s.lastHeartbeatResponse) {
      const stored = s.lastHeartbeatResponse as unknown as HeartbeatResponse;
      return { response: stored, renewCookie: stored.action !== 'stop', verified: s.verifiedDurationSeconds };
    }
    if (s.status !== 'ACTIVE') {
      throw conflict('SESSION_NOT_ACTIVE', 'This session has ended', { endReason: s.endReason });
    }
    if (input.sequence !== s.lastSequence + 1) {
      throw conflict('SEQUENCE_CONFLICT', 'Heartbeat out of sequence', { expected: s.lastSequence + 1 });
    }

    const now = ctx.now();
    const intervalSec = ctx.env.HEARTBEAT_INTERVAL_SEC;
    const cap = intervalSec + HEARTBEAT_GRACE_SEC;
    const wallDelta = Math.max(0, (now.getTime() - s.lastHeartbeatAt.getTime()) / 1000);

    // Server clock only: the client's playbackTime is never used to bill.
    let credited = 0;
    let nextAnchor = now;
    if (input.state === 'playing') {
      credited = Math.floor(Math.min(wallDelta, cap));
      // Carry the sub-second remainder so a steady 10.02 s cadence is not under-billed.
      if (wallDelta <= cap) nextAnchor = new Date(s.lastHeartbeatAt.getTime() + credited * 1000);
    }
    const verified = s.verifiedDurationSeconds + credited;
    // Money is charged per piece of video sent (see charges.ts); heartbeats count watch time and report the total.
    const charged = toWei(s.chargedSTRM);

    await tx.watchHeartbeat.create({
      data: { sessionId, sequence: input.sequence, playbackTime: input.playbackTime, creditedSeconds: credited },
    });
    await tx.watchSession.update({
      where: { id: sessionId },
      data: {
        lastSequence: input.sequence,
        lastPlaybackTime: input.playbackTime,
        verifiedDurationSeconds: verified,
        lastHeartbeatAt: nextAnchor,
      },
    });

    // Playback is never stopped from here: the segment route refuses unpaid pieces once the balance is gone, and pieces
    // already paid for keep playing. The heartbeat reports how much new video the balance still covers.
    const rate = toWei(s.ratePerMinuteSTRM);
    const available = (await getBalances(tx, userId)).available;
    const paid = await tx.paidSegment.aggregate({ where: { userId, videoId: s.videoId }, _sum: { durationMs: true } });
    const response: HeartbeatResponse = {
      sequence: input.sequence,
      verifiedSeconds: verified,
      chargedWei: weiToString(charged),
      availableWei: weiToString(available),
      secondsRemaining: rate > 0n ? Number((available * 60n) / rate) : null,
      action: 'continue',
      paidSeconds: Math.floor((paid._sum.durationMs ?? 0) / 1000),
      accessUntil: null,
    };

    await tx.watchSession.update({ where: { id: sessionId }, data: { lastHeartbeatResponse: response as unknown as Prisma.InputJsonValue } });
    return { response, renewCookie: true, verified };
  });

  return { response: result.response, renewCookie: result.renewCookie };
}

export async function endSession(ctx: AppContext, sessionId: string, userId: string | undefined, reason: string): Promise<EndSessionResponse> {
  if (userId) {
    const owner = await ctx.prisma.watchSession.findUnique({ where: { id: sessionId }, select: { userId: true } });
    if (!owner) throw notFound('Session not found');
    if (owner.userId !== userId) throw forbidden('Not your session');
  }
  const outcome = await finalizeSession(ctx, sessionId, reason);
  if (!outcome) throw notFound('Session not found');
  return {
    sessionId,
    verifiedSeconds: outcome.verifiedSeconds,
    chargedWei: weiToString(outcome.chargedWei),
    settlementId: outcome.settlementId,
  };
}

/** Ends sessions whose client stopped heartbeating (closed tab, crash, lost network). */
export async function reapStaleSessions(ctx: AppContext): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.env.SESSION_TIMEOUT_SEC * 1000);
  const stale = await ctx.prisma.watchSession.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, lastHeartbeatAt: { lt: cutoff } },
    select: { id: true },
    take: 200,
  });
  for (const s of stale) await finalizeSession(ctx, s.id, 'TIMEOUT').catch((err) => ctx.logger.warn({ err: (err as Error).message, sessionId: s.id }, 'reaper failed'));
  return stale.length;
}

export function startReaper(ctx: AppContext, everyMs = 15_000): { stop(): void } {
  const timer = setInterval(() => void reapStaleSessions(ctx).catch((err) => ctx.logger.warn({ err: (err as Error).message }, 'reaper tick failed')), everyMs);
  return { stop: () => clearInterval(timer) };
}

export async function listHistory(ctx: AppContext, userId: string, cursor: string | undefined, limit: number) {
  const cur = decodeCursor<{ t: string; id: string }>(cursor);
  const rows = await ctx.prisma.watchSession.findMany({
    where: {
      userId,
      verifiedDurationSeconds: { gt: 0 },
      video: { archivedAt: null },
      ...(cur ? { OR: [{ startedAt: { lt: new Date(cur.t) } }, { startedAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: { video: { include: videoInclude } },
  });
  const page = rows.slice(0, limit);
  const videos = await decorateVideos(ctx, page.map((r) => r.video), userId);
  const byId = new Map(videos.map((v) => [v.id, v]));

  const items: HistoryItem[] = page.map((r) => ({
    sessionId: r.id,
    video: byId.get(r.videoId) as VideoDto,
    watchedSeconds: r.verifiedDurationSeconds,
    paidWei: toWei(r.chargedSTRM).toString(),
    lastPositionSec: Math.floor(r.lastPlaybackTime),
    watchedAt: r.startedAt.toISOString(),
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ t: last.startedAt.toISOString(), id: last.id }) : null };
}

/** Latest unfinished video per title, most recent first. */
export async function continueWatching(ctx: AppContext, userId: string, limit = 12): Promise<{ items: Array<{ video: VideoDto; positionSec: number; watchedAt: string }> }> {
  const rows = await ctx.prisma.watchSession.findMany({
    where: { userId, lastPlaybackTime: { gt: 5 }, video: { ...publicVideoWhere } },
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { video: { include: videoInclude } },
  });
  const seen = new Set<string>();
  const picked = [];
  for (const r of rows) {
    if (seen.has(r.videoId)) continue;
    seen.add(r.videoId);
    if (r.video.durationSeconds > 0 && r.lastPlaybackTime >= r.video.durationSeconds - 10) continue; // finished
    picked.push(r);
    if (picked.length >= limit) break;
  }
  const videos = await decorateVideos(ctx, picked.map((r) => r.video), userId);
  const byId = new Map(videos.map((v) => [v.id, v]));
  return {
    items: picked.map((r) => ({ video: byId.get(r.videoId) as VideoDto, positionSec: Math.floor(r.lastPlaybackTime), watchedAt: r.startedAt.toISOString() })),
  };
}
