import fs from 'node:fs';
import path from 'node:path';
import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, fetchPiece, playbackCookie, registerUser, resetDb, seedVideo, seedViewer, watchPieces, type Harness, type Viewer } from '../../../test/harness';
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

// Seeded videos: 15 STRM per minute, so each 4-second piece costs 1 STRM and the 24 s fixture 6 STRM in full.
const PIECE = parseEther('1');
const FULL = parseEther('6');

async function start(viewer: Viewer, videoId: string) {
  return authed(h, viewer.user).post('/api/v1/watch/sessions').send({ videoId });
}

async function beat(viewer: Viewer, sid: string, seq: number, opts: { advance?: number; state?: 'playing' | 'paused' | 'buffering'; t?: number } = {}) {
  h.clock.advance(opts.advance ?? 10);
  return authed(h, viewer.user)
    .post(`/api/v1/watch/sessions/${sid}/heartbeat`)
    .send({ sequence: seq, playbackTime: opts.t ?? seq * 10, state: opts.state ?? 'playing' });
}

const sessionCharge = async (sid: string): Promise<bigint> => parseEther((await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: sid } })).chargedSTRM.toFixed());
const available = async (viewer: Viewer): Promise<bigint> => BigInt((await authed(h, viewer.user).get('/api/v1/wallet/summary')).body.availableWei);

