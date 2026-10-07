import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import { adminApi } from '../api/endpoints';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { useConfig } from '../api/queries';
import { money, moneyTitle, shortAddress, strm, timeAgo } from '../lib/format';

type Tab = 'revenue' | 'health' | 'settlements' | 'videos' | 'users';

function Health(): JSX.Element {
  const q = useQuery({ queryKey: ['admin', 'health'], queryFn: adminApi.health, refetchInterval: 10_000 });
  if (q.isPending) return <Skeleton className="block" />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const h = q.data;
  return (
    <div>
      <p>
        Overall status: <strong data-testid="health-status">{h.status}</strong>
      </p>
      <ul className="kv">
        {(['postgres', 'redis', 'chain', 'ai'] as const).map((k) => (
          <li key={k}>
            <span>{k}</span> <strong>{h[k]}</strong>
          </li>
        ))}
      </ul>
      {h.details ? <pre className="code">{JSON.stringify(h.details, null, 2)}</pre> : null}
    </div>
  );
}

function Figure({ label, value, title, strong = false, testId }: { label: string; value: string; title?: string; strong?: boolean; testId?: string }): JSX.Element {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <p className="muted small">{label}</p>
      <p className="stat-value" title={title} data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

/** What the platform earns from its commission, and whether the wallet that pays the network fees needs topping up. */
function Revenue(): JSX.Element {
  const { data: config } = useConfig();
  const q = useQuery({ queryKey: ['admin', 'revenue'], queryFn: adminApi.revenue, refetchInterval: 15_000 });
  if (q.isPending) return <Skeleton className="block" />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const r = q.data;
  const gasCoin = config?.chainId === 80002 || config?.chainId === 137 ? 'POL' : 'ETH';
  const onChain = r.paymentsMode === 'chain';
  return (
    <div>
      <section className="card" aria-label="Earnings">
        <h2>Platform earnings</h2>
        <p className="muted small">
          StreamVerse keeps <strong data-testid="revenue-commission">{r.feeBps / 100}%</strong> of every video sale. The rest goes to the creator.
        </p>
        <div className="stats">
          <Figure label="Commission earned" value={money(r.platformFeesWei)} title={moneyTitle(r.platformFeesWei)} strong testId="revenue-fees" />
          <Figure label="Video sales" value={money(r.grossSalesWei)} title={moneyTitle(r.grossSalesWei)} testId="revenue-sales" />
          <Figure label="Paid to creators" value={money(r.creatorEarningsWei)} title={moneyTitle(r.creatorEarningsWei)} />
          {onChain ? <Figure label="Ready to withdraw" value={r.platformFeesOnChainWei === null ? 'Unavailable' : money(r.platformFeesOnChainWei)} /> : null}
        </div>
        {onChain ? <p className="muted small">The commission is held by the payment contract. Its admin withdraws it to the treasury with the platform:withdraw-fees command.</p> : null}
      </section>

      {r.walletMode === 'managed' ? (
        <section className="card" aria-label="Wallets and coins">
          <h2>Coins and wallets</h2>
          <div className="stats">
            <Figure label="Coins sold" value={money(r.coinsSoldWei)} title={moneyTitle(r.coinsSoldWei)} testId="revenue-coins-sold" />
            <Figure label="Bonuses given" value={money(r.bonusesWei)} title={moneyTitle(r.bonusesWei)} />
            <Figure label="Built-in wallets" value={String(r.walletCount)} />
            <Figure label="Coins left to sell" value={r.relayerCoinsWei === null ? 'Unavailable' : money(r.relayerCoinsWei)} />
          </div>
        </section>
      ) : null}

      {onChain ? (
        <section className="card" aria-label="Platform wallet">
          <h2>Platform wallet</h2>
          <p className="muted small">This wallet pays the blockchain fees for everyone. Keep it topped up with {gasCoin}.</p>
          <div className="stats">
            <Figure label={`Gas balance (${gasCoin})`} value={r.relayerGasWei === null ? 'Unavailable' : strm(r.relayerGasWei)} strong testId="revenue-gas" />
            <Figure label="Purchases waiting" value={String(r.pendingCredits)} />
            <Figure label="Payments waiting" value={String(r.pendingSettlements)} />
          </div>
          {r.lowGas ? (
            <p className="notice" role="alert" data-testid="revenue-low-gas">
              The platform wallet is nearly out of gas. Send {gasCoin} to <code>{r.relayerAddress}</code> or purchases and payouts will stop being confirmed.
            </p>
          ) : null}
          {r.relayerAddress ? (
            <p className="muted small">
              Address: <code className="address">{r.relayerAddress}</code>
              {config?.explorerUrl ? (
                <>
                  {' '}
                  <a href={`${config.explorerUrl}/address/${r.relayerAddress}`} target="_blank" rel="noreferrer noopener">
                    View on explorer
                  </a>
                </>
              ) : null}
            </p>
          ) : (
            <p className="notice">No platform wallet is configured, so nothing can be written to the blockchain.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Settlements(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'settlements', status],
    queryFn: ({ pageParam }) => adminApi.settlements(status || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <label className="inline">
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="PENDING">Pending</option>
          <option value="SETTLED">Settled</option>
          <option value="FAILED">Failed</option>
        </select>
      </label>
      {q.isPending ? (
        <Skeleton className="block" />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No settlements" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Detail</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>{timeAgo(s.createdAt)}</td>
                <td className="num" title={moneyTitle(s.amountWei)}>
                  {money(s.amountWei)}
                </td>
                <td>{s.status}</td>
                <td>{s.attempts}</td>
                <td className="small">{s.lastError ?? (s.txHash ? shortAddress(s.txHash) : '')}</td>
                <td>
                  {s.status === 'FAILED' ? (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        void adminApi
                          .retrySettlement(s.id)
                          .then(() => {
                            toast.success('Settlement queued for retry');
                            return qc.invalidateQueries({ queryKey: ['admin', 'settlements'] });
                          })
                          .catch((err) => toast.error(errorMessage(err)))
                      }
                    >
                      Retry
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.hasNextPage ? (
        <button type="button" className="btn" onClick={() => void q.fetchNextPage()}>
          Load more
        </button>
      ) : null}
    </div>
  );
}

function Videos(): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'videos', term],
    queryFn: ({ pageParam }) => adminApi.videos(term || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <label className="inline">
        Search <input value={term} onChange={(e) => setTerm(e.target.value)} />
      </label>
      {q.isPending ? (
        <Skeleton className="block" />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No videos" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Channel</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id}>
                <td>{v.title}</td>
                <td>{v.creator.channelName}</td>
                <td>{v.isPublished ? 'Published' : v.processingStatus}</td>
                <td>
                  {v.isPublished ? (
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={() =>
                        void adminApi
                          .unpublish(v.id)
                          .then(() => {
                            toast.success('Video unpublished');
                            return qc.invalidateQueries({ queryKey: ['admin', 'videos'] });
                          })
                          .catch((err) => toast.error(errorMessage(err)))
                      }
                    >
                      Unpublish
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Users(): JSX.Element {
  const [term, setTerm] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'users', term],
    queryFn: ({ pageParam }) => adminApi.users(term || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <label className="inline">
        Search <input value={term} onChange={(e) => setTerm(e.target.value)} />
      </label>
      {q.isPending ? (
        <Skeleton className="block" />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No users" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Wallet</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>{shortAddress(u.walletAddress) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Admin(): JSX.Element {
  const [tab, setTab] = useState<Tab>('revenue');
  const tabs: Array<[Tab, string]> = [
    ['revenue', 'Revenue'],
    ['health', 'Health'],
    ['settlements', 'Settlements'],
    ['videos', 'Videos'],
    ['users', 'Users'],
  ];
  return (
    <div className="page">
      <h1>Admin</h1>
      <div className="tabs" role="tablist" aria-label="Admin sections">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'revenue' ? <Revenue /> : null}
      {tab === 'health' ? <Health /> : null}
      {tab === 'settlements' ? <Settlements /> : null}
      {tab === 'videos' ? <Videos /> : null}
      {tab === 'users' ? <Users /> : null}
    </div>
  );
}
