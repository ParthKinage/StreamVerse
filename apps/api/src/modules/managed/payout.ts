import { Reverted } from '@tesor_gp/blockchain';
import { WEI_PER_STRM, weiToString } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest, forbidden } from '../../middleware/errors';
import { getCreatorClaimable } from '../creator/earnings';
import { ensureManagedWallet, requireManaged } from './wallets';

const PENDING_TTL_SEC = 180;
const SETTLING_TTL_SEC = 20;
const pendingKey = (userId: string): string => `payout:pending:${userId}`;

export interface PayoutJob {
  userId: string;
  address: string;
}

export async function isPayoutPending(ctx: AppContext, userId: string): Promise<boolean> {
  try {
    return (await ctx.redis.exists(pendingKey(userId))) === 1;
  } catch {
    return false;
  }
}

/**
 * Creator asks for their earnings. The relayer pays the gas and the contract sends the coins to the creator's own
 * built-in wallet, so the creator needs no gas and signs nothing. Returns as soon as the payout is queued.
 */
export async function requestPayout(ctx: AppContext, userId: string): Promise<{ amountWei: string }> {
  requireManaged(ctx);
  const profile = await ctx.prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw forbidden('Create a creator profile first', 'NOT_CREATOR');
  if (!ctx.chain?.relayerAddress) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The blockchain is not configured yet');
  const address = await ensureManagedWallet(ctx, userId);
  const claimable = await getCreatorClaimable(ctx, profile.id, address);
  const min = BigInt(ctx.env.MIN_PAYOUT_STRM) * WEI_PER_STRM;
  if (claimable < min) {
    throw badRequest('INVALID_AMOUNT', `You need at least ${ctx.env.MIN_PAYOUT_STRM} STRM of earnings to get paid out`, { minWei: weiToString(min), claimableWei: weiToString(claimable) });
  }
  // One payout at a time per creator: a second click while one is on its way is a no-op.
  const first = await ctx.redis.set(pendingKey(userId), '1', 'EX', PENDING_TTL_SEC, 'NX');
  if (first) {
    try {
      const job: PayoutJob = { userId, address };
      await ctx.queues.settlement.add('payout', job, { attempts: ctx.env.SETTLE_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 } });
    } catch (err) {
      await ctx.redis.del(pendingKey(userId)).catch(() => undefined);
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Could not queue the payout. Please try again in a moment.', { cause: (err as Error).message });
    }
  }
  return { amountWei: weiToString(claimable) };
}

/** Sends the payout transaction. "Nothing to claim" means an earlier attempt already paid, so it counts as done. */
export async function processPayout(ctx: AppContext, job: PayoutJob): Promise<void> {
  if (!ctx.chain?.relayerAddress) throw new Error('Blockchain relayer is not configured');
  try {
    await ctx.chain.claimEarningsFor(job.address);
  } catch (err) {
    if (!(err instanceof Reverted && err.reason === 'NothingToClaim')) throw err;
  }
  // Keep showing "on its way" for a moment: the balance only changes once the indexer has seen the confirmed payout.
  await ctx.redis.expire(pendingKey(job.userId), SETTLING_TTL_SEC).catch(() => undefined);
}
