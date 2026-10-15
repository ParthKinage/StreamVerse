import type { Prisma, PrismaClient } from '@tesor_gp/database';
import { toWei } from '../common';

type Db = PrismaClient | Prisma.TransactionClient;

export interface Balances {
  escrow: bigint;
  /** Coins bought or granted that are not on the chain yet (or not read back yet). Spendable at once. */
  incoming: bigint;
  pending: bigint;
  withdrawUnlockAt: Date | null;
  /** Settlements created but not yet reflected in the indexed on-chain balance. */
  unappliedCharges: bigint;
  /** Charges accrued by sessions that are still open. */
  openSessionCharges: bigint;
  /** What the viewer can still spend: escrow minus everything owed. Never negative. */
  available: bigint;
}

const INCOMING_WINDOW_MS = 24 * 3_600_000;

/**
 * Coin purchases and bonuses that the platform has promised but the indexer has not yet seen arrive on the chain:
 * waiting to be sent, or sent and not yet read back. They count as spendable straight away, so buying coins and the
 * welcome bonus feel instant; the blockchain record follows a few seconds later (sooner or later depending on gas).
 * Payments from a viewer with coins still on the way wait until those coins have landed (see processSettlements).
 */
export async function incomingCredits(db: Db, userIds: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!userIds.length) return out;
  const since = new Date(Date.now() - INCOMING_WINDOW_MS);
  const where = { userId: { in: userIds }, OR: [{ status: 'PENDING' as const }, { status: 'SENT' as const, createdAt: { gte: since } }] };
  const [orders, rewards] = await Promise.all([
    db.coinOrder.findMany({ where, select: { userId: true, status: true, txHash: true, amountSTRM: true } }),
    db.tokenReward.findMany({ where: { ...where, walletAddress: { not: null } }, select: { userId: true, status: true, txHash: true, amountSTRM: true } }),
  ]);
  const rows = [...orders, ...rewards];
  const hashes = rows.filter((r) => r.status === 'SENT' && r.txHash).map((r) => r.txHash as string);
  const landed = hashes.length
    ? new Set((await db.chainEvent.findMany({ where: { txHash: { in: hashes }, name: 'Deposited' }, select: { txHash: true } })).map((e) => e.txHash))
    : new Set<string>();
  for (const r of rows) {
    if (r.status === 'SENT' && r.txHash && landed.has(r.txHash)) continue;
    out.set(r.userId, (out.get(r.userId) ?? 0n) + toWei(r.amountSTRM));
  }
  return out;
}

/**
 * Available balance = indexed on-chain escrow + coins on their way − unapplied settlements − charges of open sessions.
 * Settlements stay "unapplied" until the indexer has seen their Settled event, so nothing is counted twice or missed.
 */
export async function getBalances(db: Db, userId: string): Promise<Balances> {
  const [escrow, unapplied, open, incomingByUser] = await Promise.all([
    db.escrowAccount.findUnique({ where: { userId } }),
    db.paymentSettlement.aggregate({
      where: { userId, status: { in: ['PENDING', 'SETTLED'] }, escrowAppliedAt: null },
      _sum: { amountSTRM: true },
    }),
    db.watchSession.aggregate({ where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } }, _sum: { chargedSTRM: true } }),
    incomingCredits(db, [userId]),
  ]);
  const incomingWei = incomingByUser.get(userId) ?? 0n;
  const escrowWei = escrow ? toWei(escrow.onChainBalance) : 0n;
  const unappliedWei = unapplied._sum.amountSTRM ? toWei(unapplied._sum.amountSTRM) : 0n;
  const openWei = open._sum.chargedSTRM ? toWei(open._sum.chargedSTRM) : 0n;
  const available = escrowWei + incomingWei - unappliedWei - openWei;
  return {
    escrow: escrowWei,
    incoming: incomingWei,
    pending: escrow ? toWei(escrow.pendingWithdrawal) : 0n,
    withdrawUnlockAt: escrow?.withdrawUnlockAt ?? null,
    unappliedCharges: unappliedWei,
    openSessionCharges: openWei,
    available: available > 0n ? available : 0n,
  };
}
