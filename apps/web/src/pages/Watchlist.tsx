import { socialApi } from '../api/endpoints';
import { keys } from '../api/queries';
import { EmptyState, VideoList } from '../components/VideoList';

export default function Watchlist(): JSX.Element {
  return (
    <div className="page">
      <h1>Watchlist</h1>
      <VideoList queryKey={keys.watchlist} fetchPage={(cursor) => socialApi.watchlistPage(cursor)} empty={<EmptyState title="Your watchlist is empty">Use “Add to watchlist” on any video to save it for later.</EmptyState>} />
    </div>
  );
}
