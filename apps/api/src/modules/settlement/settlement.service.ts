import { id as keccakId } from 'ethers';
import { Reverted, RpcUnavailable, type SettlementItem } from '@tesor_gp/blockchain';
import { DOMAIN_EVENTS } from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { fromWei, toWei } from '../common';

export const DEFAULT_FEE_BPS = 1000;
/** Revert reasons that will never succeed on retry: the settlement is failed immediately. */
const PERMANENT_REVERTS = new Set(['InsufficientEscrow', 'ZeroAmount', 'ZeroAddress']);

type Tx = Prisma.TransactionClient;

/** The bytes32 id used on-chain for a session's settlement. */
export function settlementKeyFor(sessionId: string): string {
  return keccakId(sessionId);
}

let feeCache: { value: number; at: number } | undefined;
/** Platform fee in basis points, read from the contract (cached 60 s) with a default when the chain is unreachable. */
export async function getFeeBps(ctx: AppContext): Promise<number> {
  if (ctx.env.PAYMENTS_MODE === 'bank') return ctx.env.PLATFORM_FEE_BPS;
  const now = Date.now();
  if (feeCache && now - feeCache.at < 60_000) return feeCache.value;
  try {
    const value = ctx.chain ? await ctx.chain.getFeeBps() : DEFAULT_FEE_BPS;
    feeCache = { value, at: now };
    return value;
  } catch {
    feeCache = { value: feeCache?.value ?? DEFAULT_FEE_BPS, at: now - 50_000 };
    return feeCache.value;
  }
}
export function resetFeeCache(): void {
  feeCache = undefined;
}

export async function enqueueSettlement(ctx: AppContext): Promise<void> {
  if (ctx.env.PAYMENTS_MODE === 'bank') {
    // Demo bank: settlement is a database transaction, so it happens right away instead of going through a queue.
    await processBankSettlements(ctx).catch((err: Error) => ctx.logger.warn({ err: err.message }, 'bank settlement failed; the sweeper will retry'));
    return;
  }
  try {
    await ctx.queues.settlement.add('settle', {}, { attempts: ctx.env.SETTLE_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 } });
  } catch (err) {
    // Redis down: the sweeper will pick the PENDING row up when it is back.
    ctx.logger.warn({ err: (err as Error).message }, 'could not enqueue settlement job');
  }
}

/** Marks a settlement as settled exactly once and credits the creator's lifetime earnings. Idempotent. */
export async function markSettlementSettled(ctx: AppContext, tx: Tx, settlementId: string, txHash: string): Promise<boolean> {
  const s = await tx.paymentSettlement.findUnique({ where: { id: settlementId } });
  if (!s || s.status === 'SETTLED') return false;
  await tx.paymentSettlement.update({
    where: { id: s.id },
    data: { status: 'SETTLED', txHash, settledAt: ctx.now(), lastError: null },
  });
  if (s.sessionId) await tx.watchSession.update({ where: { id: s.sessionId }, data: { status: 'SETTLED' } });
  await tx.creatorProfile.update({ where: { id: s.creatorId }, data: { totalEarnings: { increment: s.creatorEarningsSTRM.toFixed() } } });
  ctx.events.emit(DOMAIN_EVENTS.SETTLEMENT_SETTLED, { settlementId: s.id, txHash });
  return true;
}

interface Row {
  id: string;
  settlementKey: string;
  amountSTRM: { toFixed(): string };
  attempts: number;
  user: { walletAddress: string | null };
  creator: { user: { walletAddress: string | null } };
}

async function recordFailure(ctx: AppContext, rows: Row[], message: string, permanent: boolean): Promise<void> {
  for (const r of rows) {
    const attempts = r.attempts + 1;
    const failed = permanent || attempts >= ctx.env.SETTLE_MAX_ATTEMPTS;
    await ctx.prisma.paymentSettlement.update({
      where: { id: r.id },
      data: { attempts, lastError: message.slice(0, 500), ...(failed ? { status: 'FAILED' } : {}) },
    });
    if (failed) ctx.events.emit(DOMAIN_EVENTS.SETTLEMENT_FAILED, { settlementId: r.id, error: message });
  }
}

async function settleSetAsSettled(ctx: AppContext, rows: Row[], txHash: string): Promise<void> {
  for (const r of rows) await ctx.prisma.$transaction((tx) => markSettlementSettled(ctx, tx, r.id, txHash));
}

/**
 * Settles up to SETTLE_BATCH_SIZE pending settlements in one transaction.
 * Throws on retryable failures so the queue retries with exponential backoff.
 */
