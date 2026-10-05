import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { watchApi } from '../api/endpoints';
import { keys } from '../api/queries';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { formatDuration, money, moneyTitle, timeAgo } from '../lib/format';

export default function History(): JSX.Element {
  const q = useInfiniteQuery({
    queryKey: keys.history,
    queryFn: ({ pageParam }) => watchApi.history(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="page">
      <h1>Watch history</h1>
      {q.isPending ? (
        <Skeleton className="block" />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing watched yet">Videos you watch will be listed here with what each session cost.</EmptyState>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Video</th>
                <th>Watched</th>
                <th className="num">Paid</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.sessionId}>
                  <td>
                    <Link to={`/watch/${h.video.id}`}>{h.video.title}</Link>
                  </td>
                  <td>{formatDuration(h.watchedSeconds)}</td>
                  <td className="num" title={moneyTitle(h.paidWei)}>
                    {money(h.paidWei)}
                  </td>
                  <td>{timeAgo(h.watchedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.hasNextPage ? (
            <div className="center">
              <button type="button" className="btn" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
