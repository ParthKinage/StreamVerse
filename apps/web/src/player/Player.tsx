import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import Hls, { type LoadPolicy } from 'hls.js';
import type { VideoDto } from '@tesor_gp/shared';
import { formatDuration, costLabel } from '../lib/format';
import { CostMeter } from './CostMeter';
import { MAX_NETWORK_RETRIES, MAX_URL_REFRESHES, describeFailure, isTransientStatus, networkRetryDelayMs, problemFromVideo, sendCredentials, type PlaybackProblem } from './errors';
import { readNumber, writeValue } from './storage';
import type { PlaybackSession } from './usePlaybackSession';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const VOLUME_KEY = 'streamverse.volume';
const MUTED_KEY = 'streamverse.muted';

interface Props {
  video: VideoDto;
  session: PlaybackSession;
  videoRef: RefObject<HTMLVideoElement>;
  /** Opens the add-money / buy-coins dialog. */
  onRequestTopUp(): void;
  /** Wording of that button for the current payment mode ("Add money", "Buy coins", "Top up"). */
  topUpLabel?: string;
  /** Why playback is not possible yet (sign in, unlock first, link a wallet). */
  blockedReason?: string | null;
}

/** hls.js's own retries, minus the pointless ones: a 404 or a refused signature fails at once so we can react. */
function withoutPermanentRetries(policy: LoadPolicy): LoadPolicy {
  const errorRetry = policy.default.errorRetry;
  return {
    default: {
      ...policy.default,
      errorRetry: errorRetry && { ...errorRetry, shouldRetry: (_cfg, _n, isTimeout, response, retry) => retry && (isTimeout || isTransientStatus(response?.code)) },
    },
  };
}