export async function processSettlements(ctx: AppContext): Promise<{ settled: number }> {
  const rows = (await ctx.prisma.paymentSettlement.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: ctx.env.SETTLE_BATCH_SIZE,
    include: { user: { select: { walletAddress: true } }, creator: { select: { user: { select: { walletAddress: true } } } } },
  })) as Row[];
  if (rows.length === 0) return { settled: 0 };

  const chain = ctx.chain;
  if (!chain || !chain.relayerAddress) {
    await recordFailure(ctx, rows, 'Blockchain relayer is not configured', false);
    throw new Error('Blockchain relayer is not configured');
  }

  try {
    // Reconcile first: ids already settled on-chain (earlier attempt mined but unacknowledged) must not be re-sent.
    const flags = await chain.areSettled(rows.map((r) => r.settlementKey));
    let todo: Row[] = [];
    let reconciled = 0;
    for (const [i, r] of rows.entries()) {
      if (flags[i]) {
        const found = await chain.findSettlementTx(r.settlementKey, ctx.deployment?.deploymentBlock ?? 0);
        await settleSetAsSettled(ctx, [r], found?.txHash ?? '');
        reconciled += 1;
      } else todo.push(r);
    }

    const missing = todo.filter((r) => !r.user.walletAddress || !r.creator.user.walletAddress);
    if (missing.length) await recordFailure(ctx, missing, 'Viewer or creator wallet is not linked', false);
    todo = todo.filter((r) => !missing.includes(r));
    if (todo.length === 0) {
      if (missing.length) throw new Error('Some settlements are waiting for linked wallets');
      return { settled: reconciled };
    }

    const toItem = (r: Row): SettlementItem => ({
      id: r.settlementKey,
      viewer: r.user.walletAddress as string,
      creator: r.creator.user.walletAddress as string,
      amount: toWei(r.amountSTRM),
    });

    let sendable = todo;
    try {
      await chain.simulateSettleBatch(sendable.map(toItem));
    } catch (err) {
      if (!(err instanceof Reverted)) throw err;
      // Isolate the failing items so one bad settlement cannot block the rest.
      const good: Row[] = [];
      const bad: Array<{ row: Row; reason: string }> = [];
      for (const r of todo) {
        try {
          await chain.simulateSettleBatch([toItem(r)]);
          good.push(r);
        } catch (e) {
          if (!(e instanceof Reverted)) throw e;
          bad.push({ row: r, reason: e.reason ?? e.message });
        }
      }
      for (const b of bad) await recordFailure(ctx, [b.row], `Reverted: ${b.reason}`, PERMANENT_REVERTS.has(b.reason));
      sendable = good;
      if (sendable.length === 0) return { settled: reconciled };
    }

    const result = await chain.settleBatch(sendable.map(toItem));
    await settleSetAsSettled(ctx, sendable, result.txHash);
    return { settled: reconciled + sendable.length };
  } catch (err) {
    if (err instanceof RpcUnavailable || err instanceof Reverted || err instanceof Error) {
      // Already-recorded failures above are not double counted: only rows still PENDING get an attempt.
      const still = (await ctx.prisma.paymentSettlement.findMany({
        where: { id: { in: rows.map((r) => r.id) }, status: 'PENDING' },
        include: { user: { select: { walletAddress: true } }, creator: { select: { user: { select: { walletAddress: true } } } } },
      })) as Row[];
      const alreadyCounted = (err as Error).message.startsWith('Some settlements are waiting');
      if (!alreadyCounted) await recordFailure(ctx, still, (err as Error).message, false);
    }
    throw err;
  }
}

/**
 * Demo-bank settlement: moves each finished session's charge from the viewer's wallet to the creator's earnings
 * inside one database transaction. The claim step makes it safe to run concurrently or twice.
 */
export async function processBankSettlements(ctx: AppContext): Promise<{ settled: number }> {
  const rows = await ctx.prisma.paymentSettlement.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: ctx.env.SETTLE_BATCH_SIZE,
    select: { id: true, userId: true, amountSTRM: true },
  });
  let settled = 0;
  for (const r of rows) {
    const done = await ctx.prisma.$transaction(async (tx) => {
      const claim = await tx.paymentSettlement.updateMany({ where: { id: r.id, status: 'PENDING', escrowAppliedAt: null }, data: { escrowAppliedAt: ctx.now() } });
      if (claim.count !== 1) return false;
      const account = await tx.escrowAccount.findUnique({ where: { userId: r.userId } });
      const amount = toWei(r.amountSTRM);
      const balance = account ? toWei(account.onChainBalance) : 0n;
      const debit = amount > balance ? balance : amount;
      if (account && debit > 0n) await tx.escrowAccount.update({ where: { userId: r.userId }, data: { onChainBalance: { decrement: fromWei(debit) } } });
      return markSettlementSettled(ctx, tx, r.id, '');
    });
    if (done) settled += 1;
  }
  return { settled };
}

/** Admin: put a FAILED settlement back in the queue. */
export async function retrySettlement(ctx: AppContext, settlementId: string): Promise<boolean> {
  const res = await ctx.prisma.paymentSettlement.updateMany({
    where: { id: settlementId, status: 'FAILED' },
    data: { status: 'PENDING', attempts: 0, lastError: null },
  });
  if (res.count === 1) await enqueueSettlement(ctx);
  return res.count === 1;
}

export interface ReconcileRow {
  userId: string;
  address: string;
  dbEscrow: bigint;
  chainEscrow: bigint;
  dbPending: bigint;
  chainPending: bigint;
  diff: bigint;
}

/** Compares the database escrow ledger with the chain for every linked wallet. Zero diff means consistent. */
export async function reconcile(ctx: AppContext): Promise<{ checked: number; mismatches: ReconcileRow[] }> {
  if (!ctx.chain) throw new Error('Blockchain is not configured');
  const accounts = await ctx.prisma.escrowAccount.findMany({ include: { user: { select: { walletAddress: true } } } });
  const mismatches: ReconcileRow[] = [];
  for (const a of accounts) {
    const address = a.user.walletAddress;
    if (!address) continue;
    const onChain = await ctx.chain.getEscrow(address);
    const dbEscrow = toWei(a.onChainBalance);
    const dbPending = toWei(a.pendingWithdrawal);
    const diff = dbEscrow - onChain.escrow + (dbPending - onChain.pendingWithdrawal);
    if (dbEscrow !== onChain.escrow || dbPending !== onChain.pendingWithdrawal) {
      mismatches.push({ userId: a.userId, address, dbEscrow, chainEscrow: onChain.escrow, dbPending, chainPending: onChain.pendingWithdrawal, diff });
    }
  }
  return { checked: accounts.length, mismatches };
}

export { fromWei };
