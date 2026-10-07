import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, errorMessage } from '../api/client';
import { catalogApi, socialApi } from '../api/endpoints';
import { keys, useBankMode, useConfig, useManagedMode, useWalletSummary } from '../api/queries';
import { BankTopUpDialog } from '../bank/BankTopUpDialog';
import { ErrorState, PageSpinner, VideoGridSkeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { VideoCard } from '../components/VideoCard';
import { formatDuration, formatViews, money, rateLabel, timeAgo, toBig } from '../lib/format';
import { Player } from '../player/Player';
import { usePlaybackSession } from '../player/usePlaybackSession';
import { BuyCoinsDialog } from '../wallet/BuyCoinsDialog';
import { TopUpDialog } from '../wallet/TopUpDialog';
import { useWallet } from '../wallet/WalletContext';
import NotFound from './NotFound';

export default function Watch(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const videoQ = useQuery({
    queryKey: ['video', id, user?.id ?? 'anon'],
    queryFn: () => catalogApi.get(id),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
    // While a stream is on air, keep the viewer count current and notice when it ends.
    refetchInterval: (q) => (q.state.data?.live?.status === 'LIVE' ? 15_000 : false),
  });
  const recs = useQuery({ queryKey: ['recommendations', 'watch', id], queryFn: () => catalogApi.recommendations(id, 8) });
  const { data: summary, refetch: refetchSummary } = useWalletSummary();
  const { state: wallet } = useWallet();
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = usePlaybackSession(id, videoRef);
  const bank = useBankMode();
  const managed = useManagedMode();
  const { data: config } = useConfig();
  // With the demo bank or built-in wallets there is nothing to set up before paying (and nothing to say until the
  // app knows which mode it runs in).
  const walletReady = bank || managed || Boolean(user?.walletAddress) || !config;
  const [topUp, setTopUp] = useState(false);
  const sessionPhase = session.state.phase;
  useEffect(() => {
    // After a session, refresh the video so "already paid" and the balance are current.
    if (sessionPhase === 'stopped' || sessionPhase === 'ended') {
      void qc.invalidateQueries({ queryKey: ['video', id] });
      void qc.invalidateQueries({ queryKey: keys.summary });
    }
  }, [sessionPhase, qc, id]);

  const toggle = useCallback(
    async (kind: 'like' | 'watchlist') => {
      if (!user) return toast.info('Log in to save videos and like them');
      try {
        if (kind === 'like') await socialApi.like(id);
        else await socialApi.watchlist(id);
        await qc.invalidateQueries({ queryKey: ['video', id] });
        await qc.invalidateQueries({ queryKey: keys.watchlist });
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [id, qc, toast, user],
  );

  if (videoQ.isPending) return <PageSpinner label="Loading video" />;
  if (videoQ.isError) {
    return videoQ.error instanceof ApiError && videoQ.error.status === 404 ? <NotFound /> : <ErrorState message={errorMessage(videoQ.error)} onRetry={() => void videoQ.refetch()} />;
  }
  const video = videoQ.data;
  const onAir = video.live?.status === 'LIVE';
  const rate = toBig(video.ratePerMinuteWei);
  const paid = rate > 0n;
  const isOwner = Boolean(user) && user?.username === video.creator.username;
  let blockedReason: string | null = null;
  if (paid && !isOwner) {
    if (!user) blockedReason = 'Log in to watch this video.';
    else if (!walletReady) blockedReason = 'Link a wallet to watch paid videos.';
  }
  const payPerSecond = paid && !isOwner && Boolean(user) && walletReady;
  const available = toBig(summary?.availableWei);
  const paidSeconds = video.paidSeconds ?? 0;
  // A live stream has no known end: count a minute ahead.
  const unpaidSeconds = onAir ? 60 : Math.max(0, video.durationSeconds - paidSeconds);
  // What the rest of the video costs at this rate (seconds already paid are free).
  const restCost = (rate * BigInt(unpaidSeconds)) / 60n;
  const minuteCost = (rate * BigInt(Math.min(60, unpaidSeconds))) / 60n;
  const lowForThis = unpaidSeconds > 0 && available < minuteCost;
  const requestTopUp = (): void => {
    if (user) setTopUp(true);
  };

  return (
    <div className="page watch">
      <div className="watch-main">
        <Player
          video={video}
          session={session}
          videoRef={videoRef}
          blockedReason={blockedReason}
          onRequestTopUp={requestTopUp}
          topUpLabel={bank ? 'Add money' : managed ? 'Buy coins' : 'Top up'}
        />
        {blockedReason && !user ? (
          <p>
            <Link to="/login" state={{ from: `/watch/${id}` }} className="btn primary">
              Log in
            </Link>
          </p>
        ) : null}
        {blockedReason && user && !walletReady ? (
          <p>
            <Link to="/wallet" className="btn primary">
              Set up wallet
            </Link>
          </p>
        ) : null}
        {payPerSecond ? (
          <section className="card unlock-panel" aria-label="Pay as you watch" data-testid="pay-panel">
            <h2>Pay as you watch</h2>
            <p>
              <strong data-testid="pay-rate">{rateLabel(video.ratePerMinuteWei)}</strong>, charged by the second you actually watch.{' '}
              {onAir ? 'You pay only while you watch the stream.' : 'Rewatching is free and skipped parts cost nothing.'}
            </p>
            <p className="muted small">
              {paidSeconds > 0 && !onAir ? (
                <span data-testid="pay-paid">
                  You have paid for {formatDuration(Math.min(paidSeconds, video.durationSeconds))} of this video.{' '}
                </span>
              ) : null}
              {onAir ? null : unpaidSeconds > 0 ? <>The rest costs at most {money(restCost)}. </> : <>You can watch all of it again for free. </>}
              Your balance: <span data-testid="pay-balance">{money(available)}</span>
            </p>
            {lowForThis ? (
              <div className="actions">
                <button type="button" className="btn primary" onClick={() => setTopUp(true)} data-testid="add-money-watch">
                  {bank ? 'Add money' : managed ? 'Buy coins' : 'Top up'}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
        <h1 className="watch-title">
          {onAir ? (
            <span className="badge live" data-testid="watch-live">
              LIVE
            </span>
          ) : null}{' '}
          {video.title}
        </h1>
        <p className="muted">
          <Link to={`/channel/${video.creator.id}`}>{video.creator.channelName}</Link> ·{' '}
          {onAir ? `${video.live?.viewers ?? 0} watching now` : `${formatViews(video.viewsCount)} · ${timeAgo(video.createdAt)}`} · {rateLabel(video.ratePerMinuteWei)}
          {video.live?.status === 'ENDED' ? ' · recorded live' : ''}
        </p>
        <div className="actions">
          <button type="button" className={`btn ${video.liked ? 'primary' : ''}`} aria-pressed={Boolean(video.liked)} onClick={() => void toggle('like')}>
            {video.liked ? 'Liked' : 'Like'} {video.likesCount ? `(${video.likesCount})` : ''}
          </button>
          <button type="button" className={`btn ${video.inWatchlist ? 'primary' : ''}`} aria-pressed={Boolean(video.inWatchlist)} onClick={() => void toggle('watchlist')}>
            {video.inWatchlist ? 'In watchlist' : 'Add to watchlist'}
          </button>
        </div>
        {video.description ? <p className="description">{video.description}</p> : null}
        {video.tags.length ? (
          <ul className="chips">
            {video.tags.map((t) => (
              <li key={t}>
                <Link className="chip" to={`/search?q=${encodeURIComponent(t)}`}>
                  #{t}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {wallet.mismatch && !bank && !managed ? (
          <p className="notice" role="alert">
            The account selected in your wallet is not the one linked to your profile. Playback is billed to the linked wallet.
          </p>
        ) : null}
      </div>
      <aside className="watch-side" aria-label="Up next">
        <h2>Up next</h2>
        {recs.isPending ? (
          <VideoGridSkeleton count={3} />
        ) : recs.isError ? (
          <ErrorState message={errorMessage(recs.error)} onRetry={() => void recs.refetch()} />
        ) : recs.data.items.length === 0 ? (
          <p className="muted">No other videos yet.</p>
        ) : (
          <div className="side-list">
            {recs.data.items.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </div>
        )}
      </aside>
      {topUp && bank ? <BankTopUpDialog onClose={() => setTopUp(false)} onDone={() => void refetchSummary()} /> : null}
      {topUp && managed ? <BuyCoinsDialog onClose={() => setTopUp(false)} onDone={() => void refetchSummary()} /> : null}
      {topUp && !bank && !managed ? <TopUpDialog onClose={() => setTopUp(false)} onDone={() => void refetchSummary()} /> : null}
    </div>
  );
}
