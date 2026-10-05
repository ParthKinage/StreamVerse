import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartbeatRequest, HeartbeatResponse, StartSessionResponse } from '@tesor_gp/shared';
import { ApiError } from '../api/client';
import { usePlaybackSession } from './usePlaybackSession';

const api = vi.hoisted(() => ({ start: vi.fn(), heartbeat: vi.fn(), end: vi.fn() }));
vi.mock('../api/endpoints', () => ({ watchApi: api }));

const started: StartSessionResponse = {
  sessionId: 's1',
  endToken: 'tok',
  manifestUrl: '/playback/s1/master.m3u8',
  heartbeatIntervalSec: 10,
  resumePositionSec: 0,
  availableWei: '10000000000000000000',
  free: false,
  accessUntil: '2026-10-06T10:00:00.000Z',
};
const ok = (sequence: number, over: Partial<HeartbeatResponse> = {}): HeartbeatResponse => ({
  sequence,
  verifiedSeconds: sequence * 10,
  chargedWei: String(BigInt(sequence) * 100000000000000000n),
  availableWei: '9000000000000000000',
  secondsRemaining: 900,
  action: 'continue',
  ...over,
});

function makeVideo(): { current: HTMLVideoElement } {
  const el = document.createElement('video');
  Object.defineProperty(el, 'paused', { value: false, configurable: true });
  Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(el, 'currentTime', { value: 12.345, writable: true, configurable: true });
  el.pause = vi.fn();
  return { current: el };
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.start.mockReset().mockResolvedValue(started);
  api.heartbeat.mockReset();
  api.end.mockReset().mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe('usePlaybackSession', () => {
  it('sends a heartbeat every interval with a monotonic sequence and the player position', async () => {
    api.heartbeat.mockImplementation(async (_sid: string, body: HeartbeatRequest) => ok(body.sequence));
    const video = makeVideo();
    const { result } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));
    expect(result.current.state.phase).toBe('active');

    await tick(10_000);
    await tick(10_000);
    await tick(10_000);
    const bodies = api.heartbeat.mock.calls.map((c) => c[1] as HeartbeatRequest);
    expect(bodies.map((b) => b.sequence)).toEqual([1, 2, 3]);
    expect(bodies[0]).toMatchObject({ playbackTime: 12.35, state: 'playing' });
    expect(result.current.state.verifiedSeconds).toBe(30);
    expect(result.current.state.nextSequence).toBe(4);
  });

  it('retries a failed heartbeat with the same sequence and pauses after two misses', async () => {
    const calls: number[] = [];
    let failing = true;
    api.heartbeat.mockImplementation(async (_sid: string, body: HeartbeatRequest) => {
      calls.push(body.sequence);
      if (failing) throw new ApiError(0, 'NETWORK_ERROR', 'offline');
      return ok(body.sequence);
    });
    const video = makeVideo();
    const { result } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));

    await tick(10_000); // miss 1
    expect(result.current.state.phase).toBe('active');
    await tick(10_000); // miss 2
    expect(result.current.state.phase).toBe('reconnecting');
    expect(video.current.pause).toHaveBeenCalled();
    expect(new Set(calls)).toEqual(new Set([1])); // never skipped ahead

    failing = false;
    await tick(3_000); // faster retry cadence while reconnecting
    expect(result.current.state.phase).toBe('active');
    expect(result.current.state.nextSequence).toBe(2);
    expect(calls.at(-1)).toBe(1);
  });

  it('stops playback when the server says access has ended', async () => {
    api.heartbeat.mockResolvedValue(ok(1, { action: 'stop', availableWei: '0', secondsRemaining: 0 }));
    const video = makeVideo();
    const { result } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));
    await tick(10_000);
    expect(result.current.state.phase).toBe('stopped');
    expect(video.current.pause).toHaveBeenCalled();
    await tick(30_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1); // no heartbeats after a stop
  });

  it('shows why a session ended when another tab took over', async () => {
    api.heartbeat.mockRejectedValue(new ApiError(409, 'SESSION_NOT_ACTIVE', 'This session has ended', { endReason: 'SUPERSEDED' }));
    const video = makeVideo();
    const { result } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));
    await tick(10_000);
    expect(result.current.state).toMatchObject({ phase: 'ended', endKind: 'superseded' });
    expect(result.current.state.message).toMatch(/another tab/i);
  });

  it('reports a failed start (for example the video is not unlocked) without a session', async () => {
    api.start.mockRejectedValue(new ApiError(402, 'PURCHASE_REQUIRED', 'Unlock this video to watch it'));
    const video = makeVideo();
    const { result } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));
    expect(result.current.state).toMatchObject({ phase: 'error', errorCode: 'PURCHASE_REQUIRED' });
    await tick(30_000);
    expect(api.heartbeat).not.toHaveBeenCalled();
  });

  it('ends the session when the player unmounts', async () => {
    api.heartbeat.mockImplementation(async (_s: string, b: HeartbeatRequest) => ok(b.sequence));
    const video = makeVideo();
    const { result, unmount } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));
    unmount();
    expect(api.end).toHaveBeenCalledWith('s1', 'tok');
  });

  it('sends a beacon (not a fetch) when the page is closed', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const video = makeVideo();
    const { result } = renderHook(() => usePlaybackSession('v1', video));
    await act(async () => void (await result.current.begin()));
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(String(beacon.mock.calls[0]![0])).toContain('/watch/sessions/s1/end');
    expect(api.end).not.toHaveBeenCalled();
  });
});
