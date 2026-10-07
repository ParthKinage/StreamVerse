import type { AppContext } from '../../context';

const KEY = 'ledgerScope';

/** Names the ledger the money tables describe: the demo bank, or one payment contract on one chain. */
export function currentLedgerScope(ctx: AppContext): string | undefined {
  if (ctx.env.PAYMENTS_MODE === 'bank') return 'bank';
  if (!ctx.deployment) return undefined; // chain mode without contract addresses: nothing to compare yet
  return `chain:${ctx.env.CHAIN_ID}:${ctx.deployment.paymentRouter.toLowerCase()}`;
}

async function hasMoneyRows(ctx: AppContext): Promise<boolean> {
  const [settlements, escrow, ledger, rewards, orders] = await Promise.all([
    ctx.prisma.paymentSettlement.count(),
    ctx.prisma.escrowAccount.count(),
    ctx.prisma.ledgerEntry.count(),
    ctx.prisma.tokenReward.count(),
    ctx.prisma.coinOrder.count(),
  ]);
  return settlements + escrow + ledger + rewards + orders > 0;
}

/** Removes every balance and payment record. Accounts, channels, videos and wallet addresses are kept. */
export async function resetLedger(ctx: AppContext): Promise<void> {
  await ctx.prisma.$transaction(async (tx) => {
    await tx.videoPurchase.deleteMany();
    await tx.paymentSettlement.deleteMany();
    await tx.watchHeartbeat.deleteMany();
    await tx.watchSession.deleteMany();
    await tx.tokenReward.deleteMany();
    await tx.coinOrder.deleteMany();
    await tx.escrowAccount.deleteMany();
    await tx.ledgerEntry.deleteMany();
    await tx.chainEvent.deleteMany();
    await tx.chainCursor.deleteMany();
    await tx.creatorProfile.updateMany({ data: { totalEarnings: 0 } });
  });
}

export type LedgerCheck = 'unchanged' | 'recorded' | 'reset' | 'mismatch' | 'skipped';

/**
 * Balances and payments in the database belong to one ledger. When the app is switched to another one (demo bank to
 * blockchain, a different chain, or a newly deployed contract) the old records no longer match reality.
 * Simulated demo-bank records are always cleared when the app moves to a blockchain. Records of a real ledger are only
 * cleared with LEDGER_RESET_ON_CHANGE=true; otherwise the mismatch is reported and nothing is touched.
 */
export async function ensureLedgerScope(ctx: AppContext): Promise<LedgerCheck> {
  const scope = currentLedgerScope(ctx);
  if (!scope) return 'skipped';
  const stored = await ctx.prisma.appSetting.findUnique({ where: { key: KEY } });
  const save = (): Promise<unknown> => ctx.prisma.appSetting.upsert({ where: { key: KEY }, update: { value: scope }, create: { key: KEY, value: scope } });

  if (stored?.value === scope) return 'unchanged';

  // Without a record (first start with this check) the old ledger is worked out from the data: nothing was ever
  // indexed from a chain while the demo bank was in use.
  const neverOnChain = (await ctx.prisma.chainEvent.count()) === 0;
  if (!stored) {
    const cursor = ctx.deployment
      ? await ctx.prisma.chainCursor.findUnique({ where: { chainId_contract: { chainId: ctx.env.CHAIN_ID, contract: ctx.deployment.paymentRouter.toLowerCase() } } })
      : null;
    // The demo bank is the only mode that writes ledger entries, so their presence means the data is the bank's.
    const sameLedger = scope === 'bank' ? neverOnChain || (await ctx.prisma.ledgerEntry.count()) > 0 : Boolean(cursor);
    if (sameLedger || !(await hasMoneyRows(ctx))) {
      await save();
      return 'recorded';
    }
  }

  // Leaving the demo bank is always safe to clean up: its money was simulated and never existed anywhere else.
  // Unrecorded data counts as the bank's only when nothing chain-related exists: no indexed events and no token
  // rewards (those are only ever created for a blockchain wallet).
  const leavingDemoBank = scope !== 'bank' && (stored ? stored.value === 'bank' : neverOnChain && (await ctx.prisma.tokenReward.count()) === 0);
  if (!ctx.env.LEDGER_RESET_ON_CHANGE && !leavingDemoBank) {
    ctx.logger.error(
      { expected: scope, found: stored?.value ?? 'unknown' },
      'The database holds balances and payments from a different ledger. Set LEDGER_RESET_ON_CHANGE=true once to clear them, or point the app back at the old ledger.',
    );
    return 'mismatch';
  }
  await resetLedger(ctx);
  await save();
  ctx.logger.warn({ from: stored?.value ?? 'unknown', to: scope }, 'Ledger changed: cleared old balances and payment records');
  return 'reset';
}
