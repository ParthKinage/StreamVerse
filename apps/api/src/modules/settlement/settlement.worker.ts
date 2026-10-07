import { Worker, type ConnectionOptions } from 'bullmq';
import type { AppContext } from '../../context';
import { QUEUE_SETTLEMENT } from '../../infra/queues';
import { countPendingCredits, enqueueCredits, processCredits } from '../managed/credits';
import { processPayout, type PayoutJob } from '../managed/payout';
import { processReward, sweepRewards } from '../rewards';
import { enqueueSettlement, processSettlements } from './settlement.service';

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Runs settlement, credit, payout and reward jobs serially (concurrency 1: one relayer, one nonce sequence) and a sweeper that
 * re-enqueues work if jobs were lost (for example after a Redis restart).
 */
export function startSettlementWorker(ctx: AppContext, sweepEveryMs = 15_000): WorkerHandle {
  const worker = new Worker(
    QUEUE_SETTLEMENT,
    async (job) => {
      if (job.name === 'reward') return processReward(ctx, (job.data as { rewardId: string }).rewardId);
      if (job.name === 'credits') return processCredits(ctx);
      if (job.name === 'payout') return processPayout(ctx, job.data as PayoutJob);
      return processSettlements(ctx);
    },
    { connection: ctx.redis.duplicate() as unknown as ConnectionOptions, concurrency: 1 },
  );
  worker.on('failed', (job, err) => ctx.logger.warn({ job: job?.name, err: err.message, attempt: job?.attemptsMade }, 'settlement job failed'));

  const sweep = async (): Promise<void> => {
    try {
      const counts = await ctx.queues.settlement.getJobCounts('waiting', 'active', 'delayed');
      const busy = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0;
      if (busy) return;
      const pending = await ctx.prisma.paymentSettlement.count({ where: { status: 'PENDING' } });
      if (pending > 0) await enqueueSettlement(ctx);
      if (ctx.env.WALLET_MODE === 'managed') {
        if ((await countPendingCredits(ctx)) > 0) await enqueueCredits(ctx);
      } else await sweepRewards(ctx);
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'settlement sweep failed');
    }
  };
  const timer = setInterval(() => void sweep(), sweepEveryMs);
  void sweep();

  return {
    async stop() {
      clearInterval(timer);
      await worker.close();
    },
  };
}
