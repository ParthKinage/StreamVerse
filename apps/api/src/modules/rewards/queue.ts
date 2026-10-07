import type { AppContext } from '../../context';

export async function enqueueReward(ctx: AppContext, rewardId: string): Promise<void> {
  try {
    if (ctx.env.PAYMENTS_MODE === 'chain' && ctx.env.WALLET_MODE === 'managed') {
      // Built-in wallets: bonuses travel with coin purchases in one batched transaction.
      await ctx.queues.settlement.add('credits', {}, { delay: ctx.env.BATCH_WINDOW_MS, attempts: ctx.env.SETTLE_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 } });
      return;
    }
    await ctx.queues.settlement.add(
      'reward',
      { rewardId },
      { jobId: `reward-${rewardId}`, attempts: Math.max(ctx.env.SETTLE_MAX_ATTEMPTS, 8), backoff: { type: 'exponential', delay: 2000 } },
    );
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message, rewardId }, 'could not enqueue reward; the sweeper will retry');
  }
}
