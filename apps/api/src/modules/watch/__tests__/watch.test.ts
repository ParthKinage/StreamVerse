import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, registerUser, resetDb, seedVideo, seedViewer, type Harness, type Viewer } from '../../../test/harness';
import { reapStaleSessions } from '..';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.ctx);
});

const PRICE = parseEther('5'); // default price of a seeded video

/** Tries to unlock the video first (a no-op error for free videos), then starts a session. Pass buy:false to skip the purchase. */
async function start(viewer: Viewer, videoId: string, opts: { buy?: boolean } = {}) {
  if (opts.buy !== false) await authed(h, viewer.user).post(`/api/v1/videos/${videoId}/purchase`).send({});
  return authed(h, viewer.user).post('/api/v1/watch/sessions').send({ videoId });
}

async function beat(viewer: Viewer, sid: string, seq: number, opts: { advance?: number; state?: 'playing' | 'paused' | 'buffering'; t?: number } = {}) {
  h.clock.advance(opts.advance ?? 10);
  return authed(h, viewer.user)
    .post(`/api/v1/watch/sessions/${sid}/heartbeat`)
    .send({ sequence: seq, playbackTime: opts.t ?? seq * 10, state: opts.state ?? 'playing' });
}

describe('starting a session', () => {
  it('returns a manifest URL, heartbeat interval and a path-scoped httpOnly playback cookie', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const res = await start(viewer, video.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ heartbeatIntervalSec: 10, resumePositionSec: 0, free: false });
    expect(new Date(res.body.accessUntil).getTime()).toBe(h.clock.now().getTime() + 48 * 3_600_000);
    expect(res.body.manifestUrl).toBe(`/playback/${res.body.sessionId}/master.m3u8`);
    expect(res.body.availableWei).toBe(parseEther('5').toString());
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pbt='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toContain(`Path=/playback/${res.body.sessionId}/`);
  });

  it('needs a purchase first; buying needs a linked wallet and enough balance', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const unbought = await start(viewer, video.id, { buy: false });
    expect(unbought.status).toBe(402);
    expect(unbought.body.error.code).toBe('PURCHASE_REQUIRED');
    expect(unbought.body.error.details.priceWei).toBe(PRICE.toString());

    const noWallet = { user: await registerUser(h) } as Viewer;
    const r1 = await authed(h, noWallet.user).post(`/api/v1/videos/${video.id}/purchase`).send({});
    expect(r1.status).toBe(402);
    expect(r1.body.error.code).toBe('WALLET_NOT_LINKED');

    const broke = await seedViewer(h, '0');
    const r2 = await authed(h, broke.user).post(`/api/v1/videos/${video.id}/purchase`).send({});
    expect(r2.status).toBe(402);
    expect(r2.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(r2.body.error.details.requiredWei).toBe(PRICE.toString());
    expect((await start(broke, video.id, { buy: false })).body.error.code).toBe('PURCHASE_REQUIRED');
  });

  it('refuses unpublished, unknown, and creators without a wallet', async () => {
    const viewer = await seedViewer(h, '10');
    const hidden = await seedVideo(h, { published: false });
    expect((await start(viewer, hidden.id)).body.error.code).toBe('VIDEO_NOT_AVAILABLE');
    expect((await start(viewer, 'nope')).status).toBe(404);
    const noPayout = await seedVideo(h, { linkCreatorWallet: false });
    const buy = await authed(h, viewer.user).post(`/api/v1/videos/${noPayout.id}/purchase`).send({});
    expect(buy.body.error.code).toBe('VIDEO_NOT_AVAILABLE');
  });

  it('lets anyone watch free videos and creators watch their own videos for free', async () => {
    const freeVideo = await seedVideo(h, { priceStrm: '0' });
    const noWallet = { user: await registerUser(h) } as Viewer;
    const r = await start(noWallet, freeVideo.id);
    expect(r.status).toBe(201);
    expect(r.body.free).toBe(true);

    const paid = await seedVideo(h);
    const owner = { user: paid.creatorUser, wallet: paid.creatorWallet } as Viewer;
    const own = await start(owner, paid.id);
    expect(own.status).toBe(201);
    expect(own.body.free).toBe(true);
    const hb = await beat(owner, own.body.sessionId, 1);
    expect(hb.body.chargedWei).toBe('0');
    expect(hb.body.action).toBe('continue');
  });

  it('allows one concurrent stream: starting another ends the first and settles it', async () => {
    const v1 = await seedVideo(h);
    const v2 = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const first = await start(viewer, v1.id);
    await beat(viewer, first.body.sessionId, 1);
    const second = await start(viewer, v2.id);
    expect(second.status).toBe(201);
    const stale = await beat(viewer, first.body.sessionId, 2);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(stale.body.error.details.endReason).toBe('SUPERSEDED');
    const ended = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: first.body.sessionId } });
    expect(ended.status).toBe('COMPLETED');
    expect(ended.endReason).toBe('SUPERSEDED');
  });
});

