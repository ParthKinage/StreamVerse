import type { Prisma, PrismaClient } from '@tesor_gp/database';
import type { AppContext } from '../../context';
import { toWei } from '../common';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Demo-bank mode: earnings are everything the creator has been paid by settled sessions minus what they already
 * cashed out to a bank account. Pure database arithmetic, no chain involved.
 */
export async function claimableEarnings(_ctx: AppContext, db: Db, userId: string, creatorProfileId: string): Promise<bigint> {
  const [earned, paidOut] = await Promise.all([
    db.paymentSettlement.aggregate({ where: { creatorId: creatorProfileId, status: 'SETTLED' }, _sum: { creatorEarningsSTRM: true } }),
    db.ledgerEntry.aggregate({ where: { userId, type: 'CREATOR_PAYOUT' }, _sum: { amountSTRM: true } }),
  ]);
  const earnedWei = earned._sum.creatorEarningsSTRM ? toWei(earned._sum.creatorEarningsSTRM) : 0n;
  const paidWei = paidOut._sum.amountSTRM ? toWei(paidOut._sum.amountSTRM) : 0n;
  return earnedWei > paidWei ? earnedWei - paidWei : 0n;
}

/** Claimable earnings in whichever payments mode is active. Chain mode needs the linked wallet address. */
export async function claimableFor(ctx: AppContext, userId: string, creatorProfileId: string, walletAddress: string | null): Promise<bigint> {
  if (ctx.env.PAYMENTS_MODE === 'bank') return claimableEarnings(ctx, ctx.prisma, userId, creatorProfileId);
  return walletAddress ? getCreatorClaimable(ctx, creatorProfileId, walletAddress) : 0n;
}

/**
 * Claimable creator earnings = creator share of all settlements already applied on-chain
 * minus everything the creator has already claimed (EarningsClaimed events). Derived from indexed data, no RPC needed.
 */
export async function getCreatorClaimable(ctx: AppContext, creatorProfileId: string, address: string): Promise<bigint> {
  const [earned, claims] = await Promise.all([
    ctx.prisma.paymentSettlement.aggregate({
      where: { creatorId: creatorProfileId, escrowAppliedAt: { not: null } },
      _sum: { creatorEarningsSTRM: true },
    }),
    ctx.prisma.chainEvent.findMany({ where: { address: address.toLowerCase(), name: 'EarningsClaimed' }, select: { payload: true } }),
  ]);
  const earnedWei = earned._sum.creatorEarningsSTRM ? toWei(earned._sum.creatorEarningsSTRM) : 0n;
  const claimedWei = claims.reduce((sum, c) => sum + BigInt((c.payload as Record<string, string>).amount ?? '0'), 0n);
  const claimable = earnedWei - claimedWei;
  return claimable > 0n ? claimable : 0n;
}

export async function getLifetimeEarned(ctx: AppContext, creatorProfileId: string): Promise<bigint> {
  const agg = await ctx.prisma.paymentSettlement.aggregate({
    where: { creatorId: creatorProfileId, status: 'SETTLED' },
    _sum: { creatorEarningsSTRM: true },
  });
  return agg._sum.creatorEarningsSTRM ? toWei(agg._sum.creatorEarningsSTRM) : 0n;
}
