import { DEMO_BANK_ACCOUNTS, DEMO_DECLINED_ACCOUNT_ID, WEI_PER_STRM, weiToString, type BankMoneyRequest } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest } from '../../middleware/errors';
import { fromWei, toWei } from '../common';
import { enqueueCredits } from './credits';
import { ensureManagedWallet, requireManaged } from './wallets';

const DAY_MS = 24 * 3_600_000;
/** Namespace for the per-user advisory lock that serialises coin purchases. */
const PG_LOCK_NS = 7_340_021;

/**
 * Buys StreamCoins for the viewer's built-in wallet. Today the payment comes from a demo bank account (nothing real is
 * charged). A real payment gateway plugs in here: confirm the payment, then create the same CoinOrder.
 * The coins arrive once the relayer has written the order to the blockchain, usually within a few seconds.
 */
export async function buyCoins(ctx: AppContext, userId: string, req: BankMoneyRequest): Promise<{ orderId: string; amountWei: string }> {
  requireManaged(ctx);
  const account = DEMO_BANK_ACCOUNTS.find((a) => a.id === req.accountId);
  if (!account) throw badRequest('UNKNOWN_BANK_ACCOUNT', 'Choose one of the demo bank accounts');
  const amount = BigInt(req.amountWei);
  const min = BigInt(ctx.env.BANK_MIN_TOPUP) * WEI_PER_STRM;
  const max = BigInt(ctx.env.BANK_MAX_TOPUP) * WEI_PER_STRM;
  if (amount < min || amount > max) {
    throw badRequest('INVALID_AMOUNT', `Buy between ${ctx.env.BANK_MIN_TOPUP} and ${ctx.env.BANK_MAX_TOPUP} STRM at a time`, { minWei: weiToString(min), maxWei: weiToString(max) });
  }
  if (amount % (WEI_PER_STRM / 100n) !== 0n) throw badRequest('INVALID_AMOUNT', 'Use at most two decimal places');
  if (account.id === DEMO_DECLINED_ACCOUNT_ID) {
    throw new AppError(402, 'BANK_DECLINED', 'The bank declined this payment (this demo account always declines). Try another account.');
  }

  const dailyLimit = BigInt(ctx.env.TOPUP_DAILY_LIMIT_STRM) * WEI_PER_STRM;
  const walletAddress = await ensureManagedWallet(ctx, userId);
  // The limit check and the order are one step per user, so parallel requests cannot each slip under the limit.
  const order = await ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PG_LOCK_NS}, hashtext(${userId}))`;
    const recent = await tx.coinOrder.aggregate({
      where: { userId, status: { not: 'FAILED' }, createdAt: { gt: new Date(ctx.now().getTime() - DAY_MS) } },
      _sum: { amountSTRM: true },
    });
    const bought = recent._sum.amountSTRM ? toWei(recent._sum.amountSTRM) : 0n;
    if (bought + amount > dailyLimit) {
      throw new AppError(429, 'DAILY_LIMIT_REACHED', `You can buy up to ${ctx.env.TOPUP_DAILY_LIMIT_STRM} STRM in 24 hours`, {
        remainingWei: weiToString(dailyLimit > bought ? dailyLimit - bought : 0n),
      });
    }
    return tx.coinOrder.create({
      data: {
        userId,
        walletAddress,
        amountSTRM: fromWei(amount),
        provider: 'demo-bank',
        bankAccountId: account.id,
        label: `Bought with ${account.name} ••${account.last4}`,
      },
    });
  });
  await enqueueCredits(ctx);
  return { orderId: order.id, amountWei: weiToString(amount) };
}

/** Coins bought or granted to this user that are not on the blockchain yet. */
export async function arrivingFor(ctx: AppContext, userId: string): Promise<bigint> {
  const [orders, rewards] = await Promise.all([
    ctx.prisma.coinOrder.aggregate({ where: { userId, status: 'PENDING' }, _sum: { amountSTRM: true } }),
    ctx.prisma.tokenReward.aggregate({ where: { userId, status: 'PENDING', walletAddress: { not: null } }, _sum: { amountSTRM: true } }),
  ]);
  return (orders._sum.amountSTRM ? toWei(orders._sum.amountSTRM) : 0n) + (rewards._sum.amountSTRM ? toWei(rewards._sum.amountSTRM) : 0n);
}
