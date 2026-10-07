import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { walletApi } from '../api/endpoints';
import { keys, useConfig, useWalletSummary } from '../api/queries';
import { EarningsCard } from '../components/EarningsCard';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { strm, strmTitle, timeAgo, toBig } from '../lib/format';
import { BuyCoinsDialog } from './BuyCoinsDialog';

function Stat({ label, wei, strong = false, testId }: { label: string; wei: string | undefined; strong?: boolean; testId?: string }): JSX.Element {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <p className="muted small">{label}</p>
      {wei === undefined ? (
        <Skeleton className="line" />
      ) : (
        <p className="stat-value" title={strmTitle(wei)} data-testid={testId}>
          {strm(wei)} <span className="unit">STRM</span>
        </p>
      )}
    </div>
  );
}

const STATUS = { CONFIRMED: 'Confirmed', PENDING: 'On its way', FAILED: 'Failed' } as const;

/**
 * Wallet page when the platform runs a built-in blockchain wallet for every account: no browser extension, no gas.
 * Balances come from the blockchain through the API; every confirmed entry links to the public explorer.
 */
export function ManagedWallet(): JSX.Element {
  const { user } = useAuth();
  const { data: config } = useConfig();
  const toast = useToast();
  const summaryQ = useWalletSummary();
  const summary = summaryQ.data;
  const [buying, setBuying] = useState(false);
  const isCreator = user?.role === 'CREATOR' || user?.role === 'ADMIN' || Boolean(user?.channelName);
  const address = summary?.walletAddress ?? user?.walletAddress ?? null;
  const arriving = toBig(summary?.arrivingWei);

  const txs = useInfiniteQuery({
    queryKey: keys.transactions,
    refetchInterval: 10_000,
    queryFn: ({ pageParam }) => walletApi.transactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = txs.data?.pages.flatMap((p) => p.items) ?? [];

  const copy = async (): Promise<void> => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success('Wallet address copied');
    } catch {
      toast.info('Select the address and copy it');
    }
  };

  return (
    <div className="page">
      <h1>Wallet</h1>

      <section className="card" aria-label="Your wallet">
        <h2>Your blockchain wallet</h2>
        {address ? (
          <>
            <p>
              <code className="address" data-testid="wallet-address">
                {address}
              </code>
            </p>
            <div className="actions">
              <button type="button" className="btn small" onClick={() => void copy()}>
                Copy address
              </button>
              {config?.explorerUrl && config.chainId !== 31337 ? (
                <a className="btn small" href={`${config.explorerUrl}/address/${address}`} target="_blank" rel="noreferrer noopener">
                  View on {config.chainName} explorer
                </a>
              ) : null}
            </div>
          </>
        ) : (
          <p className="muted" role="status">
            Your wallet is being prepared. This takes a moment.
          </p>
        )}
        <p className="muted small">StreamVerse created this wallet for your account. You do not need a browser wallet or any gas: StreamVerse pays the network fees.</p>
      </section>

      <section className="card" aria-label="Balance">
        <h2>Balance</h2>
        {summaryQ.isError ? (
          <ErrorState message={errorMessage(summaryQ.error)} onRetry={() => void summaryQ.refetch()} />
        ) : (
          <div className="stats">
            <Stat label="Available to spend" wei={summary?.availableWei} strong testId="managed-available" />
            {arriving > 0n ? <Stat label="On its way" wei={summary?.arrivingWei} testId="managed-arriving" /> : null}
            <Stat label="Payments being confirmed" wei={summary?.unsettledChargesWei} />
          </div>
        )}
        {arriving > 0n ? (
          <p className="muted small" role="status">
            {strm(arriving)} STRM is being written to the blockchain and will be available in a few seconds.
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => setBuying(true)} disabled={!config} data-testid="buy-coins">
            Buy coins
          </button>
        </div>
      </section>

      {isCreator ? <EarningsCard /> : null}

      <section className="card" aria-label="Transactions">
        <h2>Transactions</h2>
        {txs.isPending ? (
          <Skeleton className="block" />
        ) : txs.isError ? (
          <ErrorState message={errorMessage(txs.error)} onRetry={() => void txs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No transactions yet">Coins you buy, videos you unlock and payouts show up here.</EmptyState>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const sign = t.type === 'SETTLEMENT' ? '−' : '+';
                  return (
                    <tr key={t.id} data-testid="tx-row">
                      <td>{timeAgo(t.createdAt)}</td>
                      <td>
                        {t.label}{' '}
                        {t.explorerUrl ? (
                          <a href={t.explorerUrl} target="_blank" rel="noreferrer noopener" aria-label={`View ${t.label} on the blockchain explorer`}>
                            ↗
                          </a>
                        ) : null}
                      </td>
                      <td className="num" title={strmTitle(t.amountWei)}>
                        {sign}
                        {strm(t.amountWei)} STRM
                      </td>
                      <td>{STATUS[t.status]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {txs.hasNextPage ? (
              <div className="center">
                <button type="button" className="btn" onClick={() => void txs.fetchNextPage()} disabled={txs.isFetchingNextPage}>
                  {txs.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {buying ? <BuyCoinsDialog onClose={() => setBuying(false)} /> : null}
    </div>
  );
}