describe('heartbeats', () => {
  it('credits server wall-clock time and never charges for watching (the price was paid when unlocking)', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const hb = await beat(viewer, body.sessionId, 1, { advance: 10 });
    expect(hb.status).toBe(200);
    expect(hb.body.verifiedSeconds).toBe(10);
    expect(hb.body.chargedWei).toBe('0');
    expect(hb.body.availableWei).toBe(parseEther('5').toString());
    expect(hb.body.action).toBe('continue');
    const hb2 = await beat(viewer, body.sessionId, 2, { advance: 10 });
    expect(hb2.body.verifiedSeconds).toBe(20);
    expect(hb2.body.chargedWei).toBe('0');
    expect(hb2.body.availableWei).toBe(parseEther('5').toString());
  });

  it('is idempotent: a replayed heartbeat returns the stored response and never double-charges', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const first = await beat(viewer, body.sessionId, 1);
    h.clock.advance(7);
    const replay = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/heartbeat`).send({ sequence: 1, playbackTime: 10, state: 'playing' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const row = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(row.verifiedDurationSeconds).toBe(10);
    expect(await h.ctx.prisma.watchHeartbeat.count({ where: { sessionId: body.sessionId } })).toBe(1);
  });

  it('rejects a skipped or out-of-order sequence with 409 and does not bill it', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    await beat(viewer, body.sessionId, 1);
    const skipped = await beat(viewer, body.sessionId, 3);
    expect(skipped.status).toBe(409);
    expect(skipped.body.error.code).toBe('SEQUENCE_CONFLICT');
    expect(skipped.body.error.details.expected).toBe(2);
    const old = await beat(viewer, body.sessionId, 0, { advance: 0 });
    expect(old.status).toBe(409);
    const row = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(row.verifiedDurationSeconds).toBe(10);
  });

  it('credits at most the wall-clock time when heartbeats are flooded', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    for (let seq = 1; seq <= 30; seq++) {
      const r = await beat(viewer, body.sessionId, seq, { advance: 0.1, t: 9999 });
      expect(r.status).toBe(200);
    }
    // 30 beats over 3 s of wall time
    const row = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(row.verifiedDurationSeconds).toBeLessThanOrEqual(3);
    expect(row.verifiedDurationSeconds).toBeGreaterThanOrEqual(2); // fractional remainders carry, nothing is lost
  });

  it('caps credit per heartbeat at interval + grace (a long gap is not billed in full)', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const hb = await beat(viewer, body.sessionId, 1, { advance: 60 });
    expect(hb.body.verifiedSeconds).toBe(12);
  });

  it('credits nothing while paused or buffering, and resumes billing from the next playing beat', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const paused = await beat(viewer, body.sessionId, 1, { advance: 10, state: 'paused' });
    expect(paused.body.verifiedSeconds).toBe(0);
    expect(paused.body.chargedWei).toBe('0');
    const buffering = await beat(viewer, body.sessionId, 2, { advance: 10, state: 'buffering' });
    expect(buffering.body.verifiedSeconds).toBe(0);
    const playing = await beat(viewer, body.sessionId, 3, { advance: 10, state: 'playing' });
    expect(playing.body.verifiedSeconds).toBe(10);
  });

  it('stops the session cleanly when paid access runs out, and a new session needs a new purchase', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const sid = body.sessionId as string;
    const first = await beat(viewer, sid, 1);
    expect(first.body.action).toBe('continue');
    expect(first.body.accessUntil).toBe(body.accessUntil);
    const last = await beat(viewer, sid, 2, { advance: 48 * 3600 });
    expect(last.body.action).toBe('stop');
    expect(last.body.reason).toBe('ACCESS_EXPIRED');
    // no cookie renewal on stop
    expect((last.headers['set-cookie'] as unknown as string[] | undefined)?.some((c) => c.startsWith('pbt='))).toBeFalsy();
    const session = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: sid } });
    expect(session.status).toBe('COMPLETED');
    expect(session.endReason).toBe('ACCESS_EXPIRED');
    expect((await beat(viewer, sid, 3)).status).toBe(409);
    expect((await start(viewer, video.id, { buy: false })).body.error.code).toBe('PURCHASE_REQUIRED');
    // buying again works once the old window is over
    const again = await authed(h, viewer.user).post(`/api/v1/videos/${video.id}/purchase`).send({});
    expect(again.status).toBe(200);
    expect(again.body.alreadyUnlocked).toBe(false);
  });

  it("never lets one viewer touch another viewer's session", async () => {
    const video = await seedVideo(h);
    const a = await seedViewer(h, '10');
    const b = await seedViewer(h, '10');
    const { body } = await start(a, video.id);
    const res = await authed(h, b.user).post(`/api/v1/watch/sessions/${body.sessionId}/heartbeat`).send({ sequence: 1, playbackTime: 1, state: 'playing' });
    expect(res.status).toBe(403);
    expect((await authed(h, b.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({})).status).toBe(403);
  });

  it('validates heartbeat bodies', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const res = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/heartbeat`).send({ sequence: -1, playbackTime: 'x', state: 'dancing' });
    expect(res.status).toBe(400);
  });
});

