import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, errorMessage } from '../api/client';
import { catalogApi, purchaseApi, socialApi } from '../api/endpoints';
import { keys, useBankMode, useConfig, useManagedMode, useWalletSummary } from '../api/queries';
import { BankTopUpDialog } from '../bank/BankTopUpDialog';
import { ErrorState, PageSpinner, VideoGridSkeleton } from '../components/States';
import { useToast } from '../components/Toasts';
import { VideoCard } from '../components/VideoCard';
import { formatViews, money, priceLabel, timeAgo, toBig } from '../lib/format';
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
  const [unlocking, setUnlocking] = useState(false);
  const sessionPhase = session.state.phase;
  useEffect(() => {
    // When access runs out mid-video, refresh the video so the unlock button comes back.
    if (sessionPhase === 'stopped') void qc.invalidateQueries({ queryKey: ['video', id] });
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
  const price = toBig(video.priceWei);
  const paid = price > 0n;
  const isOwner = Boolean(user) && user?.username === video.creator.username;
  let blockedReason: string | null = null;
  if (paid && !isOwner) {
    if (!user) blockedReason = 'Log in to watch this video.';
    else if (!walletReady) blockedReason = 'Link a wallet to unlock paid videos.';
    else if (!video.accessUntil) blockedReason = 'Unlock this video to watch it.';
  }
  const needsUnlock = paid && !isOwner && Boolean(user) && !video.accessUntil && walletReady;
  const available = toBig(summary?.availableWei);
  const affordable = available >= price;

  const unlock = async (): Promise<void> => {
    setUnlocking(true);
    try {
      const res = await purchaseApi.buy(id);
      toast.success(res.alreadyUnlocked ? 'You already have access to this video' : `Unlocked for ${money(res.priceWei)}`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['video', id] }), qc.invalidateQueries({ queryKey: keys.summary }), qc.invalidateQueries({ queryKey: keys.transactions })]);
      // Access ran out mid-video: carry on from the saved position.
      if (session.state.phase === 'stopped') await session.begin(videoRef.current?.currentTime ?? 0);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_BALANCE') setTopUp(true);
      else toast.error(errorMessage(err));
    } finally {
      setUnlocking(false);
    }
  };
  const requestUnlock = (): void => {
    if (!user) return;
    if (needsUnlock && affordable) void unlock();
    else if (needsUnlock) setTopUp(true);
  };

  return (
    <div className="page watch">
      <div className="watch-main">
        <Player
          video={video}
          session={session}
          videoRef={videoRef}
          blockedReason={blockedReason}
          onRequestUnlock={requestUnlock}
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
        {needsUnlock ? (
          <section className="card unlock-panel" id="unlock-panel" aria-label="Unlock this video" data-testid="unlock-panel">
            <h2>Unlock this video</h2>
            <p>
              <strong>{money(price)}</strong> for {config?.accessHours ?? 48} hours of access. Watch it as many times as you like during that time.
            </p>
            <p className="muted small">
              Your balance: <span data-testid="unlock-balance">{money(available)}</span>
              {affordable ? '' : ` · you need ${money(price - available)} more`}
            </p>
            <div className="actions">
              {affordable ? (
                <button type="button" className="btn primary" disabled={unlocking} onClick={() => void unlock()} data-testid="unlock-video">
                  {unlocking ? 'Unlocking…' : `Unlock for ${money(price)}`}
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={() => setTopUp(true)} data-testid="add-money-watch">
                  {bank ? 'Add money' : managed ? 'Buy coins' : 'Top up'}
                </button>
              )}
            </div>
          </section>
        ) : null}
        {paid && !isOwner && video.accessUntil ? (
          <p className="muted small" data-testid="access-until">
            Access until {new Date(video.accessUntil).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        ) : null}
        <h1 className="watch-title">{video.title}</h1>
        <p className="muted">
          <Link to={`/channel/${video.creator.id}`}>{video.creator.channelName}</Link> · {formatViews(video.viewsCount)} · {timeAgo(video.createdAt)} · {priceLabel(video.priceWei)}
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
