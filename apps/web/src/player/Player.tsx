import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import Hls from 'hls.js';
import type { VideoDto } from '@tesor_gp/shared';
import { formatDuration, priceLabel } from '../lib/format';
import { CostMeter } from './CostMeter';
import { readNumber, writeValue } from './storage';
import type { PlaybackSession } from './usePlaybackSession';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const VOLUME_KEY = 'streamverse.volume';
const MUTED_KEY = 'streamverse.muted';

interface Props {
  video: VideoDto;
  session: PlaybackSession;
  videoRef: RefObject<HTMLVideoElement>;
  /** Opens the unlock flow (buy access, or add money first). */
  onRequestUnlock(): void;
  /** Why playback is not possible yet (sign in, unlock first, link a wallet). */
  blockedReason?: string | null;
}

export function Player({ video, session, videoRef, onRequestUnlock, blockedReason }: Props): JSX.Element {
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
  const [mediaError, setMediaError] = useState<string | null>(null);

  // Attach the stream when a session starts.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !state.manifestUrl || !state.sessionId) return;
    setMediaError(null);
    const start = (): void => {
      if (resumeAtRef.current > 0) el.currentTime = resumeAtRef.current;
      if (autoPlayRef.current) void el.play().catch(() => undefined);
    };
    if (Hls.isSupported()) {
      const hls = new Hls({ xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        }, enableWorker: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels.map((l, index) => ({ index, label: l.height ? `${l.height}p` : `Level ${index + 1}` })));
        setLevel(-1);
        start();
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else setMediaError('This video could not be played. Try reloading the page.');
      });
      hls.loadSource(state.manifestUrl);
      hls.attachMedia(el);
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = state.manifestUrl;
      const onMeta = (): void => start();
      el.addEventListener('loadedmetadata', onMeta, { once: true });
      return () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeAttribute('src');
        el.load();
      };
    }
    setMediaError('Your browser cannot play HLS video.');
    return undefined;
  }, [state.manifestUrl, state.sessionId, videoRef]);

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
          ) : (
            <>
              <button type="button" className="btn primary big" onClick={() => void startSession(state.resumePositionSec)} data-testid="start-playback">
                {state.phase === 'error' ? 'Try again' : 'Play'}
              </button>
              <p className="muted small">{priceLabel(video.priceWei)}{video.accessUntil ? ' · you have access to this video' : ''}</p>
            </>
          )}
          {state.errorCode === 'PURCHASE_REQUIRED' || state.errorCode === 'INSUFFICIENT_BALANCE' || state.errorCode === 'WALLET_NOT_LINKED' ? (
            <button type="button" className="btn" onClick={onRequestUnlock}>
              {state.errorCode === 'WALLET_NOT_LINKED' ? 'Connect wallet' : 'Unlock video'}
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
          <p className="muted small">Your place is saved. Unlock the video again to continue from where you stopped.</p>
          <button type="button" className="btn primary" onClick={onRequestUnlock}>
            Unlock again
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

      {mediaError ? (
        <div className="player-overlay" role="alert">
          {mediaError}
        </div>
      ) : null}

      <div className="player-controls">
        <button type="button" className="icon-btn" onClick={togglePlay} aria-label={paused || !sessionLive ? 'Play' : 'Pause'}>
          {paused || !sessionLive ? '▶' : '❚❚'}
        </button>
        <span className="time" aria-hidden="true">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
        <input
          type="range"
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
