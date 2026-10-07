import { costForMs, weiToString } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, forbidden, notFound } from '../../middleware/errors';
import { fromWei, toWei } from '../common';
import { getBalances } from '../wallet';

export interface SegmentCharge {
  /** What this piece cost the viewer (0 when it was free: free video, own video, or already paid). */
  chargedWei: bigint;
  /** True the first time this viewer is sent this piece of this video. */
  firstTime: boolean;
}

/**
 * Charges the viewer for one piece of video the player asked for, unless they have paid for that piece before.
 *
 * The piece is identified by its index on the 4-second grid, which is the same in every rendition, so switching
 * quality never charges twice. Rewinding fetches pieces already paid for (free); skipping ahead never fetches the
 * pieces in between (never paid). The charge is added to the session and reserved from the viewer's balance at once;
 * the session's total becomes one settlement when it ends.
 */
export async function chargeSegment(ctx: AppContext, sessionId: string, segmentIndex: number, durationMs: number): Promise<SegmentCharge> {
  return ctx.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "WatchSession" WHERE id = ${sessionId} FOR UPDATE`;
    if (!locked.length) throw notFound('Session not found');
    const s = await tx.watchSession.findUniqueOrThrow({ where: { id: sessionId }, select: { userId: true, videoId: true, status: true, ratePerMinuteSTRM: true } });
    if (s.status !== 'ACTIVE') throw forbidden('Session is not active', 'SESSION_NOT_ACTIVE');

    const key = { userId_videoId_segmentIndex: { userId: s.userId, videoId: s.videoId, segmentIndex } };
    if (await tx.paidSegment.findUnique({ where: key, select: { segmentIndex: true } })) return { chargedWei: 0n, firstTime: false };

    const rate = toWei(s.ratePerMinuteSTRM);
    const amount = costForMs(durationMs, rate);
    if (amount > 0n) {
      const available = (await getBalances(tx, s.userId)).available;
      if (available < amount) {
        throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Your balance has run out. Buy coins to keep watching.', {
          requiredWei: weiToString(amount),
          availableWei: weiToString(available),
        });
      }
    }
    // Free pieces (free video, own video) are recorded too, so "seconds watched" stays accurate if the rate changes later.
    await tx.paidSegment.create({ data: { userId: s.userId, videoId: s.videoId, segmentIndex, durationMs, amountSTRM: fromWei(amount), sessionId } });
    if (amount > 0n) await tx.watchSession.update({ where: { id: sessionId }, data: { chargedSTRM: { increment: fromWei(amount) } } });
    return { chargedWei: amount, firstTime: true };
  });
}

/** Seconds of `videoId` the viewer has already been sent (and paid for, when the video was paid). */
export async function paidSecondsFor(ctx: AppContext, userId: string, videoId: string): Promise<number> {
  const agg = await ctx.prisma.paidSegment.aggregate({ where: { userId, videoId }, _sum: { durationMs: true } });
  return Math.floor((agg._sum.durationMs ?? 0) / 1000);
}
