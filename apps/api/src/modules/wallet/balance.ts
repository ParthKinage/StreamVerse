import type { Prisma, PrismaClient } from '@tesor_gp/database';
import { toWei } from '../common';

type Db = PrismaClient | Prisma.TransactionClient;

export interface Balances {
  escrow: bigint;
  pending: bigint;
  withdrawUnlockAt: Date | null;
  /** Settlements created but not yet reflected in the indexed on-chain balance. */
  unappliedCharges: bigint;
  /** Charges accrued by sessions that are still open. */
  openSessionCharges: bigint;
  /** What the viewer can still spend: escrow minus everything owed. Never negative. */
  available: bigint;
}

/**
 * Available balance = indexed on-chain escrow − unapplied settlements − charges of open sessions.
 * Settlements stay "unapplied" until the indexer has seen their Settled event, so nothing is counted twice or missed.
 */
export async function getBalances(db: Db, userId: string): Promise<Balances> {
  const [escrow, unapplied, open] = await Promise.all([
    db.escrowAccount.findUnique({ where: { userId } }),
    db.paymentSettlement.aggregate({
      where: { userId, status: { in: ['PENDING', 'SETTLED'] }, escrowAppliedAt: null },
      _sum: { amountSTRM: true },
    }),
    db.watchSession.aggregate({ where: { userId, status: { in: ['ACTIVE', 'PAUSED'] } }, _sum: { chargedSTRM: true } }),
  ]);
  const escrowWei = escrow ? toWei(escrow.onChainBalance) : 0n;
  const unappliedWei = unapplied._sum.amountSTRM ? toWei(unapplied._sum.amountSTRM) : 0n;
  const openWei = open._sum.chargedSTRM ? toWei(open._sum.chargedSTRM) : 0n;
  const available = escrowWei - unappliedWei - openWei;
  return {
    escrow: escrowWei,
    pending: escrow ? toWei(escrow.pendingWithdrawal) : 0n,
    withdrawUnlockAt: escrow?.withdrawUnlockAt ?? null,
    unappliedCharges: unappliedWei,
    openSessionCharges: openWei,
    available: available > 0n ? available : 0n,
  };
}
