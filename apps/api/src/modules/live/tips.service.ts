import crypto from 'node:crypto';
import { DOMAIN_EVENTS, MAX_TIP_STRM, MIN_TIP_STRM, parseSTRM, splitFee, stringToWei, weiToString, type SendTipRequest, type SendTipResponse } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest, conflict, notFound } from '../../middleware/errors';
import { fromWei, toWei } from '../common';
import { ensureManagedWallet, isManaged } from '../managed/wallets';
import { hasBoughtAccess } from '../purchase/purchase.service';
import { enqueueSettlement, getFeeBps, settlementKeyFor } from '../settlement';
import { getBalances } from '../wallet';

const PG_LOCK_NS = 7_340_002;
const MIN_TIP_WEI = parseSTRM(String(MIN_TIP_STRM));
const MAX_TIP_WEI = parseSTRM(String(MAX_TIP_STRM));

/**
 * A viewer tips the creator during a live stream. The tip is paid like any payment (spec E5: tips are settlements
 * and go through the same batch): one settlement with the platform's usual fee (owner decision), reserved from the
 * viewer's balance at once. It shows in the chat as a highlighted message.
 */
export async function sendTip(ctx: AppContext, user: { id: string; role: string }, streamId: string, input: SendTipRequest): Promise<SendTipResponse> {
  const s = await ctx.prisma.liveStream.findUnique({
    where: { id: streamId },
    select: {
      id: true,
      status: true,
      videoId: true,
      creatorId: true,
      creator: { select: { userId: true, user: { select: { walletAddress: true } } } },
      video: { select: { archivedAt: true, accessPriceSTRM: true } },
    },
  });
  if (!s || s.video.archivedAt) throw notFound('Stream not found');
  if (s.status !== 'LIVE' && s.status !== 'STARTING') throw conflict('LIVE_NOT_ACTIVE', 'Tips close when the stream ends');
  if (s.creator.userId === user.id) throw badRequest('VALIDATION_ERROR', 'You cannot tip your own stream');

  const amount = stringToWei(input.amountWei);
  if (amount < MIN_TIP_WEI || amount > MAX_TIP_WEI) throw badRequest('VALIDATION_ERROR', `A tip must be between ${MIN_TIP_STRM} and ${MAX_TIP_STRM}`);

  // Tipping is part of taking part in the stream, so it needs the same access as chatting.
  const price = s.video.accessPriceSTRM ? toWei(s.video.accessPriceSTRM) : 0n;
  if (user.role !== 'ADMIN' && price > 0n && !(await hasBoughtAccess(ctx.prisma, user.id, s.videoId, ctx.now()))) {
    throw new AppError(402, 'PURCHASE_REQUIRED', 'Get access to the stream to send a tip');
  }

  if (isManaged(ctx)) {
    await ensureManagedWallet(ctx, user.id);
    if (!s.creator.user.walletAddress) await ensureManagedWallet(ctx, s.creator.userId);
  } else if (ctx.env.PAYMENTS_MODE === 'chain') {
    const viewer = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { walletAddress: true } });
    if (!viewer.walletAddress) throw new AppError(402, 'WALLET_NOT_LINKED', 'Link your wallet to send tips');
    if (!s.creator.user.walletAddress) throw new AppError(404, 'VIDEO_NOT_AVAILABLE', 'This creator cannot receive payments yet');
  }

  const feeBps = await getFeeBps(ctx);
  const text = input.message?.trim() ?? '';
  const result = await ctx.prisma.$transaction(async (tx) => {
    // Same per-user lock as starting a session or buying access, so two payments never spend the same balance.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PG_LOCK_NS}, hashtext(${user.id}))`;
    const available = (await getBalances(tx, user.id)).available;
    if (available < amount) {
      throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Add money to send this tip', { requiredWei: weiToString(amount), availableWei: weiToString(available) });
    }
    const tipId = crypto.randomUUID();
    const { fee, creator } = splitFee(amount, feeBps);
    const settlement = await tx.paymentSettlement.create({
      data: {
        settlementKey: settlementKeyFor(`tip:${tipId}`),
        userId: user.id,
        creatorId: s.creatorId,
        videoId: s.videoId,
        watchedSeconds: 0,
        amountSTRM: fromWei(amount),
        platformFeeSTRM: fromWei(fee),
        creatorEarningsSTRM: fromWei(creator),
      },
    });
    const message = await tx.liveChatMessage.create({
      data: { liveStreamId: s.id, userId: user.id, text, tipSTRM: fromWei(amount) },
      include: { user: { select: { username: true } } },
    });
    await tx.tip.create({ data: { id: tipId, fromUserId: user.id, liveStreamId: s.id, amountSTRM: fromWei(amount), settlementId: settlement.id, chatMessageId: message.id } });
    return { settlementId: settlement.id, message };
  });

  ctx.events.emit(DOMAIN_EVENTS.SETTLEMENT_CREATED, { settlementId: result.settlementId });
  ctx.events.emit(DOMAIN_EVENTS.TIP_SENT, { streamId, userId: user.id, amountWei: weiToString(amount) });
  if (ctx.env.PAYMENTS_MODE === 'bank') await enqueueSettlement(ctx);
  else void enqueueSettlement(ctx);

  const m = result.message;
  return {
    message: { id: m.id, text: m.text, createdAt: m.createdAt.toISOString(), user: { id: user.id, username: m.user.username }, fromCreator: false, tipWei: weiToString(amount) },
    availableWei: weiToString((await getBalances(ctx.prisma, user.id)).available),
  };
}
