import fs from 'node:fs';
import path from 'node:path';
import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, playbackCookie, registerUser, resetDb, uniq, type Harness, type TestUser } from '../../../test/harness';
import { canTransition, mediaPlaylist, reapIdleStreams } from '..';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank', PLATFORM_FEE_BPS: '0' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.ctx);
});

const strm = (n: string): string => parseEther(n).toString();
const api = (u: Pick<TestUser, 'token'>) => authed(h, u);
const INFO = { codecs: 'avc1.42001f,mp4a.40.2', width: 1280, height: 720, bandwidth: 2_500_000 };

async function creator(): Promise<TestUser> {
  const u = await registerUser(h);
  const res = await api(u).post('/api/v1/creator/profile').send({ channelName: `Channel ${uniq('c')}` });
  expect(res.status).toBe(201);
  return u;
}

async function viewer(money = '100'): Promise<TestUser> {
  const u = await registerUser(h);
  if (money !== '0') expect((await api(u).post('/api/v1/bank/topup').send({ accountId: 'demo-savings', amountWei: strm(money) })).status).toBe(201);
  return u;
}

/** Access costs 50 once (the default). */
async function createStream(c: TestUser, extra: Record<string, unknown> = {}) {
  const res = await api(c).post('/api/v1/creator/live').send({ title: 'My first stream', ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: string; videoId: string; status: string; initSeq: number; nextIndex: number };
}

/** Uploads a file the way the browser does on local storage: ask for the URL, then PUT it to the API. */
async function put(c: TestUser, streamId: string, name: string, bytes = Buffer.from(`bytes of ${name}`)) {
  const urls = await api(c).post(`/api/v1/creator/live/${streamId}/upload-urls`).send({ names: [name] });
  expect(urls.status).toBe(200);
  const item = urls.body.items[0];
  expect(item.viaApi).toBe(true);
  return h.req().put(`/api/v1${item.url}`).set('Authorization', `Bearer ${c.token}`).set('Content-Type', item.headers['Content-Type']).send(bytes);
}

/** Sends `count` pieces of 4 s, moving the clock along as a real stream would. */
async function sendPieces(c: TestUser, streamId: string, initSeq: number, from: number, count: number) {
  for (let i = from; i < from + count; i++) {
    h.clock.advance(4);
    expect((await put(c, streamId, `seg_${String(i).padStart(6, '0')}.m4s`)).status).toBe(204);
    const res = await api(c).post(`/api/v1/creator/live/${streamId}/segments`).send({ index: i, initSeq, durationMs: 4000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}

async function goLive(c: TestUser, extra: Record<string, unknown> = {}, pieces = 3) {
  const s = await createStream(c, extra);
  const started = await api(c).post(`/api/v1/creator/live/${s.id}/start`).send(INFO);
  expect(started.status).toBe(200);
  expect(started.body.status).toBe('STARTING');
  expect((await put(c, s.id, 'init_0.mp4')).status).toBe(204);
  await sendPieces(c, s.id, 0, 0, pieces);
  return s;
}

describe('stream lifecycle', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('CREATED', 'STARTING')).toBe(true);
    expect(canTransition('STARTING', 'LIVE')).toBe(true);
    expect(canTransition('LIVE', 'ENDING')).toBe(true);
    expect(canTransition('ENDING', 'ENDED')).toBe(true);
    expect(canTransition('LIVE', 'FAILED')).toBe(true);
    expect(canTransition('CREATED', 'LIVE')).toBe(false);
    expect(canTransition('ENDED', 'LIVE')).toBe(false);
    expect(canTransition('FAILED', 'STARTING')).toBe(false);
    expect(canTransition('ENDING', 'LIVE')).toBe(false);
  });

  it('builds a live playlist without an end, and marks a reconnect with a discontinuity', () => {
    const live = mediaPlaylist(
      [
        { index: 0, initSeq: 0, durationMs: 4000 },
        { index: 1, initSeq: 0, durationMs: 3500 },
        { index: 2, initSeq: 1, durationMs: 4000 },
      ],
      false,
    );
    expect(live).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(live).not.toContain('#EXT-X-ENDLIST');
    expect(live.indexOf('#EXT-X-MAP:URI="init_0.mp4"')).toBeLessThan(live.indexOf('seg_000000.m4s'));
    expect(live).toMatch(/#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_1.mp4"\n#EXTINF:4.000,\nseg_000002.m4s/);
    expect(mediaPlaylist([{ index: 0, initSeq: 0, durationMs: 4000 }], true)).toContain('#EXT-X-ENDLIST');
  });

  it('cancels a stream that never started', async () => {
    const c = await creator();
    const s = await createStream(c);
    const end = await api(c).post(`/api/v1/creator/live/${s.id}/end`).send({});
    expect(end.body).toMatchObject({ status: 'FAILED', endReason: 'CANCELLED' });
    expect((await api(c).post(`/api/v1/creator/live/${s.id}/start`).send(INFO)).body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('going live and watching', () => {
  it('a viewer buys access once, watches without per-second charges, and keeps access to the recording', async () => {
    const c = await creator();
    const s = await goLive(c);
    const v = await viewer();

    const live = await h.req().get('/api/v1/live');
    expect(live.body.items.map((x: { id: string }) => x.id)).toEqual([s.videoId]);
    expect(live.body.items[0].live).toMatchObject({ streamId: s.id, status: 'LIVE' });
    expect(live.body.items[0].accessPriceWei).toBe(strm('50'));
    // Not in the catalog while on air.
    expect((await h.req().get('/api/v1/videos')).body.items).toHaveLength(0);
    expect((await api(v).get(`/api/v1/videos/${s.videoId}`)).body).toMatchObject({ live: { status: 'LIVE' }, hasAccess: false });

    // Watching needs access first.
    const refused = await api(v).post('/api/v1/watch/sessions').send({ videoId: s.videoId });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toMatchObject({ code: 'PURCHASE_REQUIRED', details: { priceWei: strm('50') } });

    const bought = await api(v).post(`/api/v1/videos/${s.videoId}/purchase`).send({});
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ alreadyUnlocked: false, accessUntil: null, priceWei: strm('50'), availableWei: strm('50') });
    expect((await api(v).post(`/api/v1/videos/${s.videoId}/purchase`).send({})).body).toMatchObject({ alreadyUnlocked: true, availableWei: strm('50') });
    expect((await api(v).get(`/api/v1/videos/${s.videoId}`)).body.hasAccess).toBe(true);

    const start = await api(v).post('/api/v1/watch/sessions').send({ videoId: s.videoId });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ resumePositionSec: 0, ratePerMinuteWei: '0', free: true });
    const sid = start.body.sessionId as string;
    const cookie = playbackCookie(start);
    const get = (rel: string) => h.req().get(`/playback/${sid}/${rel}`).set('Cookie', cookie);

    const master = await get('master.m3u8');
    expect(master.text).toContain('CODECS="avc1.42001f,mp4a.40.2"');
    expect(master.text).toContain('RESOLUTION=1280x720');
    const index = await get('src/index.m3u8');
    expect(index.text).toContain('seg_000002.m4s');
    expect(index.text).not.toContain('#EXT-X-ENDLIST');
    expect((await get('src/init_0.mp4')).status).toBe(200);
    const seg = await get('src/seg_000001.m4s');
    expect(seg.status).toBe(200);
    expect(Buffer.from(seg.body as Buffer).toString()).toBe('bytes of seg_000001.m4s');
    expect((await get('src/seg_000002.m4s')).status).toBe(200);
    expect((await get('src/seg_000009.m4s')).status).toBe(404); // not sent yet
    // Watching costs nothing more.
    expect((await api(v).get('/api/v1/wallet/summary')).body.availableWei).toBe(strm('50'));

    const stats = await api(c).get(`/api/v1/creator/live/${s.id}`);
    expect(stats.body).toMatchObject({ status: 'LIVE', viewers: 1, durationSeconds: 12, priceWei: strm('50'), buyers: 1, earnedWei: strm('50'), nextIndex: 3 });

    const ended = await api(c).post(`/api/v1/creator/live/${s.id}/end`).send({});
    expect(ended.body).toMatchObject({ status: 'ENDED', endReason: 'ENDED_BY_CREATOR' });
    const video = await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: s.videoId } });
    expect(video).toMatchObject({ processingStatus: 'COMPLETED', isPublished: true, durationSeconds: 12 });
    expect(fs.existsSync(video.hlsManifestPath!)).toBe(true);
    expect((await h.req().get('/api/v1/videos')).body.items.map((x: { id: string }) => x.id)).toEqual([s.videoId]);
    expect((await h.req().get('/api/v1/live')).body.items).toHaveLength(0);

    // The open session now reads the final files.
    expect((await get('src/index.m3u8')).text).toContain('#EXT-X-ENDLIST');
    expect((await api(v).post(`/api/v1/watch/sessions/${sid}/end`).send({})).body.chargedWei).toBe('0');

    // Access is permanent: the recording plays for the buyer later; someone new pays the same price for it.
    h.clock.advance(30 * 24 * 3600);
    expect((await api(v).post('/api/v1/watch/sessions').send({ videoId: s.videoId })).status).toBe(201);
    const late = await viewer();
    expect((await api(late).post('/api/v1/watch/sessions').send({ videoId: s.videoId })).body.error.code).toBe('PURCHASE_REQUIRED');
    expect((await api(late).post(`/api/v1/videos/${s.videoId}/purchase`).send({})).status).toBe(200);
    expect((await api(late).post('/api/v1/watch/sessions').send({ videoId: s.videoId })).status).toBe(201);
    // The creator watches their own stream free, and a free stream needs no purchase.
    expect((await api(c).post('/api/v1/watch/sessions').send({ videoId: s.videoId })).status).toBe(201);
  });

  it('refuses access without enough balance, and free streams need no purchase', async () => {
    const c = await creator();
    const s = await goLive(c);
    const poor = await viewer('10');
    const res = await api(poor).post(`/api/v1/videos/${s.videoId}/purchase`).send({});
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await api(poor).get('/api/v1/wallet/summary')).body.availableWei).toBe(strm('10'));

    const other = await creator();
    const free = await goLive(other, { priceWei: '0' }, 1);
    expect((await api(poor).post('/api/v1/watch/sessions').send({ videoId: free.videoId })).status).toBe(201);
    expect((await api(poor).post(`/api/v1/videos/${free.videoId}/purchase`).send({})).status).toBe(400);
    // Ordinary videos are still paid per second and cannot be bought.
    expect((await api(poor).get(`/api/v1/videos/${free.videoId}`)).body.hasAccess).toBe(true);
  });

  it('keeps prices within bounds', async () => {
    const c = await creator();
    const res = await api(c).post('/api/v1/creator/live').send({ title: 'Too dear', priceWei: strm('1001') });
    expect(res.status).toBe(400);
    expect((await createStream(c, { priceWei: undefined })).id).toBeTruthy();
  });

  it('drops the recording when the creator chose not to keep it', async () => {
    const c = await creator();
    const s = await goLive(c, { saveAsVod: false }, 1);
    await api(c).post(`/api/v1/creator/live/${s.id}/end`).send({});
    const video = await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: s.videoId } });
    expect(video.archivedAt).not.toBeNull();
    expect(fs.existsSync(path.join(h.hlsDir, s.videoId))).toBe(false);
    expect((await h.req().get(`/api/v1/videos/${s.videoId}`)).status).toBe(404);
  });

  it('ends a stream whose sender went quiet, keeping the recording', async () => {
    const c = await creator();
    const s = await goLive(c, {}, 2);
    h.clock.advance(30);
    expect(await reapIdleStreams(h.ctx)).toBe(0);
    h.clock.advance(31);
    expect(await reapIdleStreams(h.ctx)).toBe(1);
    const row = await h.ctx.prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ status: 'ENDED', endReason: 'CREATOR_DISCONNECTED' });
  });

  it('carries on after the creator reconnects', async () => {
    const c = await creator();
    const s = await goLive(c, {}, 2);
    const again = await api(c).post(`/api/v1/creator/live/${s.id}/start`).send(INFO);
    expect(again.body).toMatchObject({ status: 'LIVE', initSeq: 1, nextIndex: 2 });
    h.clock.advance(4);
    const stale = await api(c).post(`/api/v1/creator/live/${s.id}/segments`).send({ index: 2, initSeq: 0, durationMs: 4000 });
    expect(stale.body.error.code).toBe('LIVE_SEGMENT_INVALID');
    expect((await put(c, s.id, 'init_1.mp4')).status).toBe(204);
    await sendPieces(c, s.id, 1, 2, 1);
    const playlist = await h.ctx.prisma.liveSegment.findMany({ where: { liveStreamId: s.id }, orderBy: { index: 'asc' } });
    expect(playlist.map((p) => p.initSeq)).toEqual([0, 0, 1]);
  });
});

