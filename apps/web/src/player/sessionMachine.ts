import { LOW_BALANCE_SECONDS, type HeartbeatResponse, type StartSessionResponse } from '@tesor_gp/shared';

/**
 * Pure state machine for a billed watch session. The hook that owns timers and network calls feeds it events;
 * everything the UI shows (cost meter, banners, whether to pause) is derived from this state.
 */
export type PlayerActivity = 'playing' | 'paused' | 'buffering';
export type SessionPhase = 'idle' | 'starting' | 'active' | 'reconnecting' | 'stopped' | 'ended' | 'error';
export type EndKind = 'user' | 'superseded' | 'timeout' | 'access' | 'unknown';

export const MISSED_BEATS_BEFORE_PAUSE = 2;

export interface SessionState {
  phase: SessionPhase;
  sessionId: string | null;
  endToken: string | null;
  manifestUrl: string | null;
  playerState: PlayerActivity;
  /** Sequence of the next heartbeat. A failed heartbeat is retried with the same value. */
  nextSequence: number;
  missedBeats: number;
  heartbeatIntervalSec: number;
  free: boolean;
  /** The rate this session is billed at (per minute, charged per second sent). */
  ratePerMinuteWei: string;
  /** Seconds of this video already paid for (free to watch again). */
  paidSeconds: number;
  /** Always null since per-second billing replaced the timed unlock; kept for older responses. */
  accessUntil: string | null;
  resumePositionSec: number;
  verifiedSeconds: number;
  chargedWei: string;
  availableWei: string;
  secondsRemaining: number | null;
  lowBalance: boolean;
  endKind: EndKind | null;
  errorCode: string | null;
  message: string | null;
}

export type SessionEvent =
  | { type: 'START' }
  | { type: 'STARTED'; response: StartSessionResponse }
  | { type: 'START_FAILED'; code: string; message: string }
  | { type: 'PLAYER_STATE'; state: PlayerActivity }
  | { type: 'BEAT_OK'; response: HeartbeatResponse }
  | { type: 'BEAT_NETWORK_FAILED' }
  | { type: 'BEAT_REJECTED'; code: string; message: string; endReason?: string | null }
  | { type: 'TOPPED_UP'; availableWei: string }
  | { type: 'ENDED' }
  | { type: 'RESET' };

export const initialSessionState: SessionState = {
  phase: 'idle',
  sessionId: null,
  endToken: null,
  manifestUrl: null,
  playerState: 'paused',
  nextSequence: 1,
  missedBeats: 0,
  heartbeatIntervalSec: 10,
  free: false,
  ratePerMinuteWei: '0',
  paidSeconds: 0,
  accessUntil: null,
  resumePositionSec: 0,
  verifiedSeconds: 0,
  chargedWei: '0',
  availableWei: '0',
  secondsRemaining: null,
  lowBalance: false,
  endKind: null,
  errorCode: null,
  message: null,
};

function endKindFor(reason: string | null | undefined): EndKind {
  switch (reason) {
    case 'SUPERSEDED':
      return 'superseded';
    case 'TIMEOUT':
      return 'timeout';
    case 'ACCESS_EXPIRED':
      return 'access';
    case 'USER_ENDED':
    case 'USER':
      return 'user';
    default:
      return 'unknown';
  }
}

export const END_MESSAGES: Record<EndKind, string> = {
  user: 'Session ended.',
  superseded: 'Playback started in another tab or device, so this session was ended.',
  timeout: 'This session timed out because we stopped hearing from the player. Press play to start a new one.',
  access: 'Your balance has run out, so playback stopped. The seconds you have paid for stay free to watch again.',
  unknown: 'This session has ended.',
};

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'START':
      return { ...initialSessionState, phase: 'starting', playerState: 'paused' };
    case 'STARTED': {
      const r = event.response;
      return {
        ...initialSessionState,
        phase: 'active',
        sessionId: r.sessionId,
        endToken: r.endToken,
        manifestUrl: r.manifestUrl,
        heartbeatIntervalSec: r.heartbeatIntervalSec,
        free: r.free,
        ratePerMinuteWei: r.ratePerMinuteWei ?? '0',
        paidSeconds: r.paidSeconds ?? 0,
        accessUntil: r.accessUntil,
        resumePositionSec: r.resumePositionSec,
        availableWei: r.availableWei,
        playerState: 'paused',
      };
    }
    case 'START_FAILED':
      return { ...state, phase: 'error', errorCode: event.code, message: event.message };
    case 'PLAYER_STATE':
      return state.playerState === event.state ? state : { ...state, playerState: event.state };
    case 'BEAT_OK': {
      if (state.phase === 'ended' || state.phase === 'idle') return state;
      const r = event.response;
      const stopped = r.action === 'stop';
      return {
        ...state,
        phase: stopped ? 'stopped' : 'active',
        nextSequence: r.sequence + 1,
        missedBeats: 0,
        verifiedSeconds: r.verifiedSeconds,
        chargedWei: r.chargedWei,
        availableWei: r.availableWei,
        secondsRemaining: r.secondsRemaining,
        paidSeconds: r.paidSeconds ?? state.paidSeconds,
        lowBalance: r.action === 'low_balance' || (!state.free && r.secondsRemaining !== null && r.secondsRemaining < LOW_BALANCE_SECONDS),
        accessUntil: r.accessUntil ?? state.accessUntil,
        message: stopped ? END_MESSAGES.access : null,
        endKind: stopped ? 'access' : null,
      };
    }
    case 'BEAT_NETWORK_FAILED': {
      if (state.phase !== 'active' && state.phase !== 'reconnecting') return state;
      const missed = state.missedBeats + 1;
      return { ...state, missedBeats: missed, phase: missed >= MISSED_BEATS_BEFORE_PAUSE ? 'reconnecting' : state.phase };
    }
    case 'BEAT_REJECTED': {
      if (event.code === 'SESSION_NOT_ACTIVE') {
        const kind = endKindFor(event.endReason);
        return { ...state, phase: kind === 'access' ? 'stopped' : 'ended', endKind: kind, message: END_MESSAGES[kind] };
      }
      if (event.code === 'ACCESS_EXPIRED') return { ...state, phase: 'stopped', endKind: 'access', message: END_MESSAGES.access };
      return { ...state, phase: 'error', errorCode: event.code, message: event.message };
    }
    case 'TOPPED_UP':
      return { ...state, availableWei: event.availableWei, lowBalance: false };
    case 'ENDED':
      return { ...state, phase: 'ended', endKind: state.endKind ?? 'user', message: state.message ?? END_MESSAGES.user };
    case 'RESET':
      return initialSessionState;
    default:
      return state;
  }
}

/** The video must be paused while we cannot confirm billing, or after the session stopped. */
export function mustPause(state: SessionState): boolean {
  return state.phase === 'reconnecting' || state.phase === 'stopped' || state.phase === 'ended' || state.phase === 'error';
}

export function canSendHeartbeat(state: SessionState, tabHidden: boolean): boolean {
  if (state.phase !== 'active' && state.phase !== 'reconnecting') return false;
  // A hidden tab only keeps the session alive while media is really playing.
  if (tabHidden && state.playerState !== 'playing') return false;
  return true;
}
