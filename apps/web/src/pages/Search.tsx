import { useQuery } from '@tanstack/react-query';
import { ChannelAvatar } from '../components/ChannelAvatar';
import { Link, useSearchParams } from 'react-router-dom';
import type { VideoDto } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { catalogApi, liveApi, type VideoListParams } from '../api/endpoints';
import { useCategories } from '../api/queries';
import { FollowButton } from '../components/FollowButton';
import { ErrorState, Skeleton, VideoGridSkeleton } from '../components/States';
import { VideoCard } from '../components/VideoCard';
import { EmptyState, VideoList } from '../components/VideoList';

type Sort = 'newest' | 'popular' | 'trending';
type View = 'videos' | 'channels' | 'live';
type Price = '' | 'free' | 'paid' | 'owned';
type Length = '' | 'short' | 'medium' | 'long';

const PRICES: Array<[Price, string]> = [
  ['', 'All'],
  ['free', 'Free'],
  ['paid', 'Paid'],
  ['owned', 'Owned'],
];
const LENGTHS: Array<[Length, string]> = [
  ['', 'Any length'],
  ['short', 'Under 4 min'],
  ['medium', '4–20 min'],
  ['long', 'Over 20 min'],
];

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

/** Live streams on air now whose title, channel or category match the search. */
function matchesLive(v: VideoDto, q: string, category: string): boolean {
  if (category && v.category !== category) return false;
  if (!q) return true;
  const needle = q.toLowerCase();
  return [v.title, v.description, v.creator.channelName, v.creator.username, ...v.tags].some((s) => s.toLowerCase().includes(needle));
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange(v: T): void }): JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v || 'all'} type="button" className={value === v ? 'active' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function ChannelResults({ q }: { q: string }): JSX.Element {
  const res = useQuery({ queryKey: ['creators', 'search', q], queryFn: () => catalogApi.creators(q) });
  if (res.isPending) return <Skeleton className="line" />;
  if (res.isError) return <ErrorState message={errorMessage(res.error)} onRetry={() => void res.refetch()} />;
  if (!res.data.items.length) return <EmptyState title="No channels found">Try a different name.</EmptyState>;
  return (
    <ul className="channel-list" aria-label="Channels" data-testid="channel-results">
      {res.data.items.map((c) => (
        <li key={c.id} className="channel-item">
          <ChannelAvatar name={c.channelName} size="md" />
          <Link to={`/channel/${c.id}`} className="channel-name">
            {c.channelName}
          </Link>
          <span className="muted small">
            @{c.username} · {c.videoCount} video{c.videoCount === 1 ? '' : 's'} · {c.followersCount.toLocaleString()} follower{c.followersCount === 1 ? '' : 's'}
          </span>
          <FollowButton creatorId={c.id} />
        </li>
      ))}
    </ul>
  );
}

function LiveResults({ q, category }: { q: string; category: string }): JSX.Element {
  const res = useQuery({ queryKey: ['live', 'now'], queryFn: liveApi.now, refetchInterval: 30_000 });
  if (res.isPending) return <VideoGridSkeleton count={3} />;
  if (res.isError) return <ErrorState message={errorMessage(res.error)} onRetry={() => void res.refetch()} />;
  const items = res.data.items.filter((v) => matchesLive(v, q, category));
  if (!items.length) return <EmptyState title="Nobody matching is live right now">Check back later, or follow a channel to see when it goes live.</EmptyState>;
  return (
    <div className="video-grid" data-testid="live-results">
      {items.map((v) => (
        <VideoCard key={v.id} video={v} />
      ))}
    </div>
  );
}

export default function Search(): JSX.Element {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const view = pick<View>(params.get('view'), ['videos', 'channels', 'live'], 'videos');
  const sort = pick<Sort>(params.get('sort'), ['newest', 'popular', 'trending'], 'newest');
  const price = pick<Price>(params.get('price'), ['', 'free', 'paid', 'owned'], '');
  const length = pick<Length>(params.get('length'), ['', 'short', 'medium', 'long'], '');
  const { data: cats } = useCategories();
  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const prices = user ? PRICES : PRICES.filter(([v]) => v !== 'owned');
  const owned = price === 'owned' && Boolean(user);
  const filters: VideoListParams = {
    q,
    category,
    sort,
    ...(price === 'free' || price === 'paid' ? { price } : {}),
    ...(length ? { length } : {}),
    ...(owned ? { owned: '1' as const } : {}),
  };

  return (
    <div className="page">
      <h1>{q ? `Results for “${q}”` : category ? category : 'Browse'}</h1>
      <div className="tabs" role="tablist" aria-label="What to search">
        {(
          [
            ['videos', 'Videos'],
            ['channels', 'Channels'],
            ['live', 'Live now'],
          ] as Array<[View, string]>
        ).map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'tab active' : 'tab'} onClick={() => update('view', v === 'videos' ? '' : v)}>
            {label}
          </button>
        ))}
      </div>

      {view === 'channels' ? (
        <ChannelResults q={q} />
      ) : (
        <>
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
            {view === 'videos' ? (
              <label>
                Sort by
                <select value={sort} onChange={(e) => update('sort', e.target.value)}>
                  <option value="newest">Newest</option>
                  <option value="popular">Most viewed</option>
                  <option value="trending">Trending</option>
                </select>
              </label>
            ) : null}
          </div>
          {view === 'videos' ? (
            <>
              <div className="filters">
                <Segmented label="Price" value={price} options={prices} onChange={(v) => update('price', v)} />
                <Segmented label="Length" value={length} options={LENGTHS} onChange={(v) => update('length', v)} />
              </div>
              <VideoList
                queryKey={['videos', 'search', filters, user?.id ?? 'anon']}
                fetchPage={(cursor) => (owned ? catalogApi.listMine : catalogApi.list)({ ...filters, ...(cursor ? { cursor } : {}) })}
                empty={<EmptyState title="No videos found">Try a different search, or remove a filter.</EmptyState>}
              />
            </>
          ) : (
            <LiveResults q={q} category={category} />
          )}
        </>
      )}
    </div>
  );
}
