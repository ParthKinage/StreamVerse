import crypto from 'node:crypto';
import { DOMAIN_EVENTS, splitFee, weiToString, type PurchaseResponse } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest } from '../../middleware/errors';
import { fromWei, toWei } from '../common';
import { publicVideoWhere } from '../catalog';
import { enqueueSettlement, getFeeBps, settlementKeyFor } from '../settlement';
import { getBalances } from '../wallet';
import { ensureManagedWallet, isManaged } from '../managed/wallets';

const PG_LOCK_NS = 7_340_002;

/**
 * Buys time-limited access to one video. The payment is an ordinary settlement (so bank mode settles it in the database
 * and chain mode settles it through the PaymentRouter), reserved from the viewer's balance immediately.
 * Buying again while access is active is a no-op that charges nothing.
 */
export async function purchaseVideo(ctx: AppContext, userId: string, videoId: string): Promise<PurchaseResponse> {
  const video = await ctx.prisma.video.findFirst({
    where: { id: videoId, ...publicVideoWhere },
    include: { creator: { select: { id: true, userId: true, user: { select: { walletAddress: true } } } } },
  });
  if (!video) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This video is not available');
  const price = toWei(video.priceSTRM);
  if (price === 0n || video.creator.userId === userId) throw badRequest('VALIDATION_ERROR', 'This video does not need to be bought');

  if (isManaged(ctx)) {
    // Built-in wallets exist for everyone; create any that are missing (for example a creator who has not signed in since).
    await ensureManagedWallet(ctx, userId);
    if (!video.creator.user.walletAddress) await ensureManagedWallet(ctx, video.creator.userId);
  } else if (ctx.env.PAYMENTS_MODE === 'chain') {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { walletAddress: true } });
    if (!user.walletAddress) throw new AppError(402, 'WALLET_NOT_LINKED', 'Link your wallet to buy paid videos');
    if (!video.creator.user.walletAddress) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This creator cannot receive payments yet');
  }

  const feeBps = await getFeeBps(ctx);
  const now = ctx.now();
  const result = await ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PG_LOCK_NS}, hashtext(${userId}))`;
    const active = await tx.videoPurchase.findFirst({ where: { userId, videoId, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } });
    if (active) {
      const available = (await getBalances(tx, userId)).available;
      return { alreadyUnlocked: true, accessUntil: active.expiresAt, available, settlementId: null as string | null };
    }
    const balances = await getBalances(tx, userId);
    if (balances.available < price) {
      throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Add money to unlock this video', {
        requiredWei: weiToString(price),
        availableWei: weiToString(balances.available),
      });
    }
    const purchaseId = crypto.randomUUID();
    const { fee, creator } = splitFee(price, feeBps);
    const settlement = await tx.paymentSettlement.create({
      data: {
        settlementKey: settlementKeyFor(`purchase:${purchaseId}`),
        userId,
        creatorId: video.creatorId,
        videoId,
        watchedSeconds: 0,
        amountSTRM: fromWei(price),
        platformFeeSTRM: fromWei(fee),
        creatorEarningsSTRM: fromWei(creator),
      },
    });
    const accessUntil = new Date(now.getTime() + ctx.env.ACCESS_HOURS * 3_600_000);
    await tx.videoPurchase.create({
      data: { id: purchaseId, userId, videoId, settlementId: settlement.id, amountSTRM: fromWei(price), expiresAt: accessUntil },
    });
    return { alreadyUnlocked: false, accessUntil, available: balances.available - price, settlementId: settlement.id };
  });

  if (result.settlementId) {
    ctx.events.emit(DOMAIN_EVENTS.SETTLEMENT_CREATED, { settlementId: result.settlementId });
    if (ctx.env.PAYMENTS_MODE === 'bank') await enqueueSettlement(ctx);
    else void enqueueSettlement(ctx);
  }
  const available = result.settlementId ? (await getBalances(ctx.prisma, userId)).available : result.available;
  return { videoId, priceWei: weiToString(price), accessUntil: result.accessUntil.toISOString(), alreadyUnlocked: result.alreadyUnlocked, availableWei: weiToString(available) };
}
