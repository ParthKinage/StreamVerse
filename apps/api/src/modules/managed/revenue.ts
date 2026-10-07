import { weiToString, type AdminRevenue } from '@tesor_gp/shared';
import type { AppContext } from '../../context';
import { toWei } from '../common';
import { getFeeBps } from '../settlement/settlement.service';
import { countPendingCredits } from './credits';
import { isManaged } from './wallets';

const sum = (v: { toFixed(): string } | null | undefined): bigint => (v ? toWei(v) : 0n);
const quick = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))]);
  } catch {
    return null;
  }
};

/** What the platform has earned from its commission, and the state of the wallet that pays the gas. */
export async function getRevenue(ctx: AppContext): Promise<AdminRevenue> {
  const [sales, coins, bonuses, pendingSettlements, pendingCredits, walletCount, feeBps] = await Promise.all([
    ctx.prisma.paymentSettlement.aggregate({ where: { status: 'SETTLED' }, _sum: { amountSTRM: true, platformFeeSTRM: true, creatorEarningsSTRM: true } }),
    ctx.prisma.coinOrder.aggregate({ where: { status: 'SENT' }, _sum: { amountSTRM: true } }),
    ctx.prisma.tokenReward.aggregate({ where: { status: 'SENT' }, _sum: { amountSTRM: true } }),
    ctx.prisma.paymentSettlement.count({ where: { status: 'PENDING' } }),
    countPendingCredits(ctx),
    ctx.prisma.managedWallet.count(),
    getFeeBps(ctx),
  ]);
  const chain = ctx.chain;
  const relayer = chain?.relayerAddress ?? null;
  const [onChainFees, gas, relayerCoins] = chain
    ? await Promise.all([
        quick(chain.getPlatformEarnings()),
        relayer ? quick(chain.getRelayerGasBalance()) : Promise.resolve(null),
        relayer ? quick(chain.getTokenBalance(relayer)) : Promise.resolve(null),
      ])
    : [null, null, null];
  const lowGasWei = BigInt(ctx.env.LOW_GAS_MILLI) * 10n ** 15n;
  return {
    paymentsMode: ctx.env.PAYMENTS_MODE,
    walletMode: isManaged(ctx) ? 'managed' : 'external',
    feeBps,
    grossSalesWei: weiToString(sum(sales._sum.amountSTRM)),
    platformFeesWei: weiToString(sum(sales._sum.platformFeeSTRM)),
    creatorEarningsWei: weiToString(sum(sales._sum.creatorEarningsSTRM)),
    platformFeesOnChainWei: onChainFees === null ? null : weiToString(onChainFees),
    coinsSoldWei: weiToString(sum(coins._sum.amountSTRM)),
    bonusesWei: weiToString(sum(bonuses._sum.amountSTRM)),
    pendingCredits,
    pendingSettlements,
    relayerAddress: relayer,
    relayerGasWei: gas === null ? null : weiToString(gas),
    relayerCoinsWei: relayerCoins === null ? null : weiToString(relayerCoins),
    lowGas: gas !== null && gas < lowGasWei,
    walletCount,
  };
}
