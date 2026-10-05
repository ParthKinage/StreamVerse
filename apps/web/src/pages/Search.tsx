import { useSearchParams } from 'react-router-dom';
import { catalogApi } from '../api/endpoints';
import { useCategories } from '../api/queries';
import { EmptyState, VideoList } from '../components/VideoList';

type Sort = 'newest' | 'popular' | 'trending';

export default function Search(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = (['newest', 'popular', 'trending'].includes(params.get('sort') ?? '') ? params.get('sort') : 'newest') as Sort;
  const { data: cats } = useCategories();
  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  return (
    <div className="page">
      <h1>{q ? `Results for “${q}”` : category ? category : 'Browse videos'}</h1>
      <div className="filters">
        <label>
          Category
          <select value={category} onChange={(e) => update('category', e.target.value)}>
            <option value="">All</option>
            {cats?.categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort by
          <select value={sort} onChange={(e) => update('sort', e.target.value)}>
            <option value="newest">Newest</option>
            <option value="popular">Most viewed</option>
            <option value="trending">Trending</option>
          </select>
        </label>
      </div>
      <VideoList
        queryKey={['videos', 'search', q, category, sort]}
        fetchPage={(cursor) => catalogApi.list({ q, category, sort, ...(cursor ? { cursor } : {}) })}
        empty={<EmptyState title="No videos found">Try a different search term or category.</EmptyState>}
      />
    </div>
  );
}
