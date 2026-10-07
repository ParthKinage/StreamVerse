import crypto from 'node:crypto';
import { verifyMessage } from 'ethers';
import {
  DOMAIN_EVENTS,
  MAX_RATE_PER_MINUTE_STRM,
  CATEGORIES,
  weiToString,
  type ConfigResponse,
  type NonceResponse,
  type UserDto,
  type WalletSummary,
  type WalletTransaction,
} from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { AppError, badRequest, conflict } from '../../middleware/errors';
import { decodeCursor, encodeCursor, isUniqueViolation, toWei, userToDto } from '../common';
import { claimableFor, getCreatorClaimable } from '../creator/earnings';
import { listBankAccounts } from '../bank/bank.service';
import { rebuildEscrowFromEvents } from '../indexer';
import { arrivingFor } from '../managed/coins';
import { isManaged } from '../managed/wallets';
import { grantWelcomeReward } from '../rewards';
import { peekFeeBps } from '../settlement/settlement.service';
import { getBalances } from './balance';

const NONCE_TTL_SEC = 300;
const nonceKey = (userId: string): string => `wallet:nonce:${userId}`;

export function linkMessage(params: { address: string; nonce: string; userId: string; chainId: number }): string {
  return [
    'StreamVerse wallet link',
    `Address: ${params.address.toLowerCase()}`,
    `Nonce: ${params.nonce}`,
    `User: ${params.userId}`,
    `Chain: ${params.chainId}`,
  ].join('\n');
}

function requireChainMode(ctx: AppContext): void {
  if (ctx.env.PAYMENTS_MODE !== 'chain') throw new AppError(404, 'NOT_AVAILABLE_IN_THIS_MODE', 'Wallet linking is not used in demo-bank mode');
  if (isManaged(ctx)) throw new AppError(404, 'NOT_AVAILABLE_IN_THIS_MODE', 'Every account already has a built-in wallet; there is nothing to link');
}

export async function createNonce(ctx: AppContext, userId: string, address: string): Promise<NonceResponse> {
  requireChainMode(ctx);
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = linkMessage({ address, nonce, userId, chainId: ctx.env.CHAIN_ID });
  await ctx.redis.set(nonceKey(userId), JSON.stringify({ nonce, address: address.toLowerCase() }), 'EX', NONCE_TTL_SEC);
  return { nonce, message, expiresInSec: NONCE_TTL_SEC };
}

export async function linkWallet(ctx: AppContext, userId: string, address: string, signature: string): Promise<UserDto> {
  requireChainMode(ctx);
  // GETDEL makes the nonce single-use even under concurrent requests.
  const raw = await ctx.redis.getdel(nonceKey(userId));
  if (!raw) throw badRequest('NONCE_EXPIRED', 'The signing request expired. Request a new nonce and sign again.');
  const stored = JSON.parse(raw) as { nonce: string; address: string };
  const lower = address.toLowerCase();
  if (stored.address !== lower) throw badRequest('INVALID_SIGNATURE', 'Address does not match the signing request');

  let recovered: string;
  try {
    recovered = verifyMessage(linkMessage({ address: lower, nonce: stored.nonce, userId, chainId: ctx.env.CHAIN_ID }), signature);
  } catch {
    throw badRequest('INVALID_SIGNATURE', 'Signature could not be verified');
  }
  if (recovered.toLowerCase() !== lower) throw badRequest('INVALID_SIGNATURE', 'Signature does not match the address');

  const user = await ctx.prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'User no longer exists');
  if (user.walletAddress && user.walletAddress !== lower) {
    throw conflict('WALLET_ALREADY_LINKED', 'Unlink your current wallet before linking another');
  }
  try {
    const updated = await ctx.prisma.user.update({
      where: { id: userId },
      data: { walletAddress: lower },
      include: { creatorProfile: { select: { channelName: true } } },
    });
    await rebuildEscrowFromEvents(ctx, userId, lower);
    if (!user.walletAddress) {
      ctx.events.emit(DOMAIN_EVENTS.WALLET_LINKED, { userId, address: lower });
      await grantWelcomeReward(ctx, userId, lower);
    }
    return userToDto(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('WALLET_IN_USE', 'This wallet is linked to another account');
    throw err;
  }
}

