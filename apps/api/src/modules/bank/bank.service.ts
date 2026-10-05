import {
  DEMO_BANK_ACCOUNTS,
  DEMO_DECLINED_ACCOUNT_ID,
  WEI_PER_STRM,
  weiToString,
  type BankAccountDto,
  type BankMoneyRequest,
  type ReceivedPaymentsResponse,
} from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest, forbidden } from '../../middleware/errors';
import { decodeCursor, encodeCursor, fromWei, toWei } from '../common';
import { claimableEarnings } from '../creator/earnings';
import { processBankSettlements } from '../settlement/settlement.service';
import { getBalances } from '../wallet/balance';

/** Namespace for the per-user advisory lock that serialises wallet balance changes. */
const PG_LOCK_NS = 7_340_011;

export const isBankMode = (ctx: Pick<AppContext, 'env'>): boolean => ctx.env.PAYMENTS_MODE === 'bank';

function requireBankMode(ctx: AppContext): void {
  if (!isBankMode(ctx)) throw new AppError(404, 'NOT_AVAILABLE_IN_THIS_MODE', 'The demo bank is only available when PAYMENTS_MODE=bank');
}

export function listBankAccounts(): BankAccountDto[] {
  return DEMO_BANK_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, last4: a.last4, kind: a.kind }));
}

function accountById(id: string): BankAccountDto {
  const account = listBankAccounts().find((a) => a.id === id);
  if (!account) throw badRequest('UNKNOWN_BANK_ACCOUNT', 'Choose one of the demo bank accounts');
  return account;
}

const describe = (a: BankAccountDto): string => `${a.name} ••${a.last4}`;

function limits(ctx: AppContext): { min: bigint; max: bigint } {
  return { min: BigInt(ctx.env.BANK_MIN_TOPUP) * WEI_PER_STRM, max: BigInt(ctx.env.BANK_MAX_TOPUP) * WEI_PER_STRM };
}

type Tx = Parameters<Parameters<AppContext['prisma']['$transaction']>[0]>[0];
const lockUser = (tx: Tx, userId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${PG_LOCK_NS}, hashtext(${userId}))`;

/** "Add money": moves money from a dummy bank account into the viewer's wallet balance. Nothing real is charged. */
export async function topUp(ctx: AppContext, userId: string, req: BankMoneyRequest): Promise<void> {
  requireBankMode(ctx);
  const account = accountById(req.accountId);
  const amount = BigInt(req.amountWei);
  const { min, max } = limits(ctx);
  if (amount < min || amount > max) {
    throw badRequest('INVALID_AMOUNT', `Enter an amount between ${ctx.env.CURRENCY_SYMBOL}${ctx.env.BANK_MIN_TOPUP} and ${ctx.env.CURRENCY_SYMBOL}${ctx.env.BANK_MAX_TOPUP}`, {
      minWei: weiToString(min),
      maxWei: weiToString(max),
    });
  }
  if (account.id === DEMO_DECLINED_ACCOUNT_ID) {
    throw new AppError(402, 'BANK_DECLINED', 'The bank declined this payment (this demo account always declines). Try another account.');
  }
  await ctx.prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    await tx.escrowAccount.upsert({
      where: { userId },
      create: { userId, onChainBalance: fromWei(amount) },
      update: { onChainBalance: { increment: fromWei(amount) } },
    });
    await tx.ledgerEntry.create({
      data: { userId, type: 'BANK_TOPUP', amountSTRM: fromWei(amount), bankAccountId: account.id, label: `Added from ${describe(account)}` },
    });
  });
}

/** Sends money from the wallet balance back to a dummy bank account. Only unspent, unreserved money can leave. */
export async function withdrawToBank(ctx: AppContext, userId: string, req: BankMoneyRequest): Promise<void> {
  requireBankMode(ctx);
  const account = accountById(req.accountId);
  const amount = BigInt(req.amountWei);
  if (amount <= 0n) throw badRequest('INVALID_AMOUNT', 'Enter an amount greater than zero');
  await ctx.prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const { available } = await getBalances(tx, userId);
    if (amount > available) {
      throw new AppError(402, 'INSUFFICIENT_BALANCE', 'You can only withdraw money that is not being used by what you are watching', {
        availableWei: weiToString(available),
      });
    }
    await tx.escrowAccount.update({ where: { userId }, data: { onChainBalance: { decrement: fromWei(amount) } } });
    await tx.ledgerEntry.create({
      data: { userId, type: 'BANK_WITHDRAW', amountSTRM: fromWei(amount), bankAccountId: account.id, label: `Withdrawn to ${describe(account)}` },
    });
  });
}

/** Creator cash-out: pays all received earnings out to a dummy bank account. */
export async function cashOutEarnings(ctx: AppContext, userId: string, accountId: string): Promise<{ amountWei: string }> {
  requireBankMode(ctx);
  const account = accountById(accountId);
  const profile = await ctx.prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw forbidden('Create a creator profile first', 'NOT_CREATOR');
  return ctx.prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const claimable = await claimableEarnings(ctx, tx, userId, profile.id);
    if (claimable <= 0n) throw badRequest('INVALID_AMOUNT', 'You have no earnings to cash out yet');
    await tx.ledgerEntry.create({
      data: { userId, type: 'CREATOR_PAYOUT', amountSTRM: fromWei(claimable), bankAccountId: account.id, label: `Earnings cashed out to ${describe(account)}` },
    });
    return { amountWei: weiToString(claimable) };
  });
}

/** What the creator has been paid by viewers, newest first: "x amount received from <viewer> for <video>". */
export async function listReceived(ctx: AppContext, userId: string, cursor: string | undefined, limit: number): Promise<ReceivedPaymentsResponse> {
  const profile = await ctx.prisma.creatorProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw forbidden('Create a creator profile first', 'NOT_CREATOR');
  const before = decodeCursor<{ t: string }>(cursor);
  const rows = await ctx.prisma.paymentSettlement.findMany({
    where: { creatorId: profile.id, status: 'SETTLED', ...(before ? { createdAt: { lt: new Date(before.t) } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: { video: { select: { title: true } }, user: { select: { username: true } } },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      amountWei: toWei(r.creatorEarningsSTRM).toString(),
      videoTitle: r.video.title,
      viewerName: r.user.username,
      receivedAt: (r.settledAt ?? r.createdAt).toISOString(),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.createdAt.toISOString() }) : null,
  };
}

/** Settles finished sessions inside the database. Sweeps every few seconds so nothing stays pending after a crash. */
export function startBankSettler(ctx: AppContext, everyMs = 5_000): { stop(): void } {
  const tick = async (): Promise<void> => {
    try {
      await processBankSettlements(ctx);
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'bank settlement sweep failed');
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  void tick();
  return { stop: () => clearInterval(timer) };
}
