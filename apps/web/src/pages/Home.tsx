import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { VideoDto } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { catalogApi, liveApi, socialApi } from '../api/endpoints';
import { keys, useCategories, useContinueWatching } from '../api/queries';
import { EmptyState, ErrorState, Skeleton, VideoGridSkeleton } from '../components/States';
import { VideoCard } from '../components/VideoCard';
import { costLabel, formatDuration, formatViews, timeAgo } from '../lib/format';

function Section({ title, to, children }: { title: string; to?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="section" aria-label={title}>
      <div className="section-head">
        <h2>{title}</h2>
        {to ? (
          <Link to={to} className="see-all">
            See all
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A row of videos: a grid on wide screens, a row you swipe sideways on a phone. */
function Rail({ videos, testId, progress }: { videos: VideoDto[]; testId?: string; progress?: Record<string, number> }): JSX.Element {
  return (
    <div className="video-grid rail" data-testid={testId}>
      {videos.map((v) => (
        <VideoCard key={v.id} video={v} progress={progress?.[v.id]} />
      ))}
    </div>
  );
}

/** The big first thing on the page: a stream that is live now, or else the most watched video. */
function Featured({ video, signedIn }: { video: VideoDto; signedIn: boolean }): JSX.Element {
  const onAir = video.live?.status === 'LIVE';
  return (
    <section className="featured" aria-label="Featured">
      <div className="featured-copy">
        <p className="eyebrow">{onAir ? 'Live now' : 'Featured'}</p>
        <h1>{video.title}</h1>
        <p className="muted">
          {video.creator.channelName} · {onAir ? `${video.live?.viewers ?? 0} watching` : `${formatViews(video.viewsCount)} · ${timeAgo(video.createdAt)}`} · {costLabel(video)}
        </p>
        {video.description ? <p className="featured-desc">{video.description}</p> : null}
        <div className="actions">
          <Link to={`/watch/${video.id}`} className="btn primary big">
            {onAir ? 'Join the stream' : 'Watch now'}
          </Link>
          {!signedIn ? (
            <Link to="/register" className="btn big">
              Create a free account
            </Link>
          ) : null}
        </div>
      </div>
      <Link to={`/watch/${video.id}`} className="featured-media thumb-link" aria-label={`Watch ${video.title}`}>
        <div className="thumb">
          {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" decoding="async" /> : <div className="thumb-fallback" aria-hidden="true" />}
          {onAir ? <span className="badge live">LIVE</span> : null}
          {!onAir && video.durationSeconds > 0 ? <span className="badge duration">{formatDuration(video.durationSeconds)}</span> : null}
        </div>
      </Link>
    </section>
  );
}

const STEPS: Array<[string, string]> = [
  ['Pay by the second', 'Videos cost only the seconds you watch. Rewatching is free and skipped parts cost nothing.'],
  ['Unlock live once', 'Pay a stream’s price once and keep the stream and its recording for good.'],
  ['Creators earn directly', 'Every payment is settled in StreamCoin, on the blockchain, straight to the creator.'],
];

export default function Home(): JSX.Element {
  const { user } = useAuth();
  const continueQ = useContinueWatching();
  const recs = useQuery({ queryKey: ['recommendations', 'home', user?.id ?? 'anon'], queryFn: () => catalogApi.recommendations(undefined, 12) });
  const trending = useQuery({ queryKey: ['videos', 'trending'], queryFn: () => catalogApi.list({ sort: 'trending', limit: 12 }) });
  const cats = useCategories();
  const live = useQuery({ queryKey: ['live', 'now'], queryFn: liveApi.now, refetchInterval: 30_000 });
  const feed = useQuery({ queryKey: [...keys.feed, 'home'], queryFn: () => socialApi.feedPage(), enabled: Boolean(user) });

  // A different pick on each visit: a stream that is on air (any of them), else one of the 10 most watched videos.
  const [seed] = useState(() => Math.random());
  const pick = <T,>(list: T[] | undefined, top = 10): T | undefined => (list?.length ? list[Math.floor(seed * Math.min(top, list.length))] : undefined);
  const featured = pick(live.data?.items) ?? pick(trending.data?.items) ?? pick(recs.data?.items);
  const featuredLoading = !featured && (trending.isPending || live.isPending);

  return (
    <div className="page">
      {featured ? (
        <Featured video={featured} signedIn={Boolean(user)} />
      ) : featuredLoading ? (
        <div className="featured" aria-hidden="true">
          <div className="featured-copy">
            <Skeleton className="line short" />
            <Skeleton className="line" />
            <Skeleton className="line short" />
          </div>
          <Skeleton className="thumb" />
        </div>
      ) : (
        <section className="hero">
          <p className="eyebrow">Pay only for what you watch</p>
          <h1>Stories worth every second</h1>
          <p className="muted">Watch by the second, or unlock a live stream once and keep it for good.</p>
          {!user ? (
            <Link to="/register" className="btn primary big">
              Create a free account
            </Link>
          ) : null}
        </section>
      )}

      {cats.data ? (
        <nav className="category-row" aria-label="Categories">
          {cats.data.categories.map((c) => (
            <Link key={c.name} className="chip" to={`/search?category=${encodeURIComponent(c.name)}`}>
              {c.name}
              {c.count ? <span className="chip-count">{c.count}</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}

      {live.data?.items.length ? (
        <Section title="Live now">
          <Rail videos={live.data.items} testId="live-now" />
        </Section>
      ) : null}

      {user ? (
        <Section title="Continue watching" to="/history">
          {continueQ.isPending ? (
            <VideoGridSkeleton count={4} />
          ) : continueQ.isError ? (
            <ErrorState message={errorMessage(continueQ.error)} onRetry={() => void continueQ.refetch()} />
          ) : continueQ.data.items.length === 0 ? (
            <EmptyState title="Nothing in progress">Videos you start watching will appear here.</EmptyState>
          ) : (
            <Rail videos={continueQ.data.items.map((h) => h.video)} progress={Object.fromEntries(continueQ.data.items.map((h) => [h.video.id, h.lastPositionSec]))} />
          )}
        </Section>
      ) : null}

      {feed.data?.items.length ? (
        <Section title="From channels you follow" to="/following">
          <Rail videos={feed.data.items.slice(0, 12)} testId="following-feed" />
        </Section>
      ) : null}

      <Section title="Recommended" to="/search">
        {recs.isPending ? (
          <VideoGridSkeleton />
        ) : recs.isError ? (
          <ErrorState message={errorMessage(recs.error)} onRetry={() => void recs.refetch()} />
        ) : recs.data.items.length === 0 ? (
          <EmptyState title="No videos yet">Check back soon.</EmptyState>
        ) : (
          <Rail videos={recs.data.items} />
        )}
      </Section>

      <section className="how" aria-label="How it works">
        {STEPS.map(([title, text], i) => (
          <div key={title} className="how-step">
            <span className="how-num">0{i + 1}</span>
            <h3>{title}</h3>
            <p className="muted small">{text}</p>
          </div>
        ))}
      </section>

      <Section title="Trending" to="/search?sort=trending">
        {trending.isPending ? (
          <VideoGridSkeleton />
        ) : trending.isError ? (
          <ErrorState message={errorMessage(trending.error)} onRetry={() => void trending.refetch()} />
        ) : trending.data.items.length === 0 ? (
          <EmptyState title="Nothing trending right now" />
        ) : (
          <Rail videos={trending.data.items} />
        )}
      </Section>

      {cats.isError ? <ErrorState message={errorMessage(cats.error)} onRetry={() => void cats.refetch()} /> : null}
    </div>
  );
}
