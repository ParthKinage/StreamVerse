import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import type { HeartbeatRequest } from '@tesor_gp/shared';
import { API_BASE, ApiError } from '../api/client';
import { watchApi } from '../api/endpoints';
import { canSendHeartbeat, initialSessionState, mustPause, sessionReducer, type PlayerActivity, type SessionState } from './sessionMachine';

export interface PlaybackSession {
  state: SessionState;
  /** Starts a billed session (first play, or resuming after a stop). Resolves true when the session is running. */
  begin(resumeAt?: number): Promise<boolean>;
  /** Ends the session explicitly (navigating away is handled automatically). */
  end(): Promise<void>;
  /** Called by the top-up flow once a deposit is confirmed. */
  notifyToppedUp(availableWei: string): void;
}

const RETRY_WHILE_RECONNECTING_MS = 3000;

function currentActivity(video: HTMLVideoElement | null): PlayerActivity {
  if (!video || video.paused || video.ended) return 'paused';
  return video.readyState < 3 ? 'buffering' : 'playing';
}

/**
 * Owns the session lifecycle for one video: start, heartbeat every interval with a monotonic sequence (retrying a
 * failed one with the same sequence), end on unmount, and a beacon on page close.
 */
export function usePlaybackSession(videoId: string, videoRef: RefObject<HTMLVideoElement>, options: { onAutoPause?: () => void } = {}): PlaybackSession {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const inflight = useRef(false);
  const startAbort = useRef<AbortController | null>(null);
  const endedSent = useRef<string | null>(null);

  // Track what the media element is doing.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = (): void => dispatch({ type: 'PLAYER_STATE', state: currentActivity(v) });
    const events = ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'canplay', 'stalled'] as const;
    events.forEach((e) => v.addEventListener(e, sync));
    return () => events.forEach((e) => v.removeEventListener(e, sync));
  }, [videoRef, state.sessionId]);

  const sendHeartbeat = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    if (inflight.current || !s.sessionId || !canSendHeartbeat(s, document.hidden)) return;
    const video = videoRef.current;
    inflight.current = true;
    const body: HeartbeatRequest = {
      sequence: s.nextSequence,
      playbackTime: Math.max(0, Math.round((video?.currentTime ?? 0) * 100) / 100),
      state: currentActivity(video),
    };
    try {
      const response = await watchApi.heartbeat(s.sessionId, body);
      if (stateRef.current.sessionId === s.sessionId) dispatch({ type: 'BEAT_OK', response });
    } catch (err) {
      if (stateRef.current.sessionId !== s.sessionId) return;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 408) {
        const endReason = (err.details as { endReason?: string | null } | undefined)?.endReason ?? null;
        dispatch({ type: 'BEAT_REJECTED', code: err.code, message: err.message, endReason });
      } else {
        dispatch({ type: 'BEAT_NETWORK_FAILED' });
      }
    } finally {
      inflight.current = false;
    }
  }, [videoRef]);

  // Heartbeat timer, with a faster retry cadence while reconnecting.
  useEffect(() => {
    if (!state.sessionId || (state.phase !== 'active' && state.phase !== 'reconnecting')) return;
    const ms = state.phase === 'reconnecting' ? RETRY_WHILE_RECONNECTING_MS : state.heartbeatIntervalSec * 1000;
    const t = setInterval(() => void sendHeartbeat(), ms);
    return () => clearInterval(t);
  }, [state.sessionId, state.phase, state.heartbeatIntervalSec, sendHeartbeat]);

  // Come back online -> confirm billing immediately.
  useEffect(() => {
    const onOnline = (): void => void sendHeartbeat();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [sendHeartbeat]);

  // Never play unbilled: pause whenever the session cannot be confirmed or has stopped.
  const autoPause = options.onAutoPause;
  useEffect(() => {
    if (mustPause(state)) {
      videoRef.current?.pause();
      autoPause?.();
    }
  }, [state, videoRef, autoPause]);

  // Close the session when the page goes away.
  useEffect(() => {
    const onPageHide = (): void => {
      const s = stateRef.current;
      if (!s.sessionId || endedSent.current === s.sessionId || (s.phase !== 'active' && s.phase !== 'reconnecting')) return;
      endedSent.current = s.sessionId;
      const blob = new Blob([JSON.stringify({ endToken: s.endToken })], { type: 'application/json' });
      if (!navigator.sendBeacon?.(`${API_BASE}/watch/sessions/${encodeURIComponent(s.sessionId)}/end`, blob)) {
        void watchApi.end(s.sessionId, s.endToken ?? undefined).catch(() => undefined);
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Route change / unmount: end the session explicitly.
      const s = stateRef.current;
      startAbort.current?.abort();
      if (s.sessionId && endedSent.current !== s.sessionId && (s.phase === 'active' || s.phase === 'reconnecting')) {
        endedSent.current = s.sessionId;
        void watchApi.end(s.sessionId, s.endToken ?? undefined).catch(() => undefined);
      }
    };
  }, [videoId]);

  const begin = useCallback(
    async (resumeAt?: number): Promise<boolean> => {
      startAbort.current?.abort();
      const ctl = new AbortController();
      startAbort.current = ctl;
      dispatch({ type: 'START' });
      try {
        const response = await watchApi.start(videoId, ctl.signal);
        if (ctl.signal.aborted) return false;
        endedSent.current = null;
        dispatch({ type: 'STARTED', response: resumeAt !== undefined ? { ...response, resumePositionSec: resumeAt } : response });
        return true;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return false;
        if (err instanceof ApiError) dispatch({ type: 'START_FAILED', code: err.code, message: err.message });
        else dispatch({ type: 'START_FAILED', code: 'UNKNOWN', message: err instanceof Error ? err.message : 'Could not start playback' });
        return false;
      }
    },
    [videoId],
  );

  const end = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    if (!s.sessionId || endedSent.current === s.sessionId) return;
    endedSent.current = s.sessionId;
    dispatch({ type: 'ENDED' });
    try {
      await watchApi.end(s.sessionId, s.endToken ?? undefined);
    } catch {
      // The reaper settles abandoned sessions; nothing for the viewer to do.
    }
  }, []);

  const notifyToppedUp = useCallback((availableWei: string) => dispatch({ type: 'TOPPED_UP', availableWei }), []);

  return { state, begin, end, notifyToppedUp };
}
