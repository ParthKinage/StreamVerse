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

/** Wallet balances come from the API summary; they refresh on focus and every 10 s so indexed chain events (bonuses, settlements) appear without a reload. */
export function useWalletSummary(options: Partial<UseQueryOptions<Awaited<ReturnType<typeof walletApi.summary>>>> = {}) {
  const { user } = useAuth();
  return useQuery({
    queryKey: keys.summary,
    queryFn: walletApi.summary,
    enabled: Boolean(user),
    refetchOnWindowFocus: true,
    refetchInterval: 10_000,
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
  return useQuery({ queryKey: keys.creatorEarnings, queryFn: creatorApi.earnings, enabled, refetchOnWindowFocus: true, refetchInterval: 10_000 });
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
