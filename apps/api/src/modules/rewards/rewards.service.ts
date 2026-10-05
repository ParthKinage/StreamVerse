import { DOMAIN_EVENTS, weiToString } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { fromWei, isUniqueViolation, toWei } from '../common';
import { enqueueReward } from './queue';

export const WELCOME_REASON = 'WELCOME';

/** Creates the one-time welcome reward (unique per user and per wallet) and queues the on-chain credit. */
export async function grantWelcomeReward(ctx: AppContext, userId: string, address: string): Promise<boolean> {
  const amountWei = BigInt(ctx.env.WELCOME_BONUS_STRM) * 10n ** 18n;
  let rewardId: string;
  try {
    const row = await ctx.prisma.tokenReward.create({
      data: { userId, reason: WELCOME_REASON, walletAddress: address.toLowerCase(), amountSTRM: fromWei(amountWei) },
    });
    rewardId = row.id;
  } catch (err) {
    if (isUniqueViolation(err)) return false; // already rewarded this user or this wallet
    throw err;
  }
  await enqueueReward(ctx, rewardId);
  return true;
}

/** Relayer credits the viewer's escrow via depositFor. Throws on retryable failures. */
export async function processReward(ctx: AppContext, rewardId: string): Promise<void> {
  const reward = await ctx.prisma.tokenReward.findUnique({ where: { id: rewardId } });
  if (!reward || reward.status !== 'PENDING' || !reward.walletAddress) return;
  if (!ctx.chain?.relayerAddress) throw new Error('Blockchain relayer is not configured');
  try {
    const result = await ctx.chain.depositFor(reward.walletAddress, toWei(reward.amountSTRM));
    await ctx.prisma.tokenReward.update({ where: { id: reward.id }, data: { status: 'SENT', txHash: result.txHash, lastError: null } });
    ctx.events.emit(DOMAIN_EVENTS.REWARD_GRANTED, { rewardId, userId: reward.userId, amountWei: weiToString(toWei(reward.amountSTRM)) });
  } catch (err) {
    const attempts = reward.attempts + 1;
    const failed = attempts >= Math.max(ctx.env.SETTLE_MAX_ATTEMPTS, 8);
    await ctx.prisma.tokenReward.update({
      where: { id: reward.id },
      data: { attempts, lastError: (err as Error).message.slice(0, 500), ...(failed ? { status: 'FAILED' } : {}) },
    });
    throw err;
  }
}

/** Re-enqueues PENDING rewards that have no live job (Redis restart, or the chain was down for a while). */
export async function sweepRewards(ctx: AppContext): Promise<void> {
  const pending = await ctx.prisma.tokenReward.findMany({ where: { status: 'PENDING' }, take: 20, select: { id: true } });
  for (const r of pending) await enqueueReward(ctx, r.id);
}
