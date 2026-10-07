import { describe, expect, it } from 'vitest';
import { describeFailure, isTransientStatus, networkRetryDelayMs, problemFromVideo, sendCredentials } from './errors';

describe('playback problems', () => {
  it('names each failure the way a viewer understands it, with the right retry', () => {
    expect(describeFailure({ type: 'networkError', status: 403, playlist: true })).toMatchObject({ kind: 'not-authorised', retry: 'new-session' });
    expect(describeFailure({ type: 'networkError', status: 401, playlist: false })).toMatchObject({ kind: 'not-authorised', retry: 'new-session' });
    expect(describeFailure({ type: 'networkError', status: 404, playlist: true })).toMatchObject({ kind: 'not-found', retry: 'none' });
    expect(describeFailure({ type: 'networkError', status: 404, playlist: false })).toMatchObject({ kind: 'not-found', retry: 'reload' });
    expect(describeFailure({ type: 'networkError', status: 0, playlist: false })).toMatchObject({ kind: 'network', retry: 'reload' });
    expect(describeFailure({ type: 'networkError', status: 503, playlist: true }).message).toMatch(/connection/);
    expect(describeFailure({ type: 'mediaError', playlist: false })).toMatchObject({ kind: 'media' });
    expect(describeFailure({ type: 'otherError', playlist: false })).toMatchObject({ kind: 'unsupported' });
  });

  it('explains videos that are not ready before any request is made', () => {
    expect(problemFromVideo({ processingStatus: 'PROCESSING', transcodeProgress: 40, failureReason: null })?.message).toContain('40%');
    expect(problemFromVideo({ processingStatus: 'FAILED', transcodeProgress: 0, failureReason: 'The video files are no longer in storage.' })).toMatchObject({
      kind: 'not-found',
      message: 'The video files are no longer in storage.',
      retry: 'none',
    });
    expect(problemFromVideo({ processingStatus: 'COMPLETED', transcodeProgress: 100, failureReason: null })).toBeNull();
  });

  it('retries only failures that can fix themselves', () => {
    expect([undefined, 0, 429, 500, 503].map(isTransientStatus)).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404].map(isTransientStatus)).toEqual([false, false, false, false]);
  });

  it('backs off between network retries, up to a cap', () => {
    expect([0, 1, 2, 3, 10].map(networkRetryDelayMs)).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('sends cookies only to our own origin, never to signed storage URLs', () => {
    const origin = 'https://stream-verse-opal.vercel.app';
    expect(sendCredentials('/playback/s1/master.m3u8', origin)).toBe(true);
    expect(sendCredentials(`${origin}/playback/s1/360p/index.m3u8`, origin)).toBe(true);
    expect(sendCredentials('https://s3.us-east-005.backblazeb2.com/b/hls/v/1/360p/seg_000.ts?X-Amz-Signature=x', origin)).toBe(false);
  });
});
