import { Router } from 'express';
import type { AppContext } from '../../context';

type Status = 'up' | 'down' | 'disabled';

async function probe(fn: () => Promise<unknown>, timeoutMs = 1500): Promise<Status> {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return 'up';
  } catch {
    return 'down';
  }
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  postgres: Status;
  redis: Status;
  chain: Status;
  ai: Status;
  details?: Record<string, unknown>;
}

/** Postgres and Redis are critical; chain and AI are reported but never block readiness. */
export async function collectHealth(ctx: AppContext, detailed = false): Promise<HealthReport> {
  const [postgres, redis, chain, ai] = await Promise.all([
    probe(() => ctx.prisma.$queryRaw`SELECT 1`),
    probe(() => ctx.redis.ping()),
    ctx.chain ? probe(() => ctx.chain!.getBlockNumber()) : Promise.resolve<Status>('disabled'),
    ctx.ai.health().then<Status>((ok) => (ok ? 'up' : 'down')),
  ]);
  const critical = postgres === 'up' && redis === 'up';
  const report: HealthReport = {
    status: !critical ? 'down' : chain === 'down' || ai === 'down' ? 'degraded' : 'ok',
    postgres,
    redis,
    chain,
    ai,
  };
  if (detailed) {
    const details: Record<string, unknown> = {};
    try {
      details.settlements = Object.fromEntries(
        (await ctx.prisma.paymentSettlement.groupBy({ by: ['status'], _count: { _all: true } })).map((r) => [r.status, r._count._all]),
      );
      details.queues = {
        settlement: await ctx.queues.settlement.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        transcode: await ctx.queues.transcode.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      };
      details.aiBreaker = ctx.ai.breaker.state;
      const cursor = await ctx.prisma.chainCursor.findFirst({ where: { chainId: ctx.env.CHAIN_ID } });
      details.indexerCursor = cursor ? Number(cursor.lastProcessedBlock) : null;
      if (ctx.chain?.relayerAddress && chain === 'up') {
        details.relayer = ctx.chain.relayerAddress;
        details.relayerGasWei = (await ctx.chain.getRelayerGasBalance()).toString();
        details.chainHead = await ctx.chain.getBlockNumber();
      }
    } catch (err) {
      details.error = (err as Error).message;
    }
    report.details = details;
  }
  return report;
}

export function opsRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  router.get('/ready', async (_req, res) => {
    const report = await collectHealth(ctx);
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });
  return router;
}