describe('what a sender may not do', () => {
  it('refuses pieces out of order, ahead of the clock, or from someone else', async () => {
    const c = await creator();
    const s = await goLive(c, {}, 2);
    h.clock.advance(4);
    const repeat = await api(c).post(`/api/v1/creator/live/${s.id}/segments`).send({ index: 0, initSeq: 0, durationMs: 3000 });
    expect(repeat.body.error.code).toBe('LIVE_SEGMENT_INVALID');
    // A retried commit of the very same piece is fine.
    expect((await api(c).post(`/api/v1/creator/live/${s.id}/segments`).send({ index: 1, initSeq: 0, durationMs: 4000 })).status).toBe(200);

    // Claiming 10 s pieces in quick succession soon runs ahead of the clock.
    let ahead;
    for (let i = 2; i < 10; i++) {
      ahead = await api(c).post(`/api/v1/creator/live/${s.id}/segments`).send({ index: i, initSeq: 0, durationMs: 10_000 });
      if (ahead.status !== 200) break;
    }
    expect(ahead?.body.error.code).toBe('LIVE_SEGMENT_INVALID');

    const other = await creator();
    expect((await api(other).post(`/api/v1/creator/live/${s.id}/segments`).send({ index: 20, initSeq: 0, durationMs: 4000 })).status).toBe(403);
    expect((await api(other).post(`/api/v1/creator/live/${s.id}/upload-urls`).send({ names: ['seg_000020.m4s'] })).status).toBe(403);
    const v = await viewer('0');
    expect((await api(v).post('/api/v1/creator/live').send({ title: 'nope' })).body.error.code).toBe('NOT_CREATOR');
  });

  it('refuses new pieces once the stream has ended', async () => {
    const c = await creator();
    const s = await goLive(c, {}, 1);
    await api(c).post(`/api/v1/creator/live/${s.id}/end`).send({});
    h.clock.advance(4);
    const late = await api(c).post(`/api/v1/creator/live/${s.id}/segments`).send({ index: 1, initSeq: 0, durationMs: 4000 });
    expect(late.body.error.code).toBe('LIVE_NOT_ACTIVE');
    expect((await api(c).post(`/api/v1/creator/live/${s.id}/start`).send(INFO)).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('lets an admin end any stream', async () => {
    const c = await creator();
    const s = await goLive(c, {}, 1);
    const admin = await registerUser(h);
    await h.ctx.prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    const login = await h.req().post('/api/v1/auth/login').send({ email: admin.email, password: admin.password });
    expect((await api(c).post(`/api/v1/admin/live/${s.id}/end`).send({})).status).toBe(403);
    expect((await authed(h, { token: login.body.accessToken }).post(`/api/v1/admin/live/${s.id}/end`).send({})).status).toBe(204);
    expect((await h.ctx.prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).endReason).toBe('ENDED_BY_ADMIN');
  });
});

describe('live chat', () => {
  async function liveWithBuyer() {
    const c = await creator();
    const s = await goLive(c, {}, 1);
    const v = await viewer();
    expect((await api(v).post(`/api/v1/videos/${s.videoId}/purchase`).send({})).status).toBe(200);
    return { c, s, v };
  }

  it('lets buyers and the creator talk, and everyone read', async () => {
    const { c, s, v } = await liveWithBuyer();
    const first = await api(v).post(`/api/v1/live/${s.id}/chat`).send({ text: '  hello there  ' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ text: 'hello there', fromCreator: false, user: { username: v.username } });
    const reply = await api(c).post(`/api/v1/live/${s.id}/chat`).send({ text: 'welcome!' });
    expect(reply.body.fromCreator).toBe(true);

    const all = await h.req().get(`/api/v1/live/${s.id}/chat`);
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toMatch(/^public, max-age=0, s-maxage=2/);
    expect(all.body).toMatchObject({ open: true, removed: [] });
    expect(all.body.items.map((m: { text: string }) => m.text)).toEqual(['hello there', 'welcome!']);
    const newer = await h.req().get(`/api/v1/live/${s.id}/chat?after=${first.body.id}`);
    expect(newer.body.items.map((m: { text: string }) => m.text)).toEqual(['welcome!']);
  });

  it('refuses viewers without access, strangers removing messages, and messages after the end', async () => {
    const { c, s, v } = await liveWithBuyer();
    const stranger = await viewer();
    const refused = await api(stranger).post(`/api/v1/live/${s.id}/chat`).send({ text: 'let me in' });
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('PURCHASE_REQUIRED');
    expect((await h.req().post(`/api/v1/live/${s.id}/chat`).send({ text: 'anon' })).status).toBe(401);
    expect((await api(v).post(`/api/v1/live/${s.id}/chat`).send({ text: '' })).status).toBe(400);
    expect((await api(v).post(`/api/v1/live/${s.id}/chat`).send({ text: 'x'.repeat(301) })).status).toBe(400);

    const msg = await api(v).post(`/api/v1/live/${s.id}/chat`).send({ text: 'rude words' });
    expect((await api(stranger).delete(`/api/v1/live/${s.id}/chat/${msg.body.id}`)).status).toBe(403);
    expect((await api(c).delete(`/api/v1/live/${s.id}/chat/${msg.body.id}`)).status).toBe(204);
    const after = await h.req().get(`/api/v1/live/${s.id}/chat`);
    expect(after.body.items).toHaveLength(0);
    expect(after.body.removed).toEqual([msg.body.id]);

    await api(c).post(`/api/v1/creator/live/${s.id}/end`).send({});
    const closed = await api(v).post(`/api/v1/live/${s.id}/chat`).send({ text: 'still there?' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('CHAT_CLOSED');
    expect((await h.req().get(`/api/v1/live/${s.id}/chat`)).body.open).toBe(false);
  });

  it('limits how fast one person can post', async () => {
    const { s, v } = await liveWithBuyer();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await api(v).post(`/api/v1/live/${s.id}/chat`).send({ text: `msg ${i}` })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});
