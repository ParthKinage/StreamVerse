import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authed, createHarness, registerUser, resetDb, seedVideo, type Harness } from '../../test/harness';
import { createAiClient } from '../ai-client';
import { Memo } from '../../middleware/http-cache';
import { reconcileMissingMedia } from '../media';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => resetDb(h.ctx));

describe('caching', () => {
  it('lets the edge cache anonymous catalog responses and never a signed-in one', async () => {
    await seedVideo(h, { linkCreatorWallet: false });
    for (const path of ['/api/v1/videos', '/api/v1/categories', '/api/v1/config']) {
      const anon = await h.req().get(path);
      expect(anon.status).toBe(200);
      expect(anon.headers['cache-control'], path).toMatch(/^public, max-age=0, s-maxage=\d+, stale-while-revalidate=\d+$/);
      expect(anon.headers.vary, path).toContain('Authorization');
    }
    const user = await registerUser(h);
    const signedIn = await authed(h, user).get('/api/v1/videos');
    expect(signedIn.headers['cache-control']).toBe('private, no-store');
  });

  it('marks everything else private and never stored', async () => {
    const user = await registerUser(h);
    expect((await authed(h, user).get('/api/v1/wallet/summary')).headers['cache-control']).toBe('private, no-store');
    expect((await authed(h, user).get('/api/v1/me/history')).headers['cache-control']).toBe('private, no-store');
    expect((await h.req().post('/api/v1/auth/login').send({ email: 'x@example.test', password: 'nope' })).headers['cache-control']).toBe('private, no-store');
  });

  it('computes shared values once per window', async () => {
    let now = 0;
    let loads = 0;
    const memo = new Memo<number>(1000, () => now);
    const load = async () => ++loads;
    expect(await Promise.all([memo.get(load), memo.get(load), memo.get(load)])).toEqual([1, 1, 1]); // concurrent callers share one load
    now = 999;
    expect(await memo.get(load)).toBe(1);
    now = 1001;
    expect(await memo.get(load)).toBe(2);
  });
});

describe('response size and timing', () => {
  it('compresses JSON for clients that accept it and reports time spent in the API', async () => {
    for (let i = 0; i < 6; i++) await seedVideo(h, { linkCreatorWallet: false, title: `A video with a long enough title to compress ${i}` });
    const res = await h.req().get('/api/v1/videos').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.items).toHaveLength(6);
    expect(res.headers['server-timing']).toMatch(/^app;dur=\d+(\.\d)?$/);
    const plain = await h.req().get('/api/v1/videos').set('Accept-Encoding', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
  });
});

describe('global rate limit', () => {
  it('counts in memory, without a Redis round trip per request', async () => {
    const strict = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank', RATE_LIMIT_MAX: '3' } });
    const spy = vi.spyOn(strict.ctx.redis, 'call');
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await strict.req().get('/api/v1/categories')).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(spy.mock.calls.filter((c) => String(c[1] ?? '').startsWith('rl:global'))).toHaveLength(0);
    } finally {
      spy.mockRestore();
      await strict.close();
    }
  });
});

describe('recommendations without an AI service', () => {
  it('never makes a network call when AI_SERVICE_URL is not set', async () => {
    const fetchImpl = vi.fn();
    const client = createAiClient(undefined, 800, fetchImpl as unknown as typeof fetch);
    expect(await client.recommend({ userId: 'u', limit: 5, candidates: [] } as never)).toBeNull();
    expect(await client.health()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('missing-media check', () => {
  it('leaves videos changed in the last minutes alone (their files may still be uploading)', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    await h.ctx.prisma.video.update({ where: { id: v.id }, data: { hlsManifestPath: '/nowhere/master.m3u8' } });
    expect((await reconcileMissingMedia(h.ctx)).failed).toEqual([]);
    h.clock.advance(11 * 60);
    expect((await reconcileMissingMedia(h.ctx)).failed).toEqual([v.id]);
  });
});
