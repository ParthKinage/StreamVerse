import { DOMAIN_EVENTS } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../middleware/errors';
import { isUniqueViolation } from '../common';
import { rebuildEscrowFromEvents } from '../indexer';
import { grantWelcomeReward, WELCOME_REASON } from '../rewards';
import { deriveAddress } from './hd';

/** True when the platform runs a built-in blockchain wallet for every account. */
export const isManaged = (ctx: Pick<AppContext, 'env'>): boolean => ctx.env.PAYMENTS_MODE === 'chain' && ctx.env.WALLET_MODE === 'managed';

export function requireManaged(ctx: AppContext): void {
  if (!isManaged(ctx)) throw new AppError(404, 'NOT_AVAILABLE_IN_THIS_MODE', 'This is only available with built-in wallets (WALLET_MODE=managed)');
}

function seed(ctx: AppContext): string {
  const value = ctx.env.WALLET_MASTER_SEED;
  if (!value) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Built-in wallets are not configured (WALLET_MASTER_SEED is missing)');
  return value;
}

/** Reserves the next wallet index for the user and works out its address. Safe to call concurrently. */
async function allocate(ctx: AppContext, userId: string): Promise<string> {
  const masterSeed = seed(ctx);
  try {
    return await ctx.prisma.$transaction(async (tx) => {
      const row = await tx.managedWallet.create({ data: { userId, address: `pending:${userId}` } });
      const address = deriveAddress(masterSeed, row.index);
      await tx.managedWallet.update({ where: { index: row.index }, data: { address } });
      return address;
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await ctx.prisma.managedWallet.findUnique({ where: { userId } });
    if (!existing) throw err;
    return existing.address;
  }
}

/**
 * Makes sure the user has a built-in wallet, that their account points at it, and that the welcome bonus has been
 * queued. Returns the wallet address. Does nothing new when everything is already in place.
 */
export async function ensureManagedWallet(ctx: AppContext, userId: string): Promise<string> {
  const existing = await ctx.prisma.managedWallet.findUnique({ where: { userId } });
  const address = existing?.address ?? (await allocate(ctx, userId));
  const user = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true } });
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'User no longer exists');
  if (user.walletAddress !== address) {
    await ctx.prisma.user.update({ where: { id: userId }, data: { walletAddress: address } });
    await rebuildEscrowFromEvents(ctx, userId, address);
    ctx.events.emit(DOMAIN_EVENTS.WALLET_LINKED, { userId, address });
  }
  // Checked every time, so a bonus that could not be queued earlier (a database blip) is not lost until a restart.
  const rewarded = await ctx.prisma.tokenReward.findUnique({ where: { userId_reason: { userId, reason: WELCOME_REASON } }, select: { id: true } });
  if (!rewarded) await grantWelcomeReward(ctx, userId, address);
  return address;
}

/**
 * Gives a wallet (and the one-time welcome bonus) to every account that does not have one yet: accounts created before
 * built-in wallets were switched on, seeded demo accounts, and everyone after the ledger was reset.
 */
export async function backfillManagedWallets(ctx: AppContext): Promise<{ created: number; bonuses: number }> {
  let created = 0;
  let bonuses = 0;
  const missing = await ctx.prisma.user.findMany({ where: { managedWallet: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  for (const u of missing) {
    await ensureManagedWallet(ctx, u.id);
    created += 1;
  }
  const withoutBonus = await ctx.prisma.user.findMany({
    where: { managedWallet: { isNot: null }, rewards: { none: { reason: 'WELCOME' } } },
    select: { id: true, managedWallet: { select: { address: true } } },
  });
  for (const u of withoutBonus) {
    if (u.managedWallet && (await grantWelcomeReward(ctx, u.id, u.managedWallet.address))) bonuses += 1;
  }
  return { created, bonuses };
}