describe('ending sessions', () => {
  it('ends explicitly, charges nothing extra, counts a view at 30 s, and is idempotent', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    for (let i = 1; i <= 4; i++) await beat(viewer, body.sessionId, i);
    const end = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({});
    expect(end.status).toBe(200);
    expect(end.body.verifiedSeconds).toBe(40);
    expect(end.body.chargedWei).toBe('0');
    expect(end.body.settlementId).toBeNull();
    const again = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({});
    expect(again.body.settlementId).toBeNull();
    expect(await h.ctx.prisma.paymentSettlement.count({ where: { userId: viewer.user.id, videoId: video.id } })).toBe(1); // the purchase
    expect((await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id } })).viewsCount).toBe(1);
  });

  it('does not count a view below 30 verified seconds and charges nothing for zero time', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const end = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({});
    expect(end.body.settlementId).toBeNull();
    expect((await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: video.id } })).viewsCount).toBe(0);
  });

  it('accepts the end token from sendBeacon (no Authorization header) and rejects a bad one', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    await beat(viewer, body.sessionId, 1);
    expect((await h.req().post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({})).status).toBe(401);
    expect((await h.req().post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({ endToken: 'forged' })).status).toBe(401);
    const ok = await h.req().post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({ endToken: body.endToken });
    expect(ok.status).toBe(200);
    expect(ok.body.verifiedSeconds).toBe(10);
  });

  it('reaps sessions that stopped heartbeating', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    await beat(viewer, body.sessionId, 1);
    h.clock.advance(20);
    expect(await reapStaleSessions(h.ctx)).toBe(0); // still within the 45 s timeout
    h.clock.advance(40);
    expect(await reapStaleSessions(h.ctx)).toBe(1);
    const session = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(session.status).toBe('COMPLETED');
    expect(session.endReason).toBe('TIMEOUT');
  });

  it('records history and resume position for continue-watching', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    await beat(viewer, body.sessionId, 1, { t: 12.4 });
    await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({});
    const history = await authed(h, viewer.user).get('/api/v1/me/history');
    expect(history.body.items[0]).toMatchObject({ sessionId: body.sessionId, watchedSeconds: 10, lastPositionSec: 12, paidWei: PRICE.toString() });
    const cont = await authed(h, viewer.user).get('/api/v1/me/continue-watching');
    expect(cont.body.items[0]).toMatchObject({ positionSec: 12 });
    expect(cont.body.items[0].video.id).toBe(video.id);
    const next = await start(viewer, video.id);
    expect(next.body.resumePositionSec).toBe(12);
  });
});

