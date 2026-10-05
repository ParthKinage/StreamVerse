import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { AiClient } from '../ai-client';
import { CircuitBreaker, createAiClient } from '../ai-client';
import { authed, createHarness, registerUser, resetDb, seedVideo, uniq, type Harness } from '../../test/harness';

let h: Harness;
let aiMode: 'up' | 'down' | 'slow' = 'down';
const fakeAi: AiClient = {
  breaker: new CircuitBreaker(),
  async recommend(req) {
    if (aiMode === 'down') return null;
    if (aiMode === 'slow') await new Promise((r) => setTimeout(r, 3000));
    const items = req.candidates.filter((c) => c.id !== req.seedVideo?.id).slice(0, req.limit).reverse();
    return { items: items.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })) } as never;
  },
  async health() {
    return aiMode !== 'down';
  },
};

beforeAll(async () => {
  h = await createHarness({ overrides: { ai: fakeAi } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.ctx);
  aiMode = 'down';
});

async function admin() {
  const u = await registerUser(h);
  await h.ctx.prisma.user.update({ where: { id: u.id }, data: { role: 'ADMIN' } });
  const login = await h.req().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
  return { ...u, token: login.body.accessToken as string };
}

describe('catalog', () => {
  it('lists only published, completed videos, with search, category filter and stable cursor pagination', async () => {
    const creator = await seedVideo(h, { title: 'Alpha rust guide', category: 'Tech' });
    await seedVideo(h, { title: 'Bravo cooking', category: 'Food', creator });
    await seedVideo(h, { title: 'Charlie rust tools', category: 'Tech', creator });
    await seedVideo(h, { title: 'Hidden', published: false, creator });
    await h.ctx.prisma.video.create({
      data: { title: 'Still processing', description: 'x', creatorId: creator.creatorProfileId, originalFilePath: 'x', priceSTRM: '10', category: 'Tech', tags: [], processingStatus: 'PROCESSING', isPublished: true },
    });

    const all = await h.req().get('/api/v1/videos');
    expect(all.status).toBe(200);
    expect(all.body.items.map((v: { title: string }) => v.title).sort()).toEqual(['Alpha rust guide', 'Bravo cooking', 'Charlie rust tools']);

    const search = await h.req().get('/api/v1/videos?q=rust');
    expect(search.body.items).toHaveLength(2);
    const cat = await h.req().get('/api/v1/videos?category=Food');
    expect(cat.body.items.map((v: { title: string }) => v.title)).toEqual(['Bravo cooking']);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { body: { items: Array<{ id: string }>; nextCursor: string | null } } = await h.req().get(`/api/v1/videos?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const v of page.body.items) {
        expect(seen.has(v.id)).toBe(false);
        seen.add(v.id);
      }
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 5);
    expect(seen.size).toBe(3);
    expect(pages).toBe(2);
  });

  it('serves detail, categories, creator profile and thumbnail; hides unpublished videos', async () => {
    const v = await seedVideo(h, { title: 'Detail me', category: 'Music' });
    const hidden = await seedVideo(h, { published: false, creator: v });
    const detail = await h.req().get(`/api/v1/videos/${v.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe('Detail me');
    expect(detail.body.priceWei).toBe('5000000000000000000');
    expect((await h.req().get(`/api/v1/videos/${hidden.id}`)).status).toBe(404);
    expect((await h.req().get('/api/v1/videos/nope')).status).toBe(404);
    expect((await h.req().get('/api/v1/categories')).body.categories.map((c: { name: string }) => c.name)).toContain('Music');
    const profile = await h.req().get(`/api/v1/creators/${v.creatorProfileId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.videoCount).toBe(1);
    const thumb = await h.req().get(`/api/v1/videos/${v.id}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/jpeg');
  });

  it('rejects invalid query parameters with a validation error', async () => {
    const r = await h.req().get('/api/v1/videos?limit=0');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('creator studio', () => {
  const upload = (token: string, file: string, fields: Record<string, string>, mime = 'video/mp4', name = 'clip.mp4') => {
    let r = h.req().post('/api/v1/creator/videos').set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, { filename: name, contentType: mime });
  };

  it('uploads, queues transcoding, then publishes and archives', async () => {
    const user = await registerUser(h);
    expect((await authed(h, user).post('/api/v1/creator/profile').send({ channelName: 'My Channel' })).status).toBe(201);
    const source = path.join(inject('fixtureDir'), 'source.mp4');
    const res = await upload(user.token, source, { title: 'First upload', description: 'hello', category: 'Tech', tags: 'a,b', priceWei: '500000000000000000' });
    expect(res.status).toBe(201);
    expect(res.body.processingStatus).toBe('PENDING');
    expect(res.body.isPublished).toBe(false);
    const id = res.body.id as string;
    expect(await h.ctx.queues.transcode.getJobCounts('waiting')).toMatchObject({ waiting: 1 });

    // cannot publish before processing completes
    expect((await authed(h, user).post(`/api/v1/creator/videos/${id}/publish`)).status).toBe(409);
    await h.ctx.prisma.video.update({ where: { id }, data: { processingStatus: 'COMPLETED', hlsManifestPath: '/x' } });
    const pub = await authed(h, user).post(`/api/v1/creator/videos/${id}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body.isPublished).toBe(true);
    expect((await h.req().get(`/api/v1/videos/${id}`)).status).toBe(200);

    const edited = await authed(h, user).patch(`/api/v1/creator/videos/${id}`).send({ title: 'Renamed' });
    expect(edited.body.title).toBe('Renamed');
    const mine = await authed(h, user).get('/api/v1/creator/videos');
    expect(mine.body.items).toHaveLength(1);

    expect((await authed(h, user).delete(`/api/v1/creator/videos/${id}`)).status).toBe(204);
    expect((await h.req().get(`/api/v1/videos/${id}`)).status).toBe(404);
    expect((await authed(h, user).get('/api/v1/creator/videos')).body.items).toHaveLength(0);
  });

  it('rejects wrong types, non-video content and over-priced videos; cleans up the file', async () => {
    const user = await registerUser(h);
    await authed(h, user).post('/api/v1/creator/profile').send({ channelName: 'Tiny Channel' });
    const before = fs.readdirSync(h.uploadDir).length;
    const fields = { title: 'Bad', description: 'x', category: 'Tech' };

    const txt = path.join(h.uploadDir, '..', 'note.txt');
    fs.writeFileSync(txt, 'hello');
    const wrongType = await upload(user.token, txt, fields, 'text/plain', 'note.txt');
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('UPLOAD_INVALID');

    const fake = path.join(h.uploadDir, '..', 'fake.mp4');
    fs.writeFileSync(fake, Buffer.from('this is not a video at all'));
    const notVideo = await upload(user.token, fake, fields);
    expect(notVideo.status).toBe(400);
    expect(notVideo.body.error.code).toBe('UPLOAD_INVALID');

    const pricey = await upload(user.token, path.join(inject('fixtureDir'), 'source.mp4'), { ...fields, priceWei: '1000000000000000000000000' });
    expect(pricey.status).toBe(400);
    expect(fs.readdirSync(h.uploadDir).length).toBe(before);
    expect(await h.ctx.prisma.video.count()).toBe(0);
  });

  it("forbids access to another creator's video and non-creators", async () => {
    const owner = await seedVideo(h);
    const other = await registerUser(h);
    expect((await authed(h, other).get('/api/v1/creator/videos')).status).toBe(403);
    await authed(h, other).post('/api/v1/creator/profile').send({ channelName: 'Other' });
    expect((await authed(h, other).patch(`/api/v1/creator/videos/${owner.id}`).send({ title: 'hijack' })).status).toBe(404);
    expect((await authed(h, other).delete(`/api/v1/creator/videos/${owner.id}`)).status).toBe(404);
    expect((await h.req().get('/api/v1/creator/earnings')).status).toBe(401);
  });

  it('reports analytics and earnings from verified data only', async () => {
    const v = await seedVideo(h);
    const analytics = await authed(h, v.creatorUser).get('/api/v1/creator/analytics');
    expect(analytics.status).toBe(200);
    const earnings = await authed(h, v.creatorUser).get('/api/v1/creator/earnings');
    expect(earnings.status).toBe(200);
    expect(earnings.body.claimableWei).toBe('0');
  });
});

describe('recommendations', () => {
  it('uses the AI ranking when the service is up and excludes the seed video', async () => {
    const a = await seedVideo(h, { title: 'A' });
    const b = await seedVideo(h, { title: 'B', creator: a });
    const c = await seedVideo(h, { title: 'C', creator: a });
    aiMode = 'up';
    const res = await h.req().get(`/api/v1/recommendations?videoId=${a.id}&limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('ai');
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(a.id);
    expect(new Set(ids)).toEqual(new Set([b.id, c.id]));
  });

  it('falls back to trending when the AI service is down', async () => {
    await seedVideo(h, { title: 'Only' });
    aiMode = 'down';
    const res = await h.req().get('/api/v1/recommendations');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('fallback');
    expect(res.body.items).toHaveLength(1);
  });

  it('falls back within 1 s when the real AI client times out, and trips the circuit breaker', async () => {
    const client = createAiClient('http://127.0.0.1:9', 300, (() => new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), 20))) as typeof fetch);
    for (let i = 0; i < 5; i++) expect(await client.recommend({ limit: 1, candidates: [], history: [], watchedVideoIds: [] } as never)).toBeNull();
    expect(client.breaker.state).toBe('open');
    const t0 = Date.now();
    expect(await client.recommend({ limit: 1, candidates: [], history: [], watchedVideoIds: [] } as never)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);

    const hung = createAiClient('http://127.0.0.1:9', 300, ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch);
    const t1 = Date.now();
    expect(await hung.recommend({ limit: 1, candidates: [], history: [], watchedVideoIds: [] } as never)).toBeNull();
    expect(Date.now() - t1).toBeLessThan(1000);
  });

  it('half-opens the breaker after the reset window and recovers on success', () => {
    let now = 0;
    const b = new CircuitBreaker(2, 1000, () => now);
    b.failure();
    b.failure();
    expect(b.state).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    now = 1500;
    expect(b.state).toBe('half-open');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // only one probe
    b.success();
    expect(b.state).toBe('closed');
  });
});

describe('social', () => {
  it('toggles likes and the watchlist and lists the watchlist', async () => {
    const v = await seedVideo(h);
    const user = await registerUser(h);
    const api = authed(h, user);
    expect((await api.post(`/api/v1/videos/${v.id}/like`)).body).toEqual({ liked: true, likesCount: 1 });
    expect((await api.post(`/api/v1/videos/${v.id}/like`)).body).toEqual({ liked: false, likesCount: 0 });
    expect((await api.post(`/api/v1/videos/${v.id}/watchlist`)).body).toEqual({ inWatchlist: true });
    const list = await api.get('/api/v1/me/watchlist');
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([v.id]);
    expect((await api.post(`/api/v1/videos/${v.id}/watchlist`)).body).toEqual({ inWatchlist: false });
    expect((await api.post('/api/v1/videos/missing/like')).status).toBe(404);
    expect((await h.req().post(`/api/v1/videos/${v.id}/like`)).status).toBe(401);
  });
});

describe('admin and ops', () => {
  it('guards admin routes by role and lists users and videos', async () => {
    const v = await seedVideo(h, { title: 'Moderate me' });
    const normal = await registerUser(h);
    expect((await authed(h, normal).get('/api/v1/admin/users')).status).toBe(403);
    expect((await h.req().get('/api/v1/admin/users')).status).toBe(401);
    const a = await admin();
    const users = await authed(h, a).get('/api/v1/admin/users?q=' + a.username);
    expect(users.status).toBe(200);
    expect(users.body.items).toHaveLength(1);
    const vids = await authed(h, a).get('/api/v1/admin/videos');
    expect(vids.body.items.some((i: { id: string }) => i.id === v.id)).toBe(true);
    const unpub = await authed(h, a).post(`/api/v1/admin/videos/${v.id}/unpublish`);
    expect(unpub.body.isPublished).toBe(false);
    expect((await h.req().get(`/api/v1/videos/${v.id}`)).status).toBe(404);
    expect((await authed(h, a).post('/api/v1/admin/videos/none/unpublish')).status).toBe(404);
    const health = await authed(h, a).get('/api/v1/admin/health');
    expect(health.status).toBe(200);
    expect(health.body.details).toHaveProperty('queues');
  });

  it('reports liveness and readiness, degrading (not failing) when the AI service is down', async () => {
    expect((await h.req().get('/health')).status).toBe(200);
    aiMode = 'up';
    const ok = await h.req().get('/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ok', postgres: 'up', redis: 'up', chain: 'up', ai: 'up' });
    aiMode = 'down';
    const degraded = await h.req().get('/ready');
    expect(degraded.status).toBe(200);
    expect(degraded.body).toMatchObject({ status: 'degraded', ai: 'down' });
  });

  it('answers unknown routes and malformed JSON with the standard error shape', async () => {
    const nf = await h.req().get('/api/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBeTruthy();
    const bad = await h.req().post('/api/v1/auth/login').set('content-type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBeTruthy();
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the auth limit is exceeded', async () => {
    const limited = await createHarness({ env: { AUTH_RATE_LIMIT_MAX: '3' }, useChain: false });
    try {
      const statuses: number[] = [];
      let last;
      for (let i = 0; i < 5; i++) {
        last = await limited.req().post('/api/v1/auth/login').send({ email: `${uniq('x')}@example.test`, password: 'Passw0rd!123' });
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(3)).toEqual([429, 429]);
      expect(last?.body.error.code).toBe('RATE_LIMITED');
      expect(last?.headers['retry-after']).toBeTruthy();
    } finally {
      await limited.close();
    }
  });
});