export function Player({ video, session, videoRef, onRequestTopUp, topUpLabel = 'Buy coins', blockedReason }: Props): JSX.Element {
  const { state } = session;
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const resumeAtRef = useRef(0);
  const autoPlayRef = useRef(false);
  const [levels, setLevels] = useState<Array<{ index: number; label: string }>>([]);
  const [level, setLevel] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(() => readNumber(VOLUME_KEY, 1));
  const [muted, setMuted] = useState(() => readNumber(MUTED_KEY, 0) === 1);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(video.durationSeconds);
  const [problem, setProblem] = useState<PlaybackProblem | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Attach the stream when a session starts (or the viewer presses Retry).
  useEffect(() => {
    const el = videoRef.current;
    const manifestUrl = state.manifestUrl;
    if (!el || !manifestUrl || !state.sessionId) return;
    setProblem(null);
    const start = (): void => {
      if (resumeAtRef.current > 0) el.currentTime = resumeAtRef.current;
      if (autoPlayRef.current) void el.play().catch(() => undefined);
    };
    if (Hls.isSupported()) {
      const hls = new Hls({
        // The playback cookie goes to our own origin only; signed storage URLs are fetched without cookies.
        xhrSetup: (xhr, url) => {
          xhr.withCredentials = sendCredentials(url, window.location.origin);
        },
        enableWorker: true,
        // Viewers pay for every piece the player fetches, so never buffer more than about 10 s ahead. hls.js raises
        // maxBufferLength for low-bitrate video up to maxMaxBufferLength, so the ceiling has to be set too.
        maxBufferLength: 10,
        maxMaxBufferLength: 10,
        fragLoadPolicy: withoutPermanentRetries(Hls.DefaultConfig.fragLoadPolicy),
        playlistLoadPolicy: withoutPermanentRetries(Hls.DefaultConfig.playlistLoadPolicy),
        manifestLoadPolicy: withoutPermanentRetries(Hls.DefaultConfig.manifestLoadPolicy),
      });
      hlsRef.current = hls;
      let networkRetries = 0;
      let urlRefreshes = 0;
      let mediaRecoveries = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels.map((l, index) => ({ index, label: l.height ? `${l.height}p` : `Level ${index + 1}` })));
        setLevel(-1);
        start();
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        const status = data.response?.code;
        const playlist = /MANIFEST|LEVEL|TRACK/.test(data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if ((status === 401 || status === 403) && !playlist && urlRefreshes < MAX_URL_REFRESHES) {
            // Signed segment URLs ran out (usually after a long pause): fetch a fresh playlist and carry on.
            urlRefreshes++;
            resumeAtRef.current = el.currentTime;
            autoPlayRef.current = !el.paused;
            hls.loadSource(manifestUrl);
            return;
          }
          if (isTransientStatus(status) && networkRetries < MAX_NETWORK_RETRIES) {
            timer = setTimeout(() => hls.startLoad(), networkRetryDelayMs(networkRetries++));
            return;
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          if (mediaRecoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        }
        hls.stopLoad();
        setProblem(describeFailure({ type: data.type, status, playlist }));
      });
      hls.loadSource(manifestUrl);
      hls.attachMedia(el);
      return () => {
        clearTimeout(timer);
        hls.destroy();
        hlsRef.current = null;
      };
    }
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = manifestUrl;
      const onMeta = (): void => start();
      const onError = (): void => setProblem(describeFailure({ type: el.error?.code === 4 ? 'otherError' : 'networkError', playlist: false }));
      el.addEventListener('loadedmetadata', onMeta, { once: true });
      el.addEventListener('error', onError);
      return () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onError);
        el.removeAttribute('src');
        el.load();
      };
    }
    setProblem({ kind: 'unsupported', message: 'Your browser cannot play HLS video.', retry: 'none' });
    return undefined;
  }, [state.manifestUrl, state.sessionId, videoRef, reloadKey]);

  // Media element wiring: volume, time, duration.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted, videoRef]);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onTime = (): void => setTime(el.currentTime);
    const onDur = (): void => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    };
    const onPlay = (): void => setPaused(false);
    const onPause = (): void => setPaused(true);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('durationchange', onDur);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('durationchange', onDur);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, [videoRef, state.sessionId]);

  const startSession = useCallback(
    async (resumeAt: number): Promise<void> => {
      resumeAtRef.current = resumeAt;
      autoPlayRef.current = true;
      await session.begin(resumeAt);
    },
    [session],
  );

  const sessionLive = state.phase === 'active' || state.phase === 'reconnecting';
  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!sessionLive) {
      if (state.phase !== 'starting') void startSession(el.currentTime || state.resumePositionSec);
      return;
    }
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, [videoRef, sessionLive, state.phase, state.resumePositionSec, startSession]);

  const seekBy = (delta: number): void => {
    const el = videoRef.current;
    if (el && sessionLive) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + delta));
  };
  const changeVolume = (v: number): void => {
    const next = Math.max(0, Math.min(1, v));
    setVolume(next);
    setMuted(next === 0);
    writeValue(VOLUME_KEY, next);
    writeValue(MUTED_KEY, next === 0 ? 1 : 0);
  };
  const toggleMute = (): void => {
    setMuted((m) => {
      writeValue(MUTED_KEY, m ? 0 : 1);
      return !m;
    });
  };
  const toggleFullscreen = (): void => {
    const c = containerRef.current;
    if (!c) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void c.requestFullscreen?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekBy(-5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekBy(5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        changeVolume(volume + 0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        changeVolume(volume - 0.1);
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'm':
        toggleMute();
        break;
      default:
    }
  };

  const retry = (): void => {
    const el = videoRef.current;
    const p = problem;
    setProblem(null);
    resumeAtRef.current = el?.currentTime ?? 0;
    autoPlayRef.current = true;
    if (p?.retry === 'new-session' || !sessionLive) void startSession(resumeAtRef.current);
    else setReloadKey((k) => k + 1);
  };

  const notReady = problemFromVideo(video);
  const onAir = video.live?.status === 'LIVE';
  const showStart = state.phase === 'idle' || state.phase === 'error';
  const showStopped = state.phase === 'stopped';
  const showEnded = state.phase === 'ended';

  return (
    <div className="player" ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Video player: ${video.title}`} data-testid="player">
      <video
        ref={videoRef}
        className="player-video"
        poster={video.thumbnailUrl ?? undefined}
        playsInline
        onClick={togglePlay}
        onRateChange={(e) => setSpeed(e.currentTarget.playbackRate)}
        aria-label={video.title}
      />

      {state.phase === 'starting' ? (
        <div className="player-overlay" role="status">
          <span className="spinner" aria-hidden="true" /> Starting your session…
        </div>
      ) : null}

      {showStart ? (
        <div className="player-overlay">
          {state.phase === 'error' && state.message ? (
            <p className="form-error" role="alert">
              {state.message}
            </p>
          ) : null}
          {blockedReason ? (
            <p>{blockedReason}</p>
          ) : notReady ? (
            <p role="status" data-testid="not-ready">
              {notReady.message}
            </p>
          ) : (
            <>
              <button type="button" className="btn primary big" onClick={() => void startSession(state.resumePositionSec)} data-testid="start-playback">
                {state.phase === 'error' ? 'Try again' : 'Play'}
              </button>
              <p className="muted small">
                {onAir ? 'Live now · ' : ''}
                {costLabel(video)}
                {!onAir && video.paidSeconds ? ` · ${formatDuration(video.paidSeconds)} already paid, free to rewatch` : ''}
              </p>
            </>
          )}
          {state.errorCode === 'INSUFFICIENT_BALANCE' ? (
            <button type="button" className="btn" onClick={onRequestTopUp} data-testid="player-top-up">
              {topUpLabel}
            </button>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'reconnecting' ? (
        <div className="player-overlay" role="status" data-testid="reconnecting">
          <span className="spinner" aria-hidden="true" /> Reconnecting… playback is paused until billing is confirmed.
        </div>
      ) : null}

      {showStopped ? (
        <div className="player-overlay" role="alert" data-testid="stopped">
          <p>{state.message}</p>
          <p className="muted small">Your place is saved. Add money, then press Resume to carry on from where you stopped.</p>
          <button type="button" className="btn primary" onClick={onRequestTopUp}>
            {topUpLabel}
          </button>
        </div>
      ) : null}

      {showEnded ? (
        <div className="player-overlay" role="status" data-testid="ended">
          <p>{state.message}</p>
          <button type="button" className="btn primary" onClick={() => void startSession(videoRef.current?.currentTime ?? 0)}>
            Resume
          </button>
        </div>
      ) : null}

      {problem ? (
        <div className="player-overlay" role="alert" data-testid="playback-problem" data-kind={problem.kind}>
          <p>{problem.message}</p>
          {problem.kind === 'balance' ? (
            <button type="button" className="btn" onClick={onRequestTopUp} data-testid="player-top-up">
              {topUpLabel}
            </button>
          ) : null}
          {problem.retry !== 'none' ? (
            <button type="button" className="btn primary" onClick={retry}>
              {problem.kind === 'balance' ? 'Continue' : 'Retry'}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="player-controls">
        <button type="button" className="icon-btn" onClick={togglePlay} aria-label={paused || !sessionLive ? 'Play' : 'Pause'}>
          {paused || !sessionLive ? '▶' : '❚❚'}
        </button>
        {onAir ? (
          <span className="badge live" data-testid="player-live">
            LIVE
          </span>
        ) : (
          <span className="time" aria-hidden="true">
            {formatDuration(time)} / {formatDuration(duration)}
          </span>
        )}
        <input
          type="range"
          hidden={onAir}
          className="seek"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          step={1}
          value={Math.min(Math.floor(time), Math.max(1, Math.floor(duration)))}
          aria-label="Seek"
          disabled={!sessionLive}
          onChange={(e) => {
            const el = videoRef.current;
            if (el) el.currentTime = Number(e.target.value);
          }}
        />
        <button type="button" className="icon-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted || volume === 0 ? '🔇' : '🔊'}
        </button>
        <input type="range" className="volume" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" onChange={(e) => changeVolume(Number(e.target.value))} />
        <label className="sr-only" htmlFor="speed">
          Playback speed
        </label>
        <select
          id="speed"
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            if (videoRef.current) videoRef.current.playbackRate = v;
          }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="quality">
          Quality
        </label>
        <select
          id="quality"
          value={level}
          disabled={levels.length === 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLevel(v);
            if (hlsRef.current) hlsRef.current.currentLevel = v;
          }}
        >
          <option value={-1}>Auto</option>
          {levels.map((l) => (
            <option key={l.index} value={l.index}>
              {l.label}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" onClick={toggleFullscreen} aria-label="Toggle fullscreen">
          ⛶
        </button>
      </div>

      <CostMeter state={state} />
    </div>
  );
}