export async function unlinkWallet(ctx: AppContext, userId: string): Promise<UserDto> {
  if (isManaged(ctx)) throw new AppError(404, 'NOT_AVAILABLE_IN_THIS_MODE', 'Built-in wallets cannot be unlinked');
  const user = await ctx.prisma.user.findUnique({ where: { id: userId }, include: { creatorProfile: { select: { id: true, channelName: true } } } });
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'User no longer exists');
  if (!user.walletAddress) return userToDto(user);
  const b = await getBalances(ctx.prisma, userId);
  let creatorOwed = false;
  if (user.creatorProfile) {
    const claimable = await getCreatorClaimable(ctx, user.creatorProfile.id, user.walletAddress);
    const unsettled = await ctx.prisma.paymentSettlement.count({
      where: { creatorId: user.creatorProfile.id, OR: [{ status: 'PENDING' }, { status: 'SETTLED', escrowAppliedAt: null }] },
    });
    creatorOwed = claimable > 0n || unsettled > 0;
  }
  if (b.escrow > 0n || b.pending > 0n || b.unappliedCharges > 0n || b.openSessionCharges > 0n || creatorOwed) {
    throw conflict('WALLET_HAS_BALANCE', 'Withdraw escrow and claim earnings before unlinking this wallet');
  }
  const updated = await ctx.prisma.user.update({
    where: { id: userId },
    data: { walletAddress: null },
    include: { creatorProfile: { select: { channelName: true } } },
  });
  await ctx.prisma.escrowAccount.deleteMany({ where: { userId } });
  return userToDto(updated);
}

export async function getSummary(ctx: AppContext, userId: string): Promise<WalletSummary> {
  const user = await ctx.prisma.user.findUnique({ where: { id: userId }, include: { creatorProfile: { select: { id: true } } } });
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'User no longer exists');
  const b = await getBalances(ctx.prisma, userId);
  const claimable = user.creatorProfile ? await claimableFor(ctx, userId, user.creatorProfile.id, user.walletAddress) : 0n;
  // Bonuses and coin purchases on their way (both wallet modes); the demo bank has nothing in transit.
  const arriving = ctx.env.PAYMENTS_MODE === 'chain' ? await arrivingFor(ctx, userId) : 0n;
  return {
    walletAddress: user.walletAddress,
    escrowWei: weiToString(b.escrow),
    pendingWithdrawalWei: weiToString(b.pending),
    withdrawUnlockAt: b.withdrawUnlockAt ? b.withdrawUnlockAt.toISOString() : null,
    unsettledChargesWei: weiToString(b.unappliedCharges + b.openSessionCharges),
    availableWei: weiToString(b.available),
    creatorEarningsWei: weiToString(claimable),
    arrivingWei: weiToString(arriving),
  };
}

export function getConfig(ctx: AppContext): ConfigResponse {
  const chainName = ctx.env.CHAIN_ID === 80002 ? 'Polygon Amoy' : ctx.env.CHAIN_ID === 31337 ? 'Hardhat Local' : `Chain ${ctx.env.CHAIN_ID}`;
  const wei = (units: number): string => (BigInt(units) * 10n ** 18n).toString();
  const managed = isManaged(ctx);
  return {
    paymentsMode: ctx.env.PAYMENTS_MODE,
    walletMode: managed ? 'managed' : 'external',
    fiatSymbol: ctx.env.CURRENCY_SYMBOL,
    minPayoutWei: managed ? wei(ctx.env.MIN_PAYOUT_STRM) : '0',
    currencyCode: ctx.env.PAYMENTS_MODE === 'bank' ? ctx.env.CURRENCY_CODE : 'STRM',
    currencySymbol: ctx.env.PAYMENTS_MODE === 'bank' ? ctx.env.CURRENCY_SYMBOL : '',
    bankAccounts: ctx.env.PAYMENTS_MODE === 'bank' || managed ? listBankAccounts() : [],
    minTopUpWei: wei(ctx.env.BANK_MIN_TOPUP),
    // With built-in wallets one purchase can never exceed what the account may buy in a day.
    maxTopUpWei: wei(managed ? Math.min(ctx.env.BANK_MAX_TOPUP, ctx.env.TOPUP_DAILY_LIMIT_STRM) : ctx.env.BANK_MAX_TOPUP),
    chainId: ctx.env.CHAIN_ID,
    chainName,
    // Never the server's RPC URL: on a public chain that usually carries a private API key.
    rpcUrl: ctx.env.PUBLIC_RPC_URL ?? (ctx.env.CHAIN_ID === 31337 ? ctx.env.RPC_URL : ctx.env.CHAIN_ID === 80002 ? 'https://rpc-amoy.polygon.technology' : ''),
    explorerUrl: ctx.env.EXPLORER_URL,
    streamCoinAddress: ctx.deployment?.streamCoin ?? null,
    paymentRouterAddress: ctx.deployment?.paymentRouter ?? null,
    heartbeatIntervalSec: ctx.env.HEARTBEAT_INTERVAL_SEC,
    welcomeBonusWei: (BigInt(ctx.env.WELCOME_BONUS_STRM) * 10n ** 18n).toString(),
    withdrawDelaySec: ctx.deployment?.withdrawDelaySec ?? 900,
    feeBps: peekFeeBps(ctx),
    maxRatePerMinuteWei: (BigInt(MAX_RATE_PER_MINUTE_STRM) * 10n ** 18n).toString(),
    accessHours: ctx.env.ACCESS_HOURS,
    maxUploadMb: ctx.env.MAX_UPLOAD_MB,
    uploadMode: ctx.storage.kind === 's3' ? 'direct' : 'multipart',
    categories: [...CATEGORIES],
  };
}

