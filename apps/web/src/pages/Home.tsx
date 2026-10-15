import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { VideoDto } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { catalogApi, liveApi } from '../api/endpoints';
import { useCategories, useContinueWatching } from '../api/queries';
import { CoinGame } from '../components/CoinGame';
import { EmptyState, ErrorState, VideoGridSkeleton } from '../components/States';
import { VideoCard } from '../components/VideoCard';
import { useTheme } from '../lib/theme';

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

/**
 * The welcome heading, with the StreamCoin catching game behind it: press Play and coins fall through the heading,
 * caught with a tray along its bottom edge (mouse, finger or arrow keys). The canvas is transparent, so the heading
 * stays readable on top.
 */
function Hero({ signedIn }: { signedIn: boolean }): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const theme = useTheme();
  return (
    <section className={`hero hero-game${playing ? ' playing' : ''}`} aria-label="Welcome">
      {playing ? <CoinGame key={theme} variant="full" /> : null}
      <div className="hero-copy">
        <p className="eyebrow">Pay only for what you watch</p>
        <h1>Stories worth every second</h1>
        <p className="muted">Watch by the second, or unlock a live stream once and keep it for good. Rewatching is free and skipped parts cost nothing.</p>
        <div className="actions">
          {!signedIn ? (
            <Link to="/register" className="btn primary big">
              Create a free account
            </Link>
          ) : null}
          <button type="button" className="btn big" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} data-testid="hero-play">
            {playing ? 'Stop the game' : '▶ Play: catch the StreamCoins'}
          </button>
        </div>
        {playing ? <p className="muted small hero-hint">Move the mouse or use the arrow keys to catch the coins.</p> : null}
      </div>
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


  return (
    <div className="page">
      <Hero signedIn={Boolean(user)} />

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
