import { DOMAIN_EVENTS } from '@tesor_gp/shared';
import type { Prisma } from '@tesor_gp/database';
import type { ChainAdapter, ParsedChainLog } from '@tesor_gp/blockchain';
import type { AppContext } from '../../context';
import { fromWei, toWei } from '../common';
import { markSettlementSettled } from '../settlement';
import { EMPTY_ESCROW, ESCROW_EVENTS, foldEscrow, type EscrowState } from './escrow-fold';

const ADVISORY_LOCK_KEY = 7_340_001;

/**
 * Block ranges tried for eth_getLogs, largest first. Free RPC plans cap the range (Alchemy's free plan: 10 blocks), so
 * the indexer steps down until the RPC accepts a request, remembers that size, and steps back up after a run of
 * successes so a passing outage does not leave it crawling.
 */
export const RANGE_STEPS = [2000, 1000, 500, 100, 50, 10, 5, 1];
const GROW_AFTER_SUCCESSES = 50;
const rangeState = new WeakMap<AppContext, { range: number; successes: number; warned: boolean }>();

function stepsUpTo(max: number): number[] {
  const steps = RANGE_STEPS.filter((s) => s <= max);
  return steps.length && steps[0] === max ? steps : [max, ...steps];
}

/** Fetches logs from `from`, using the largest range the RPC accepts. Returns the logs and the last block covered. */
async function fetchLogs(ctx: AppContext, chain: ChainAdapter, from: number, safe: number): Promise<{ logs: ParsedChainLog[]; to: number }> {
  const steps = stepsUpTo(ctx.env.INDEXER_MAX_BLOCK_RANGE);
  const state = rangeState.get(ctx) ?? { range: steps[0] as number, successes: 0, warned: false };
  rangeState.set(ctx, state);
  if (state.successes >= GROW_AFTER_SUCCESSES && state.range < (steps[0] as number)) {
    state.range = steps[Math.max(0, steps.indexOf(state.range) - 1)] as number;
    state.successes = 0;
  }
  for (;;) {
    const to = Math.min(safe, from + state.range - 1);
    try {
      const logs = await chain.getLogs(from, to);
      state.successes += 1;
      return { logs, to };
    } catch (err) {
      const smaller = steps.find((s) => s < state.range);
      if (smaller === undefined) throw err;
      if (!state.warned) {
        ctx.logger.warn({ from: state.range, to: smaller, err: (err as Error).message }, 'RPC refused the log range; using smaller ranges');
        state.warned = true;
      }
      state.range = smaller;
      state.successes = 0;
    }
  }
}

type Tx = Prisma.TransactionClient;

function toState(row: { onChainBalance: { toFixed(): string }; pendingWithdrawal: { toFixed(): string }; withdrawUnlockAt: Date | null } | null): EscrowState {
  if (!row) return { ...EMPTY_ESCROW };
  return {
    escrow: toWei(row.onChainBalance),
    pending: toWei(row.pendingWithdrawal),
    unlockAt: row.withdrawUnlockAt ? Math.floor(row.withdrawUnlockAt.getTime() / 1000) : null,
  };
}

async function writeState(tx: Tx, userId: string, state: EscrowState, block: bigint): Promise<void> {
  const data = {
    onChainBalance: fromWei(state.escrow),
    pendingWithdrawal: fromWei(state.pending),
    withdrawUnlockAt: state.unlockAt ? new Date(state.unlockAt * 1000) : null,
    updatedAtBlock: block,
  };
  await tx.escrowAccount.upsert({ where: { userId }, update: data, create: { userId, ...data } });
}

async function applyLog(ctx: AppContext, tx: Tx, log: ParsedChainLog): Promise<void> {
  if (log.name === 'Settled') {
    const settlement = await tx.paymentSettlement.findUnique({ where: { settlementKey: log.args.id as string } });
    if (settlement && !settlement.escrowAppliedAt) {
      const amount = BigInt(log.args.amount as string);
      const fee = BigInt(log.args.fee as string);
      await tx.paymentSettlement.update({
        where: { id: settlement.id },
        data: { escrowAppliedAt: ctx.now(), platformFeeSTRM: fromWei(fee), creatorEarningsSTRM: fromWei(amount - fee), amountSTRM: fromWei(amount) },
      });
    }
    if (settlement) await markSettlementSettled(ctx, tx, settlement.id, log.txHash);
  }
  if (!ESCROW_EVENTS.has(log.name) || !log.address) return;
  const user = await tx.user.findUnique({ where: { walletAddress: log.address }, select: { id: true, escrowAccount: true } });
  if (!user) return; // address not linked yet; replayed from ChainEvent when the wallet is linked
  const next = foldEscrow(toState(user.escrowAccount), log.name, log.args);
  await writeState(tx, user.id, next, BigInt(log.blockNumber));
  ctx.events.emit(DOMAIN_EVENTS.ESCROW_UPDATED, { userId: user.id });
}

