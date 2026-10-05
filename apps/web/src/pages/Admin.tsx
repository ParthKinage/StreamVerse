import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import { adminApi } from '../api/endpoints';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { money, moneyTitle, shortAddress, timeAgo } from '../lib/format';

type Tab = 'health' | 'settlements' | 'videos' | 'users';

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
  const [tab, setTab] = useState<Tab>('health');
  const tabs: Array<[Tab, string]> = [
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
      {tab === 'health' ? <Health /> : null}
      {tab === 'settlements' ? <Settlements /> : null}
      {tab === 'videos' ? <Videos /> : null}
      {tab === 'users' ? <Users /> : null}
    </div>
  );
}
