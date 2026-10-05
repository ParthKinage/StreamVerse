import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { catalogApi } from '../api/endpoints';
import { ErrorState, PageSpinner } from '../components/States';
import { EmptyState, VideoList } from '../components/VideoList';
import { formatViews } from '../lib/format';
import NotFound from './NotFound';

export default function Channel(): JSX.Element {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['creator', id], queryFn: () => catalogApi.creator(id), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  if (q.isPending) return <PageSpinner />;
  if (q.isError) return q.error instanceof ApiError && q.error.status === 404 ? <NotFound /> : <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const c = q.data;
  return (
    <div className="page">
      <header className="channel-head">
        <h1>{c.channelName}</h1>
        <p className="muted">
          @{c.username} · {c.videoCount} video{c.videoCount === 1 ? '' : 's'} · {formatViews(c.totalViews)}
        </p>
        {c.bio ? <p>{c.bio}</p> : null}
      </header>
      <VideoList queryKey={['videos', 'channel', id]} fetchPage={(cursor) => catalogApi.list({ creatorId: id, sort: 'newest', ...(cursor ? { cursor } : {}) })} empty={<EmptyState title="No published videos yet" />} />
    </div>
  );
}
