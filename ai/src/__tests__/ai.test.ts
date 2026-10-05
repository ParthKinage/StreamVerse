import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AiCandidate, AiRecommendRequest } from '@tesor_gp/shared';
import { createApp } from '../app';
import { diversify, recommend, tokenize } from '../scoring';

const day = 86_400_000;
const base = Date.parse('2026-09-01T00:00:00Z');
const cand = (id: string, o: Partial<AiCandidate> = {}): AiCandidate => ({
  id,
  title: `Video ${id}`,
  description: '',
  category: 'General',
  tags: [],
  creatorId: `c-${id}`,
  views: 0,
  createdAt: new Date(base).toISOString(),
  ...o,
});
const req = (o: Partial<AiRecommendRequest> & { candidates: AiCandidate[] }): AiRecommendRequest => ({ limit: 10, history: [], ...o });
const ids = (r: AiRecommendRequest): string[] => recommend(r).map((x) => x.id);

describe('tokenize', () => {
  it('lowercases, splits on punctuation and drops stop words', () => {
    expect(tokenize('The Rust-Lang Guide: for Beginners!')).toEqual(['rust', 'lang', 'guide', 'beginners']);
  });
});

describe('cold start', () => {
  it('orders by popularity and recency with no seed and no history', () => {
    const r = req({
      candidates: [
        cand('old-popular', { views: 10_000, createdAt: new Date(base - 200 * day).toISOString() }),
        cand('new-popular', { views: 9_000, createdAt: new Date(base).toISOString() }),
        cand('new-unseen', { views: 0, createdAt: new Date(base).toISOString() }),
        cand('old-unseen', { views: 0, createdAt: new Date(base - 200 * day).toISOString() }),
      ],
    });
    expect(ids(r)).toEqual(['new-popular', 'old-popular', 'new-unseen', 'old-unseen']);
  });

  it('handles an empty candidate list and a single candidate', () => {
    expect(recommend(req({ candidates: [] }))).toEqual([]);
    expect(ids(req({ candidates: [cand('only')] }))).toEqual(['only']);
  });
});

describe('personalisation', () => {
  const catalog = [
    cand('rust-1', { title: 'Rust ownership explained', tags: ['rust', 'programming'], category: 'Tech', creatorId: 'a' }),
    cand('rust-2', { title: 'Async Rust in depth', tags: ['rust', 'async'], category: 'Tech', creatorId: 'b' }),
    cand('cook-1', { title: 'Perfect pasta', tags: ['cooking', 'italian'], category: 'Food', creatorId: 'c' }),
    cand('cook-2', { title: 'Sourdough basics', tags: ['cooking', 'bread'], category: 'Food', creatorId: 'd' }),
  ];

  it('ranks similar content first when watching a seed video, and never returns the seed', () => {
    const seed = catalog[0]!;
    const out = ids(req({ seedVideo: seed, candidates: catalog }));
    expect(out).not.toContain('rust-1');
    expect(out[0]).toBe('rust-2');
  });

  it('uses watch history (weighted by watch time) and excludes watched videos', () => {
    const out = ids(
      req({
        candidates: catalog,
        history: [
          { category: 'Food', tags: ['cooking', 'bread'], creatorId: 'd', watchedSeconds: 900 },
          { category: 'Tech', tags: ['rust'], creatorId: 'a', watchedSeconds: 10 },
        ],
        watchedVideoIds: ['cook-2'],
      }),
    );
    expect(out).not.toContain('cook-2');
    expect(out[0]).toBe('cook-1');
  });

  it('boosts the affinity of creators the viewer already watches', () => {
    const c = [cand('x1', { creatorId: 'fav', category: 'Misc' }), cand('x2', { creatorId: 'other', category: 'Misc' })];
    const out = ids(req({ candidates: c, history: [{ category: 'Misc', tags: [], creatorId: 'fav', watchedSeconds: 600 }] }));
    expect(out).toEqual(['x1', 'x2']);
  });
});

describe('diversification', () => {
  it('stops one creator from filling the list when others exist', () => {
    const many = Array.from({ length: 8 }, (_, i) => cand(`big-${i}`, { creatorId: 'big', views: 10_000 - i }));
    const few = [cand('s1', { creatorId: 's1', views: 5 }), cand('s2', { creatorId: 's2', views: 4 }), cand('s3', { creatorId: 's3', views: 3 })];
    const out = ids(req({ limit: 5, candidates: [...many, ...few] }));
    expect(out).toHaveLength(5);
    expect(out.filter((i) => i.startsWith('big-')).length).toBeLessThanOrEqual(2);
    expect(out).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
  });

  it('still fills the list when only one creator exists', () => {
    const only = Array.from({ length: 4 }, (_, i) => cand(`m-${i}`, { creatorId: 'm', views: i }));
    expect(ids(req({ limit: 4, candidates: only }))).toHaveLength(4);
    expect(diversify([], 3)).toEqual([]);
  });
});

describe('determinism', () => {
  it('returns identical output for identical input, with ties broken by id', () => {
    const c = ['d', 'b', 'a', 'c'].map((id) => cand(id));
    const first = recommend(req({ candidates: c }));
    expect(recommend(req({ candidates: [...c].reverse() }))).toEqual(first);
    expect(first.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('honours the limit and returns scores in descending order', () => {
    const c = Array.from({ length: 20 }, (_, i) => cand(`v${i}`, { views: i * 10, creatorId: `c${i}` }));
    const out = recommend(req({ limit: 7, candidates: c }));
    expect(out).toHaveLength(7);
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
  });
});

describe('HTTP', () => {
  const app = createApp();
  it('answers /health and /recommend', async () => {
    expect((await supertest(app).get('/health')).body).toEqual({ status: 'ok' });
    const res = await supertest(app).post('/recommend').send(req({ candidates: [cand('a', { views: 3 }), cand('b', { views: 9 })] }));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(['b', 'a']);
  });

  it('rejects invalid input and malformed JSON with 400', async () => {
    const bad = await supertest(app).post('/recommend').send({ limit: 0, history: [], candidates: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const malformed = await supertest(app).post('/recommend').set('content-type', 'application/json').send('{oops');
    expect(malformed.status).toBe(400);
    expect((await supertest(app).get('/nope')).status).toBe(404);
  });

  it('responds quickly for a full-size request (1000 candidates)', async () => {
    const c = Array.from({ length: 1000 }, (_, i) => cand(`v${i}`, { title: `topic ${i % 17} video`, tags: [`t${i % 11}`], views: i, creatorId: `c${i % 40}` }));
    const t0 = Date.now();
    const res = await supertest(app).post('/recommend').send(req({ limit: 20, candidates: c, seedVideo: c[3]! }));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(20);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
