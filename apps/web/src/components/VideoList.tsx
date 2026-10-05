import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { VideoDto } from '@tesor_gp/shared';
import { errorMessage } from '../api/client';
import type { Page } from '../api/endpoints';
import { EmptyState, ErrorState, VideoGridSkeleton } from './States';
import { VideoCard } from './VideoCard';

/** A paginated grid of videos with loading, empty and error states. */
export function VideoList({
  queryKey,
  fetchPage,
  empty,
  enabled = true,
}: {
  queryKey: QueryKey;
  fetchPage: (cursor?: string) => Promise<Page<VideoDto>>;
  empty: ReactNode;
  enabled?: boolean;
}): JSX.Element {
  const q = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
  if (q.isPending) return <VideoGridSkeleton />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const items = q.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <>{empty}</>;
  return (
    <>
      <div className="video-grid">
        {items.map((v) => (
          <VideoCard key={v.id} video={v} />
        ))}
      </div>
      {q.hasNextPage ? (
        <div className="center">
          <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

export { EmptyState };