const EVENT_LABELS: Record<string, { type: WalletTransaction['type']; label: string }> = {
  Deposited: { type: 'DEPOSIT', label: 'Deposit to escrow' },
  WithdrawRequested: { type: 'WITHDRAW_REQUESTED', label: 'Withdrawal requested' },
  WithdrawCancelled: { type: 'WITHDRAW_CANCELLED', label: 'Withdrawal cancelled' },
  Withdrawn: { type: 'WITHDRAW_EXECUTED', label: 'Withdrawal completed' },
  EarningsClaimed: { type: 'EARNINGS_CLAIMED', label: 'Earnings claimed' },
};
/** Built-in wallets: deposits are shown as the purchase or bonus that caused them, and viewers cannot withdraw. */
const MANAGED_EVENTS = ['EarningsClaimed'];

export async function listTransactions(
  ctx: AppContext,
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: WalletTransaction[]; nextCursor: string | null }> {
  if (ctx.env.PAYMENTS_MODE === 'bank') return listBankTransactions(ctx, userId, cursor, limit);
  const user = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true } });
  const before = decodeCursor<{ t: string }>(cursor);
  const beforeDate = before ? new Date(before.t) : undefined;
  const dateFilter = beforeDate ? { lt: beforeDate } : undefined;
  const explorer = (hash: string | null): string | null => (hash ? `${ctx.env.EXPLORER_URL}/tx/${hash}` : null);

  const managed = isManaged(ctx);
  const [events, settlements, rewards, orders] = await Promise.all([
    user?.walletAddress
      ? ctx.prisma.chainEvent.findMany({
          where: { address: user.walletAddress, name: { in: managed ? MANAGED_EVENTS : Object.keys(EVENT_LABELS) }, ...(dateFilter ? { createdAt: dateFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit + 1,
        })
      : Promise.resolve([]),
    ctx.prisma.paymentSettlement.findMany({
      where: { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: { video: { select: { title: true } } },
    }),
    ctx.prisma.tokenReward.findMany({
      where: { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    }),
    managed
      ? ctx.prisma.coinOrder.findMany({ where: { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) }, orderBy: { createdAt: 'desc' }, take: limit + 1 })
      : Promise.resolve([]),
  ]);
  const sent = (status: string): WalletTransaction['status'] => (status === 'SENT' ? 'CONFIRMED' : status === 'FAILED' ? 'FAILED' : 'PENDING');

  const all: Array<WalletTransaction & { sort: Date }> = [
    ...events.map((e) => {
      const meta = EVENT_LABELS[e.name] as { type: WalletTransaction['type']; label: string };
      const amount = (e.payload as Record<string, string>).amount ?? '0';
      const label = managed && e.name === 'EarningsClaimed' ? 'Earnings paid to your wallet' : meta.label;
      return { id: `evt-${e.id}`, type: meta.type, status: 'CONFIRMED' as const, amountWei: amount, txHash: e.txHash, explorerUrl: explorer(e.txHash), label, createdAt: e.createdAt.toISOString(), sort: e.createdAt };
    }),
    ...orders.map((o) => ({
      id: `buy-${o.id}`,
      type: 'DEPOSIT' as const,
      status: sent(o.status),
      amountWei: toWei(o.amountSTRM).toString(),
      txHash: o.txHash || null,
      explorerUrl: explorer(o.txHash || null),
      label: o.label,
      createdAt: o.createdAt.toISOString(),
      sort: o.createdAt,
    })),
    ...settlements.map((s) => ({
      id: `stl-${s.id}`,
      type: 'SETTLEMENT' as const,
      status: s.status === 'SETTLED' ? ('CONFIRMED' as const) : s.status === 'FAILED' ? ('FAILED' as const) : ('PENDING' as const),
      amountWei: toWei(s.amountSTRM).toString(),
      txHash: s.txHash,
      explorerUrl: explorer(s.txHash),
      label: `${s.sessionId ? 'Watched' : 'Unlocked'}: ${s.video.title}`,
      createdAt: s.createdAt.toISOString(),
      sort: s.createdAt,
    })),
    ...rewards.map((r) => ({
      id: `rwd-${r.id}`,
      type: 'REWARD' as const,
      status: sent(r.status),
      amountWei: toWei(r.amountSTRM).toString(),
      txHash: r.txHash || null,
      explorerUrl: explorer(r.txHash || null),
      label: r.reason === 'WELCOME' ? 'Welcome bonus' : 'Reward',
      createdAt: r.createdAt.toISOString(),
      sort: r.createdAt,
    })),
  ];
  all.sort((a, b) => b.sort.getTime() - a.sort.getTime());
  const page = all.slice(0, limit);
  const last = page[limit - 1];
  const nextCursor = all.length > limit && last ? encodeCursor({ t: last.sort.toISOString() }) : null;
  return { items: page.map(({ sort: _sort, ...rest }) => rest), nextCursor };
}

const LEDGER_TYPES: Record<string, WalletTransaction['type']> = {
  BANK_TOPUP: 'DEPOSIT',
  BANK_WITHDRAW: 'WITHDRAW_EXECUTED',
  CREATOR_PAYOUT: 'EARNINGS_CLAIMED',
};

/** Demo-bank history: bank deposits and withdrawals, creator cash-outs, and what was spent watching. */
async function listBankTransactions(
  ctx: AppContext,
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: WalletTransaction[]; nextCursor: string | null }> {
  const before = decodeCursor<{ t: string }>(cursor);
  const dateFilter = before ? { createdAt: { lt: new Date(before.t) } } : {};
  const [entries, settlements] = await Promise.all([
    ctx.prisma.ledgerEntry.findMany({ where: { userId, ...dateFilter }, orderBy: { createdAt: 'desc' }, take: limit + 1 }),
    ctx.prisma.paymentSettlement.findMany({
      where: { userId, ...dateFilter },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: { video: { select: { title: true } } },
    }),
  ]);
  const all: Array<WalletTransaction & { sort: Date }> = [
    ...entries.map((e) => ({
      id: `led-${e.id}`,
      type: LEDGER_TYPES[e.type] ?? ('DEPOSIT' as const),
      status: 'CONFIRMED' as const,
      amountWei: toWei(e.amountSTRM).toString(),
      txHash: null,
      explorerUrl: null,
      label: e.label,
      createdAt: e.createdAt.toISOString(),
      sort: e.createdAt,
    })),
    ...settlements.map((s) => ({
      id: `stl-${s.id}`,
      type: 'SETTLEMENT' as const,
      status: s.status === 'SETTLED' ? ('CONFIRMED' as const) : s.status === 'FAILED' ? ('FAILED' as const) : ('PENDING' as const),
      amountWei: toWei(s.amountSTRM).toString(),
      txHash: null,
      explorerUrl: null,
      label: `${s.sessionId ? 'Watched' : 'Unlocked'}: ${s.video.title}`,
      createdAt: s.createdAt.toISOString(),
      sort: s.createdAt,
    })),
  ];
  all.sort((a, b) => b.sort.getTime() - a.sort.getTime());
  const page = all.slice(0, limit);
  const last = page[limit - 1];
  const nextCursor = all.length > limit && last ? encodeCursor({ t: last.sort.toISOString() }) : null;
  return { items: page.map(({ sort: _sort, ...rest }) => rest), nextCursor };
}
