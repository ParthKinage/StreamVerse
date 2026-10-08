import crypto from 'node:crypto';
import { DOMAIN_EVENTS, MAX_ACCESS_PRICE_STRM, PERMANENT_ACCESS_UNTIL, parseSTRM, splitFee, stringToWei, weiToString, type PurchaseResponse } from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { AppError, badRequest } from '../../middleware/errors';
import { fromWei, toWei } from '../common';
import { watchableVideoWhere } from '../catalog';
import { enqueueSettlement, getFeeBps, settlementKeyFor } from '../settlement';
import { getBalances } from '../wallet';
import { ensureManagedWallet, isManaged } from '../managed/wallets';

type Db = AppContext['prisma'] | Prisma.TransactionClient;

const PG_LOCK_NS = 7_340_002;
const MAX_PRICE_WEI = parseSTRM(String(MAX_ACCESS_PRICE_STRM));
const PERMANENT = new Date(PERMANENT_ACCESS_UNTIL);

/** A one-time access price; 0 makes the stream free. */
export function validateAccessPriceWei(raw: string | undefined, fallback: string): bigint {
  const wei = stringToWei(raw ?? weiToString(parseSTRM(fallback)));
  if (wei > MAX_PRICE_WEI) throw badRequest('VALIDATION_ERROR', `The price must be between 0 and ${MAX_ACCESS_PRICE_STRM}`);
  return wei;
}

/** True when the viewer has bought access to this video and it has not run out (bought access never does). */
export async function hasBoughtAccess(db: Db, userId: string, videoId: string, now: Date): Promise<boolean> {
  return (await db.videoPurchase.count({ where: { userId, videoId, expiresAt: { gt: now } } })) > 0;
}

/** Of these videos, the ones the viewer has bought access to. */
export async function boughtAmong(db: Db, userId: string, videoIds: string[], now: Date): Promise<Set<string>> {
  if (!videoIds.length) return new Set();
  const rows = await db.videoPurchase.findMany({ where: { userId, videoId: { in: videoIds }, expiresAt: { gt: now } }, select: { videoId: true } });
  return new Set(rows.map((r) => r.videoId));
}

/**
 * Buys permanent access to a video sold by one price (a live stream and its recording). The payment is an ordinary
 * settlement (bank mode settles it in the database, chain mode through the PaymentRouter), reserved from the
 * viewer's balance at once. Buying again is a no-op that charges nothing.
 */
export async function purchaseAccess(ctx: AppContext, userId: string, videoId: string): Promise<PurchaseResponse> {
  const video = await ctx.prisma.video.findFirst({
    where: { id: videoId, ...watchableVideoWhere },
    include: { creator: { select: { id: true, userId: true, user: { select: { walletAddress: true } } } } },
  });
  if (!video) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This video is not available');
  if (video.accessPriceSTRM === null) {
    throw new AppError(410, 'NOT_AVAILABLE_IN_THIS_MODE', 'Videos are paid per second while you watch; just press play');
  }
  const price = toWei(video.accessPriceSTRM);
  if (price === 0n || video.creator.userId === userId) throw badRequest('VALIDATION_ERROR', 'This stream does not need to be bought');

  if (isManaged(ctx)) {
    // Built-in wallets exist for everyone; create any that are missing (for example a creator who has not signed in since).
    await ensureManagedWallet(ctx, userId);
    if (!video.creator.user.walletAddress) await ensureManagedWallet(ctx, video.creator.userId);
  } else if (ctx.env.PAYMENTS_MODE === 'chain') {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { walletAddress: true } });
    if (!user.walletAddress) throw new AppError(402, 'WALLET_NOT_LINKED', 'Link your wallet to buy access');
    if (!video.creator.user.walletAddress) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This creator cannot receive payments yet');
  }

  const feeBps = await getFeeBps(ctx);
  const now = ctx.now();
  const result = await ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PG_LOCK_NS}, hashtext(${userId}))`;
    if (await hasBoughtAccess(tx, userId, videoId, now)) {
      return { alreadyUnlocked: true, settlementId: null as string | null };
    }
    const balances = await getBalances(tx, userId);
    if (balances.available < price) {
      throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Add money to get access', { requiredWei: weiToString(price), availableWei: weiToString(balances.available) });
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
    await tx.videoPurchase.create({ data: { id: purchaseId, userId, videoId, settlementId: settlement.id, amountSTRM: fromWei(price), expiresAt: PERMANENT } });
    return { alreadyUnlocked: false, settlementId: settlement.id };
  });

  if (result.settlementId) {
    ctx.events.emit(DOMAIN_EVENTS.SETTLEMENT_CREATED, { settlementId: result.settlementId });
    if (ctx.env.PAYMENTS_MODE === 'bank') await enqueueSettlement(ctx);
    else void enqueueSettlement(ctx);
  }
  const available = (await getBalances(ctx.prisma, userId)).available;
  return { videoId, priceWei: weiToString(price), accessUntil: null, alreadyUnlocked: result.alreadyUnlocked, availableWei: weiToString(available) };
}