describe('starting a session', () => {
  it('returns a manifest URL, the rate, the paid seconds and a path-scoped httpOnly playback cookie', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const res = await start(viewer, video.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ heartbeatIntervalSec: 10, resumePositionSec: 0, free: false, paidSeconds: 0, accessUntil: null });
    expect(res.body.ratePerMinuteWei).toBe(parseEther('15').toString());
    expect(res.body.manifestUrl).toBe(`/playback/${res.body.sessionId}/master.m3u8`);
    expect(res.body.availableWei).toBe(parseEther('10').toString());
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pbt='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toContain(`Path=/playback/${res.body.sessionId}/`);
  });

  it('needs about a minute of balance (or the rest of the video, if shorter) and a linked wallet to start', async () => {
    const video = await seedVideo(h);
    const broke = await seedViewer(h, '0');
    const r = await start(broke, video.id);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(r.body.error.details.requiredWei).toBe(FULL.toString()); // the video is shorter than a minute
    const noWallet = { user: await registerUser(h) } as Viewer;
    expect((await start(noWallet, video.id)).body.error.code).toBe('WALLET_NOT_LINKED');
    // the old one-time unlock is gone
    expect((await authed(h, broke.user).post(`/api/v1/videos/${video.id}/purchase`).send({})).status).toBe(410);
  });

  it('refuses unpublished, unknown, and creators without a wallet', async () => {
    const viewer = await seedViewer(h, '10');
    const hidden = await seedVideo(h, { published: false });
    expect((await start(viewer, hidden.id)).body.error.code).toBe('VIDEO_NOT_AVAILABLE');
    expect((await start(viewer, 'nope')).status).toBe(404);
    const noPayout = await seedVideo(h, { linkCreatorWallet: false });
    expect((await start(viewer, noPayout.id)).body.error.code).toBe('VIDEO_NOT_AVAILABLE');
  });

  it('lets anyone watch free videos and creators watch their own videos for free', async () => {
    const freeVideo = await seedVideo(h, { rateStrm: '0' });
    const noWallet = await registerUser(h);
    const r = await watchPieces(h, noWallet, freeVideo.id, [0, 1]);
    expect(r.start.status).toBe(201);
    expect(r.start.body.free).toBe(true);
    expect(r.statuses).toEqual([200, 200]);
    expect(await sessionCharge(r.sid)).toBe(0n);

    const paid = await seedVideo(h);
    const own = await watchPieces(h, paid.creatorUser, paid.id, [0, 1, 2]);
    expect(own.start.body.free).toBe(true);
    expect(own.statuses).toEqual([200, 200, 200]);
    expect(await sessionCharge(own.sid)).toBe(0n);
  });

  it('allows one concurrent stream: starting another ends the first and settles it', async () => {
    const v1 = await seedVideo(h);
    const v2 = await seedVideo(h);
    const viewer = await seedViewer(h, '20');
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

describe('paying per second watched', () => {
  it('charges each new piece once, as it is sent', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0, 1]);
    expect(r.statuses).toEqual([200, 200]);
    expect(await sessionCharge(r.sid)).toBe(2n * PIECE);
    expect(await available(viewer)).toBe(parseEther('8'));
    const hb = await beat(viewer, r.sid, 1);
    expect(hb.body).toMatchObject({ chargedWei: (2n * PIECE).toString(), paidSeconds: 8, action: 'continue' });
    expect(hb.body.secondsRemaining).toBe(32); // 8 STRM at 15 per minute
  });

  it('never charges again for a piece already paid: rewinding, switching quality, or a later session', async () => {
    const video = await seedVideo(h);
    // a second rendition on the same 4-second grid
    fs.cpSync(path.join(h.hlsDir, video.id, '360p'), path.join(h.hlsDir, video.id, '720p'), { recursive: true });
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0, 1, 2]);
    expect(await sessionCharge(r.sid)).toBe(3n * PIECE);
    expect((await fetchPiece(h, r.sid, r.cookie, 1)).status).toBe(200); // rewind
    expect((await fetchPiece(h, r.sid, r.cookie, 2, '720p')).status).toBe(200); // quality switch
    expect(await sessionCharge(r.sid)).toBe(3n * PIECE);
    await authed(h, viewer.user).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});

    const later = await watchPieces(h, viewer.user, video.id, [0, 1, 2, 3]);
    expect(later.start.body.paidSeconds).toBe(12);
    expect(await sessionCharge(later.sid)).toBe(PIECE); // only piece 3 is new
    expect(await h.ctx.prisma.paidSegment.count({ where: { userId: viewer.user.id, videoId: video.id } })).toBe(4);
  });

  it('does not charge for skipped pieces until they are watched', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0, 4, 5]); // skip from 0:04 to 0:16
    expect(await sessionCharge(r.sid)).toBe(3n * PIECE);
    const paid = await h.ctx.prisma.paidSegment.findMany({ where: { userId: viewer.user.id }, orderBy: { segmentIndex: 'asc' } });
    expect(paid.map((p) => p.segmentIndex)).toEqual([0, 4, 5]);
    expect((await fetchPiece(h, r.sid, r.cookie, 2)).status).toBe(200); // goes back to watch part of what was skipped
    expect(await sessionCharge(r.sid)).toBe(4n * PIECE);
  });

  it('refuses new pieces once the balance runs out, while paid pieces keep playing', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0]);
    // the viewer's balance drops (spent elsewhere): 2.5 on-chain minus the 1 owed for piece 0 leaves 1.5
    await h.ctx.prisma.escrowAccount.update({ where: { userId: viewer.user.id }, data: { onChainBalance: '2.5' } });
    expect((await fetchPiece(h, r.sid, r.cookie, 1)).status).toBe(200);
    const refused = await fetchPiece(h, r.sid, r.cookie, 2);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(refused.body.error.details.requiredWei).toBe(PIECE.toString());
    expect((await fetchPiece(h, r.sid, r.cookie, 0)).status).toBe(200); // already paid
    expect(await sessionCharge(r.sid)).toBe(2n * PIECE);
    expect(await h.ctx.prisma.paidSegment.count({ where: { userId: viewer.user.id } })).toBe(2);
  });

  it('lets a viewer with no balance rewatch a video they have fully paid for', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0, 1, 2, 3, 4, 5]);
    await authed(h, viewer.user).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});
    // nothing left to spend: what remains on-chain is exactly what is owed for this session
    await h.ctx.prisma.escrowAccount.update({ where: { userId: viewer.user.id }, data: { onChainBalance: '6' } });
    const again = await watchPieces(h, viewer.user, video.id, [0, 5]);
    expect(again.start.status).toBe(201);
    expect(again.statuses).toEqual([200, 200]);
    expect(await sessionCharge(again.sid)).toBe(0n);
  });

  it('turns the session total into one settlement when the session ends', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0, 1, 2]);
    const end = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});
    expect(end.body.chargedWei).toBe((3n * PIECE).toString());
    const settlement = await h.ctx.prisma.paymentSettlement.findUniqueOrThrow({ where: { id: end.body.settlementId } });
    expect(settlement.amountSTRM.toFixed()).toBe('3');
    expect(settlement.sessionId).toBe(r.sid);
  });
});

