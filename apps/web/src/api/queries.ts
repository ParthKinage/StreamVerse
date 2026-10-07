import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { catalogApi, configApi, creatorApi, walletApi, watchApi } from './endpoints';

export const keys = {
  config: ['config'] as const,
  summary: ['wallet', 'summary'] as const,
  transactions: ['wallet', 'transactions'] as const,
  categories: ['categories'] as const,
  history: ['history'] as const,
  watchlist: ['watchlist'] as const,
  creatorVideos: ['creator', 'videos'] as const,
  creatorAnalytics: ['creator', 'analytics'] as const,
  creatorEarnings: ['creator', 'earnings'] as const,
  received: ['creator', 'received'] as const,
};

export function useConfig() {
  return useQuery({ queryKey: keys.config, queryFn: configApi.get, staleTime: 5 * 60_000 });
}

/**
 * Wallet balances come from the API summary. They refresh when the tab regains focus and after every action (the
 * actions invalidate this query), and are only polled while something is on its way: coins being credited or
 * charges waiting to settle. An idle signed-in tab sends no wallet requests.
 */
export function useWalletSummary(options: Partial<UseQueryOptions<Awaited<ReturnType<typeof walletApi.summary>>>> = {}) {
  const { user } = useAuth();
  return useQuery({
    queryKey: keys.summary,
    queryFn: walletApi.summary,
    enabled: Boolean(user),
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (summaryHasPending(q.state.data) ? 5_000 : false),
    staleTime: 5_000,
    ...options,
  });
}

export function useCategories() {
  return useQuery({ queryKey: keys.categories, queryFn: catalogApi.categories, staleTime: 60_000 });
}

export function useContinueWatching() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['continue-watching'], queryFn: watchApi.continueWatching, enabled: Boolean(user) });
}

export function useCreatorEarnings(enabled: boolean) {
  // Poll only while a payout is on its way.
  return useQuery({ queryKey: keys.creatorEarnings, queryFn: creatorApi.earnings, enabled, refetchOnWindowFocus: true, refetchInterval: (q) => (q.state.data?.payoutPending ? 5_000 : false) });
}

/** True when payments run on the blockchain and every account has a built-in wallet (no browser wallet, no gas). */
export function useManagedMode(): boolean {
  const { data } = useConfig();
  return data?.paymentsMode === 'chain' && data.walletMode === 'managed';
}

/** True when the app runs on the simulated bank wallet (no blockchain, no browser wallet). */
export function useBankMode(): boolean {
  const { data } = useConfig();
  return data?.paymentsMode === 'bank';
}

/** True while coins are being credited or charges are waiting to settle, so the balance is about to change. */
export function summaryHasPending(s: { arrivingWei?: string; unsettledChargesWei?: string } | undefined): boolean {
  if (!s) return false;
  return BigInt(s.arrivingWei ?? '0') > 0n || BigInt(s.unsettledChargesWei ?? '0') > 0n;
}
