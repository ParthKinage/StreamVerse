import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../api/client';
import { catalogApi } from '../api/endpoints';
import { useCategories, useContinueWatching } from '../api/queries';
import { EmptyState, ErrorState, VideoGridSkeleton } from '../components/States';
import { VideoCard } from '../components/VideoCard';

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function Home(): JSX.Element {
  const { user } = useAuth();
  const continueQ = useContinueWatching();
  const recs = useQuery({ queryKey: ['recommendations', 'home', user?.id ?? 'anon'], queryFn: () => catalogApi.recommendations(undefined, 12) });
  const trending = useQuery({ queryKey: ['videos', 'trending'], queryFn: () => catalogApi.list({ sort: 'trending', limit: 12 }) });
  const cats = useCategories();

  return (
    <div className="page">
      <section className="hero">
        <h1>Pay only for what you watch</h1>
        <p className="muted">Pay once per video. Add money to your wallet, unlock the videos you want, and watch them for a limited time.</p>
        {!user ? (
          <Link to="/register" className="btn primary big">
            Create a free account
          </Link>
        ) : null}
      </section>

      {user ? (
        <Section title="Continue watching">
          {continueQ.isPending ? (
            <VideoGridSkeleton count={4} />
          ) : continueQ.isError ? (
            <ErrorState message={errorMessage(continueQ.error)} onRetry={() => void continueQ.refetch()} />
          ) : continueQ.data.items.length === 0 ? (
            <EmptyState title="Nothing in progress">Videos you start watching will appear here.</EmptyState>
          ) : (
            <div className="video-grid">
              {continueQ.data.items.map((h) => (
                <VideoCard key={h.sessionId} video={h.video} progress={h.lastPositionSec} />
              ))}
            </div>
          )}
        </Section>
      ) : null}

      <Section title="Recommended">
        {recs.isPending ? (
          <VideoGridSkeleton />
        ) : recs.isError ? (
          <ErrorState message={errorMessage(recs.error)} onRetry={() => void recs.refetch()} />
        ) : recs.data.items.length === 0 ? (
          <EmptyState title="No videos yet">Check back soon.</EmptyState>
        ) : (
          <div className="video-grid">
            {recs.data.items.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Trending">
        {trending.isPending ? (
          <VideoGridSkeleton />
        ) : trending.isError ? (
          <ErrorState message={errorMessage(trending.error)} onRetry={() => void trending.refetch()} />
        ) : trending.data.items.length === 0 ? (
          <EmptyState title="Nothing trending right now" />
        ) : (
          <div className="video-grid">
            {trending.data.items.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Browse by category">
        {cats.isPending ? (
          <VideoGridSkeleton count={0} />
        ) : cats.isError ? (
          <ErrorState message={errorMessage(cats.error)} onRetry={() => void cats.refetch()} />
        ) : (
          <ul className="chips">
            {cats.data.categories.map((c) => (
              <li key={c.name}>
                <Link className="chip" to={`/search?category=${encodeURIComponent(c.name)}`}>
                  {c.name} <span className="muted">({c.count})</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