describe('playback authorization', () => {
  async function playing(price = '5') {
    const video = await seedVideo(h, { priceStrm: price });
    const viewer = await seedViewer(h, '10');
    const res = await start(viewer, video.id);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pbt='))!.split(';')[0]!;
    return { video, viewer, sid: res.body.sessionId as string, cookie, endToken: res.body.endToken as string };
  }
  const get = (path: string, cookie?: string) => {
    const r = h.req().get(path);
    return cookie ? r.set('Cookie', cookie) : r;
  };

  it('serves the master playlist, variant playlist and segments with a valid cookie', async () => {
    const { sid, cookie } = await playing();
    const master = await get(`/playback/${sid}/master.m3u8`, cookie);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toContain('mpegurl');
    expect(master.text).toContain('360p/index.m3u8');
    const variant = await get(`/playback/${sid}/360p/index.m3u8`, cookie);
    expect(variant.status).toBe(200);
    expect(variant.text).toContain('seg_000.ts');
    const seg = await get(`/playback/${sid}/360p/seg_000.ts`, cookie);
    expect(seg.status).toBe(200);
    expect(seg.headers['content-type']).toContain('video/mp2t');
  });

  it('rejects missing, forged and expired tokens with 401', async () => {
    const { sid, cookie, viewer } = await playing();
    expect((await get(`/playback/${sid}/master.m3u8`)).status).toBe(401);
    expect((await get(`/playback/${sid}/master.m3u8`, 'pbt=garbage')).status).toBe(401);
    expect((await get(`/playback/${sid}/master.m3u8`, `${cookie}x`)).status).toBe(401);
    h.clock.advance(31); // token TTL is 30 s
    const expired = await get(`/playback/${sid}/master.m3u8`, cookie);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('PLAYBACK_TOKEN_INVALID');
    // a heartbeat renews it
    const hb = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${sid}/heartbeat`).send({ sequence: 1, playbackTime: 5, state: 'playing' });
    const renewed = (hb.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pbt='))!.split(';')[0]!;
    expect((await get(`/playback/${sid}/master.m3u8`, renewed)).status).toBe(200);
  });

  it("rejects another session's cookie with 403", async () => {
    const a = await playing();
    const b = await playing();
    const res = await get(`/playback/${b.sid}/master.m3u8`, a.cookie);
    expect(res.status).toBe(403);
  });

  it('stops serving once the session has ended, and blocks path traversal and non-media files', async () => {
    const { sid, cookie, viewer } = await playing();
    expect((await get(`/playback/${sid}/../../etc/passwd`, cookie)).status).toBe(404);
    expect((await get(`/playback/${sid}/%2e%2e/%2e%2e/package.json`, cookie)).status).toBe(404);
    expect((await get(`/playback/${sid}/thumbnail.jpg`, cookie)).status).toBe(404);
    expect((await get(`/playback/${sid}/360p/missing.ts`, cookie)).status).toBe(404);
    await authed(h, viewer.user).post(`/api/v1/watch/sessions/${sid}/end`).send({});
    expect((await get(`/playback/${sid}/master.m3u8`, cookie)).status).toBe(403);
  });

  it('enforces the segment budget: media served cannot run ahead of verified time', async () => {
    const { sid, cookie, viewer } = await playing();
    await get(`/playback/${sid}/360p/index.m3u8`, cookie); // records segment durations (4 s each)
    await new Promise((r) => setTimeout(r, 100));
    // budget with 0 verified seconds = 1.5*0 + 120 = 120 s = 30 segments of 4 s
    let ok = 0;
    let blocked = 0;
    for (let i = 0; i < 33; i++) {
      const r = await get(`/playback/${sid}/360p/seg_000.ts`, cookie);
      if (r.status === 200) ok += 1;
      else if (r.status === 429) {
        blocked += 1;
        expect(r.body.error.code).toBe('SEGMENT_BUDGET_EXCEEDED');
        expect(r.headers['retry-after']).toBe('10');
      }
    }
    expect(ok).toBe(30);
    expect(blocked).toBe(3);
    // a verified heartbeat raises the budget again
    h.clock.advance(10);
    const hb = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${sid}/heartbeat`).send({ sequence: 1, playbackTime: 10, state: 'playing' });
    const renewed = (hb.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pbt='))!.split(';')[0]!;
    expect((await get(`/playback/${sid}/360p/seg_000.ts`, renewed)).status).toBe(200);
  });
});
