import { id as keccakId } from 'ethers';
import { Reverted, type CreditItem } from '@tesor_gp/blockchain';
import { DOMAIN_EVENTS, weiToString } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { toWei } from '../common';

/** Reverts that can never succeed on a retry: the credit is failed straight away. */
const PERMANENT_REVERTS = new Set(['ZeroAmount', 'ZeroAddress']);
const MAX_ON_CHAIN_BATCH = 100;

/** The bytes32 id used on-chain for a credit. Stable per row, so a retry can never credit twice. */
export const creditKeyFor = (kind: 'reward' | 'coin', rowId: string): string => keccakId(`credit:${kind}:${rowId}`);

interface Pending {
  kind: 'reward' | 'coin';
  rowId: string;
  userId: string;
  key: string;
  viewer: string;
  amount: bigint;
  attempts: number;
  createdAt: Date;
}

const toItem = (p: Pending): CreditItem => ({ id: p.key, viewer: p.viewer, amount: p.amount });

async function loadPending(ctx: AppContext, take: number): Promise<Pending[]> {
  const [rewards, orders] = await Promise.all([
    ctx.prisma.tokenReward.findMany({ where: { status: 'PENDING', walletAddress: { not: null } }, orderBy: { createdAt: 'asc' }, take }),
    ctx.prisma.coinOrder.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take }),
  ]);
  const all: Pending[] = [
    ...rewards.map((r) => ({ kind: 'reward' as const, rowId: r.id, userId: r.userId, key: creditKeyFor('reward', r.id), viewer: r.walletAddress as string, amount: toWei(r.amountSTRM), attempts: r.attempts, createdAt: r.createdAt })),
    ...orders.map((o) => ({ kind: 'coin' as const, rowId: o.id, userId: o.userId, key: creditKeyFor('coin', o.id), viewer: o.walletAddress, amount: toWei(o.amountSTRM), attempts: o.attempts, createdAt: o.createdAt })),
  ];
  all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return all.slice(0, take);
}

async function update(ctx: AppContext, p: Pending, data: { status?: 'SENT' | 'FAILED'; txHash?: string; attempts?: number; lastError?: string | null }): Promise<void> {
  if (p.kind === 'reward') await ctx.prisma.tokenReward.updateMany({ where: { id: p.rowId, status: 'PENDING' }, data });
  else await ctx.prisma.coinOrder.updateMany({ where: { id: p.rowId, status: 'PENDING' }, data });
}

async function markSent(ctx: AppContext, rows: Pending[], txHash: string): Promise<void> {
  for (const p of rows) {
    await update(ctx, p, { status: 'SENT', txHash, lastError: null });
    if (p.kind === 'reward') ctx.events.emit(DOMAIN_EVENTS.REWARD_GRANTED, { rewardId: p.rowId, userId: p.userId, amountWei: weiToString(p.amount) });
  }
}

/**
 * Writes waiting coin purchases and bonuses to the blockchain in one transaction (the relayer pays the gas).
 * Network problems leave the rows waiting, so nothing a viewer paid for is ever dropped; the sweeper tries again.
 * Throws on retryable failures so the queue backs off.
 */
export async function processCredits(ctx: AppContext): Promise<{ credited: number }> {
  const rows = await loadPending(ctx, Math.min(ctx.env.SETTLE_BATCH_SIZE, MAX_ON_CHAIN_BATCH));
  if (rows.length === 0) return { credited: 0 };
  const chain = ctx.chain;
  if (!chain || !chain.relayerAddress) throw new Error('Blockchain relayer is not configured');

  try {
    // Reconcile first: a credit that was mined but never acknowledged must not be sent again.
    const flags = await chain.areCredited(rows.map((r) => r.key));
    let todo: Pending[] = [];
    let reconciled = 0;
    for (const [i, r] of rows.entries()) {
      if (flags[i]) {
        // The hash is only for display. Some RPCs refuse wide log searches; that must not hold up everyone's credits.
        const found = await chain.findCreditTx(r.key, ctx.deployment?.deploymentBlock ?? 0).catch(() => null);
        await markSent(ctx, [r], found?.txHash ?? '');
        reconciled += 1;
      } else todo.push(r);
    }
    if (todo.length === 0) return { credited: reconciled };

    // The relayer pays for the coins it credits, so the contract must be allowed to pull them (a one-time approval).
    await chain.ensureRouterAllowance(todo.reduce((total, r) => total + r.amount, 0n));

    try {
      await chain.simulateCreditBatch(todo.map(toItem));
    } catch (err) {
      if (!(err instanceof Reverted)) throw err;
      // Isolate the failing rows so one bad credit cannot block everyone else's.
      const good: Pending[] = [];
      let blocked: Reverted | undefined;
      for (const r of todo) {
        try {
          await chain.simulateCreditBatch([toItem(r)]);
          good.push(r);
        } catch (e) {
          if (!(e instanceof Reverted)) throw e;
          const reason = e.reason ?? e.message;
          if (PERMANENT_REVERTS.has(reason)) await update(ctx, r, { status: 'FAILED', attempts: r.attempts + 1, lastError: `Reverted: ${reason}` });
          else blocked = e; // for example the platform wallet has run out of coins: keep waiting
        }
      }
      todo = good;
      if (todo.length === 0) {
        if (blocked) throw blocked;
        return { credited: reconciled };
      }
    }

    const result = await chain.creditBatch(todo.map(toItem));
    await markSent(ctx, todo, result.txHash);
    return { credited: reconciled + todo.length };
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    for (const r of rows) await update(ctx, r, { attempts: r.attempts + 1, lastError: message });
    throw err;
  }
}

export async function enqueueCredits(ctx: AppContext): Promise<void> {
  try {
    await ctx.queues.settlement.add('credits', {}, { delay: ctx.env.BATCH_WINDOW_MS, attempts: ctx.env.SETTLE_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 } });
  } catch (err) {
    // Redis down: the sweeper picks the waiting rows up when it is back.
    ctx.logger.warn({ err: (err as Error).message }, 'could not enqueue credits job; the sweeper will retry');
  }
}

/** Number of credits still waiting to be written to the blockchain. */
export async function countPendingCredits(ctx: AppContext): Promise<number> {
  const [rewards, orders] = await Promise.all([
    ctx.prisma.tokenReward.count({ where: { status: 'PENDING', walletAddress: { not: null } } }),
    ctx.prisma.coinOrder.count({ where: { status: 'PENDING' } }),
  ]);
  return rewards + orders;
}