/** Stores one log and applies it. Returns false if the log was already processed (idempotent). */
async function ingestLog(ctx: AppContext, tx: Tx, log: ParsedChainLog): Promise<boolean> {
  // ON CONFLICT DO NOTHING: a duplicate must not abort the surrounding transaction.
  const inserted = await tx.chainEvent.createMany({
    data: [
      {
        txHash: log.txHash,
        logIndex: log.logIndex,
        name: log.name,
        address: log.address,
        blockNumber: BigInt(log.blockNumber),
        payload: log.args as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return false;
  await applyLog(ctx, tx, log);
  await tx.chainEvent.updateMany({ where: { txHash: log.txHash, logIndex: log.logIndex }, data: { processedAt: ctx.now() } });
  return true;
}

export async function indexOnce(ctx: AppContext): Promise<{ processed: number; cursor: number; behind: boolean }> {
  const chain = ctx.chain;
  const deployment = ctx.deployment;
  if (!chain || !deployment) return { processed: 0, cursor: 0, behind: false };

  const contract = deployment.paymentRouter.toLowerCase();
  const key = { chainId_contract: { chainId: ctx.env.CHAIN_ID, contract } };
  const cursorRow = await ctx.prisma.chainCursor.findUnique({ where: key });
  const last = cursorRow ? Number(cursorRow.lastProcessedBlock) : Math.max(0, deployment.deploymentBlock - 1);

  const head = await chain.getBlockNumber();
  const safe = head - ctx.env.CONFIRMATIONS + 1;
  if (safe <= last) return { processed: 0, cursor: last, behind: false };
  const from = last + 1;
  const { logs, to } = await fetchLogs(ctx, chain, from, safe);
  let processed = 0;
  await ctx.prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      for (const log of logs) if (await ingestLog(ctx, tx, log)) processed += 1;
      await tx.chainCursor.upsert({
        where: key,
        update: { lastProcessedBlock: BigInt(to) },
        create: { chainId: ctx.env.CHAIN_ID, contract, lastProcessedBlock: BigInt(to) },
      });
    },
    { timeout: 30_000 },
  );
  return { processed, cursor: to, behind: to < safe };
}

/** Catches up until the cursor reaches the safe head (used at startup and in tests). */
export async function indexUntilCaughtUp(ctx: AppContext): Promise<void> {
  if (!ctx.chain) return;
  for (let i = 0; i < 100_000; i++) {
    const { behind } = await indexOnce(ctx);
    if (!behind) return;
  }
}

/** Replays every stored chain event for `address` into the user's escrow account (called when a wallet is linked). */
export async function rebuildEscrowFromEvents(ctx: AppContext, userId: string, address: string): Promise<void> {
  await ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
    const events = await tx.chainEvent.findMany({
      where: { address: address.toLowerCase(), name: { in: [...ESCROW_EVENTS] } },
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
    });
    let state: EscrowState = { ...EMPTY_ESCROW };
    let block = 0n;
    for (const e of events) {
      state = foldEscrow(state, e.name, e.payload as Record<string, string>);
      block = e.blockNumber;
    }
    await writeState(tx, userId, state, block);
  });
}

export interface IndexerHandle {
  stop(): Promise<void>;
}

/** Polling loop. RPC failures are logged and retried with backoff; playback continues on the last known balance. */
const CATCH_UP_BUDGET_MS = 10_000;

export function startIndexer(ctx: AppContext, intervalMs = 2000): IndexerHandle {
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // While behind (after a restart, or with an RPC that only allows small ranges) keep reading for up to
      // CATCH_UP_BUDGET_MS instead of one range per tick, so balances catch up in minutes, not hours.
      const started = Date.now();
      let processed = 0;
      let result: Awaited<ReturnType<typeof indexOnce>>;
      do {
        result = await indexOnce(ctx);
        processed += result.processed;
      } while (result.behind && !stopped && Date.now() - started < CATCH_UP_BUDGET_MS);
      if (processed > 0) ctx.logger.debug({ processed }, 'indexed chain events');
      failures = 0;
    } catch (err) {
      failures += 1;
      ctx.logger.warn({ err: (err as Error).message, failures }, 'chain indexer error; will retry');
    }
    if (!stopped) timer = setTimeout(() => void (running = tick()), Math.min(intervalMs * 2 ** Math.min(failures, 5), 30_000));
  };
  running = tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
