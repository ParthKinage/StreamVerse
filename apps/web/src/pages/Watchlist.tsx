import { useSearchParams } from 'react-router-dom';
import { catalogApi, socialApi } from '../api/endpoints';
import { keys } from '../api/queries';
import { EmptyState, VideoList } from '../components/VideoList';

type Tab = 'saved' | 'owned';

/** The viewer's library: videos saved for later, and videos they own (bought, or fully paid for). */
export default function Watchlist(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'owned' ? 'owned' : 'saved';
  const tabs: Array<[Tab, string]> = [
    ['saved', 'Saved'],
    ['owned', 'Owned'],
  ];
  return (
    <div className="page">
      <h1>Library</h1>
      <div className="tabs" role="tablist" aria-label="Library sections">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => setParams(id === 'saved' ? {} : { tab: id }, { replace: true })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'saved' ? (
        <VideoList queryKey={keys.watchlist} fetchPage={(cursor) => socialApi.watchlistPage(cursor)} empty={<EmptyState title="Nothing saved yet">Use “Add to watchlist” on any video to save it for later.</EmptyState>} />
      ) : (
        <VideoList
          queryKey={[...keys.owned, 'list']}
          fetchPage={(cursor) => catalogApi.listMine({ owned: '1', ...(cursor ? { cursor } : {}) })}
          empty={<EmptyState title="You don’t own any videos yet">Videos you buy, or watch to the end, stay yours to watch again for free.</EmptyState>}
        />
      )}
    </div>
  );
}
