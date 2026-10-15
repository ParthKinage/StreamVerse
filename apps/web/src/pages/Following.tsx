import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { socialApi } from '../api/endpoints';
import { keys } from '../api/queries';
import { FollowButton } from '../components/FollowButton';
import { ErrorState, Skeleton } from '../components/States';
import { EmptyState, VideoList } from '../components/VideoList';

export default function Following(): JSX.Element {
  const q = useQuery({ queryKey: keys.following, queryFn: socialApi.following });
  return (
    <div className="page">
      <h1>Following</h1>
      {q.isPending ? (
        <Skeleton className="line" />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="You don’t follow any channels yet">Open a channel and press Follow to see its new videos and live streams here.</EmptyState>
      ) : (
        <>
          <ul className="channel-list" aria-label="Channels you follow">
            {q.data.items.map((c) => (
              <li key={c.id} className="channel-item">
                <Link to={`/channel/${c.id}`} className="channel-name">
                  {c.channelName}
                </Link>
                <span className="muted small">
                  {c.videoCount} video{c.videoCount === 1 ? '' : 's'} · {c.followersCount.toLocaleString()} follower{c.followersCount === 1 ? '' : 's'}
                </span>
                <FollowButton creatorId={c.id} />
              </li>
            ))}
          </ul>
          <h2 className="table-title">Latest from your channels</h2>
          <VideoList queryKey={keys.feed} fetchPage={(cursor) => socialApi.feedPage(cursor)} empty={<EmptyState title="No videos yet">New videos from these channels will appear here.</EmptyState>} />
        </>
      )}
    </div>
  );
}