describe('heartbeats', () => {
  it('credits server wall-clock time; heartbeats themselves never charge', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const hb = await beat(viewer, body.sessionId, 1, { advance: 10 });
    expect(hb.status).toBe(200);
    expect(hb.body.verifiedSeconds).toBe(10);
    expect(hb.body.chargedWei).toBe('0');
    expect(hb.body.availableWei).toBe(parseEther('10').toString());
    expect(hb.body.action).toBe('continue');
    const hb2 = await beat(viewer, body.sessionId, 2, { advance: 10 });
    expect(hb2.body.verifiedSeconds).toBe(20);
    expect(hb2.body.chargedWei).toBe('0');
  });

  it('is idempotent: a replayed heartbeat returns the stored response', async () => {
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

  it('rejects a skipped or out-of-order sequence with 409 and does not count it', async () => {
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

  it('caps credit per heartbeat at interval + grace (a long gap is not credited in full)', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    const hb = await beat(viewer, body.sessionId, 1, { advance: 60 });
    expect(hb.body.verifiedSeconds).toBe(12);
  });

  it('credits nothing while paused or buffering, and resumes from the next playing beat', async () => {
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
  it('ends explicitly, counts a view at 30 s, and is idempotent', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const { body } = await start(viewer, video.id);
    for (let i = 1; i <= 4; i++) await beat(viewer, body.sessionId, i);
    const end = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({});
    expect(end.status).toBe(200);
    expect(end.body.verifiedSeconds).toBe(40);
    expect(end.body.chargedWei).toBe('0'); // no piece was fetched
    expect(end.body.settlementId).toBeNull();
    const again = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${body.sessionId}/end`).send({});
    expect(again.body.settlementId).toBeNull();
    expect(await h.ctx.prisma.paymentSettlement.count({ where: { userId: viewer.user.id, videoId: video.id } })).toBe(0);
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

  it('reaps sessions that stopped heartbeating, and settles what they were charged', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0]);
    await beat(viewer, r.sid, 1);
    h.clock.advance(20);
    expect(await reapStaleSessions(h.ctx)).toBe(0); // still within the 45 s timeout
    h.clock.advance(40);
    expect(await reapStaleSessions(h.ctx)).toBe(1);
    const session = await h.ctx.prisma.watchSession.findUniqueOrThrow({ where: { id: r.sid } });
    expect(session.status).toBe('COMPLETED');
    expect(session.endReason).toBe('TIMEOUT');
    expect(await h.ctx.prisma.paymentSettlement.count({ where: { sessionId: r.sid } })).toBe(1);
  });

  it('records history and resume position for continue-watching', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const r = await watchPieces(h, viewer.user, video.id, [0, 1, 2]);
    await beat(viewer, r.sid, 1, { t: 12.4 });
    await authed(h, viewer.user).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});
    const history = await authed(h, viewer.user).get('/api/v1/me/history');
    expect(history.body.items[0]).toMatchObject({ sessionId: r.sid, watchedSeconds: 10, lastPositionSec: 12, paidWei: (3n * PIECE).toString() });
    expect(history.body.items[0].video.paidSeconds).toBe(12);
    const cont = await authed(h, viewer.user).get('/api/v1/me/continue-watching');
    expect(cont.body.items[0]).toMatchObject({ positionSec: 12 });
    expect(cont.body.items[0].video.id).toBe(video.id);
    const next = await start(viewer, video.id);
    expect(next.body.resumePositionSec).toBe(12);
  });
});

describe('playback authorization', () => {
  async function playing() {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const res = await start(viewer, video.id);
    return { video, viewer, sid: res.body.sessionId as string, cookie: playbackCookie(res), endToken: res.body.endToken as string };
  }
  const get = (p: string, cookie?: string) => {
    const r = h.req().get(p);
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
    expect((await get(`/playback/${sid}/master.m3u8`, playbackCookie(hb))).status).toBe(200);
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
    expect((await get(`/playback/${sid}/360p/seg_999.ts`, cookie)).status).toBe(404); // not in the playlist
    await authed(h, viewer.user).post(`/api/v1/watch/sessions/${sid}/end`).send({});
    expect((await get(`/playback/${sid}/master.m3u8`, cookie)).status).toBe(403);
    expect((await fetchPiece(h, sid, cookie, 0)).status).toBe(403);
    expect(await h.ctx.prisma.paidSegment.count()).toBe(0);
  });
});
