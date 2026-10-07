import { describe, expect, it } from 'vitest';
import type { HeartbeatResponse, StartSessionResponse } from '@tesor_gp/shared';
import { canSendHeartbeat, END_MESSAGES, initialSessionState, mustPause, sessionReducer, type SessionEvent, type SessionState } from './sessionMachine';

const started: StartSessionResponse = {
  sessionId: 's1',
  endToken: 'tok',
  manifestUrl: '/playback/s1/master.m3u8',
  heartbeatIntervalSec: 10,
  resumePositionSec: 42,
  availableWei: '10000000000000000000',
  free: false, ratePerMinuteWei: '0', paidSeconds: 0,
  accessUntil: '2026-10-06T10:00:00.000Z',
};
const beat = (over: Partial<HeartbeatResponse> = {}): HeartbeatResponse => ({
  sequence: 1,
  verifiedSeconds: 10,
  chargedWei: '100000000000000000',
  availableWei: '9900000000000000000',
  secondsRemaining: 990,
  action: 'continue',
  ...over,
});
const run = (events: SessionEvent[], from: SessionState = initialSessionState): SessionState => events.reduce(sessionReducer, from);

describe('session state machine', () => {
  it('moves idle -> starting -> active and keeps the start details', () => {
    const s = run([{ type: 'START' }, { type: 'STARTED', response: started }]);
    expect(s).toMatchObject({ phase: 'active', sessionId: 's1', endToken: 'tok', resumePositionSec: 42, nextSequence: 1, free: false });
  });

  it('records a failed start with the error code', () => {
    const s = run([{ type: 'START' }, { type: 'START_FAILED', code: 'INSUFFICIENT_BALANCE', message: 'Top up' }]);
    expect(s).toMatchObject({ phase: 'error', errorCode: 'INSUFFICIENT_BALANCE', message: 'Top up' });
    expect(mustPause(s)).toBe(true);
  });

  it('advances the sequence only after a successful heartbeat and updates the meter', () => {
    let s = run([{ type: 'START' }, { type: 'STARTED', response: started }]);
    expect(s.nextSequence).toBe(1);
    s = run([{ type: 'BEAT_OK', response: beat({ sequence: 1 }) }], s);
    expect(s).toMatchObject({ nextSequence: 2, verifiedSeconds: 10, chargedWei: '100000000000000000', lowBalance: false });
    s = run([{ type: 'BEAT_NETWORK_FAILED' }], s);
    expect(s.nextSequence).toBe(2); // the retry reuses the same sequence
  });

  it('shows reconnecting and pauses after two missed heartbeats, then recovers', () => {
    let s = run([{ type: 'START' }, { type: 'STARTED', response: started }, { type: 'BEAT_NETWORK_FAILED' }]);
    expect(s.phase).toBe('active');
    expect(mustPause(s)).toBe(false);
    s = run([{ type: 'BEAT_NETWORK_FAILED' }], s);
    expect(s.phase).toBe('reconnecting');
    expect(mustPause(s)).toBe(true);
    s = run([{ type: 'BEAT_OK', response: beat() }], s);
    expect(s).toMatchObject({ phase: 'active', missedBeats: 0 });
    expect(mustPause(s)).toBe(false);
  });

  it('flags low balance without stopping, and clears it after a top-up', () => {
    let s = run([{ type: 'START' }, { type: 'STARTED', response: started }, { type: 'BEAT_OK', response: beat({ action: 'low_balance', secondsRemaining: 90 }) }]);
    expect(s).toMatchObject({ phase: 'active', lowBalance: true });
    expect(mustPause(s)).toBe(false);
    s = run([{ type: 'TOPPED_UP', availableWei: '5000000000000000000' }], s);
    expect(s.lowBalance).toBe(false);
  });

  it('stops on action=stop, keeping the verified numbers', () => {
    const s = run([{ type: 'START' }, { type: 'STARTED', response: started }, { type: 'BEAT_OK', response: beat({ action: 'stop', verifiedSeconds: 100, availableWei: '0' }) }]);
    expect(s).toMatchObject({ phase: 'stopped', endKind: 'access', verifiedSeconds: 100, message: END_MESSAGES.access });
    expect(mustPause(s)).toBe(true);
  });

  it('maps a rejected heartbeat to why the session ended', () => {
    const base = run([{ type: 'START' }, { type: 'STARTED', response: started }]);
    expect(run([{ type: 'BEAT_REJECTED', code: 'SESSION_NOT_ACTIVE', message: 'x', endReason: 'SUPERSEDED' }], base)).toMatchObject({ phase: 'ended', endKind: 'superseded', message: END_MESSAGES.superseded });
    expect(run([{ type: 'BEAT_REJECTED', code: 'SESSION_NOT_ACTIVE', message: 'x', endReason: 'TIMEOUT' }], base)).toMatchObject({ phase: 'ended', endKind: 'timeout' });
    expect(run([{ type: 'BEAT_REJECTED', code: 'SESSION_NOT_ACTIVE', message: 'x', endReason: 'ACCESS_EXPIRED' }], base)).toMatchObject({ phase: 'stopped', endKind: 'access' });
    expect(run([{ type: 'BEAT_REJECTED', code: 'SEQUENCE_CONFLICT', message: 'out of sequence' }], base)).toMatchObject({ phase: 'error', errorCode: 'SEQUENCE_CONFLICT' });
  });

  it('ignores late heartbeat results after the session ended', () => {
    const s = run([{ type: 'START' }, { type: 'STARTED', response: started }, { type: 'ENDED' }, { type: 'BEAT_OK', response: beat() }]);
    expect(s.phase).toBe('ended');
    expect(s.verifiedSeconds).toBe(0);
  });

  it('only sends heartbeats from a hidden tab while media is really playing', () => {
    let s = run([{ type: 'START' }, { type: 'STARTED', response: started }]);
    expect(canSendHeartbeat(s, false)).toBe(true); // visible: paused heartbeats keep the session alive
    expect(canSendHeartbeat(s, true)).toBe(false); // hidden and paused
    s = run([{ type: 'PLAYER_STATE', state: 'playing' }], s);
    expect(canSendHeartbeat(s, true)).toBe(true);
    s = run([{ type: 'ENDED' }], s);
    expect(canSendHeartbeat(s, false)).toBe(false);
  });
});
