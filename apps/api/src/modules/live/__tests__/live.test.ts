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

/** 15 STRM per minute = 1 STRM per 4-second piece. */
async function createStream(c: TestUser, extra: Record<string, unknown> = {}) {
  const res = await api(c).post('/api/v1/creator/live').send({ title: 'My first stream', ratePerMinuteWei: strm('15'), ...extra });
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
  it('a viewer finds the stream, pays per piece, and the recording becomes a video', async () => {
    const c = await creator();
    const s = await goLive(c);
    const v = await viewer();

    const live = await h.req().get('/api/v1/live');
    expect(live.body.items.map((x: { id: string }) => x.id)).toEqual([s.videoId]);
    expect(live.body.items[0].live).toMatchObject({ streamId: s.id, status: 'LIVE' });
    // Not in the catalog while on air.
    expect((await h.req().get('/api/v1/videos')).body.items).toHaveLength(0);
    expect((await h.req().get(`/api/v1/videos/${s.videoId}`)).body.live.status).toBe('LIVE');

    const start = await api(v).post('/api/v1/watch/sessions').send({ videoId: s.videoId });
    expect(start.status).toBe(201);
    expect(start.body.resumePositionSec).toBe(0);
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
    expect((await api(v).get('/api/v1/wallet/summary')).body.availableWei).toBe(strm('100')); // the init piece is free
    const seg = await get('src/seg_000001.m4s');
    expect(seg.status).toBe(200);
    expect(Buffer.from(seg.body as Buffer).toString()).toBe('bytes of seg_000001.m4s');
    expect((await get('src/seg_000001.m4s')).status).toBe(200); // a second time is free
    expect((await api(v).get('/api/v1/wallet/summary')).body.availableWei).toBe(strm('99'));
    expect((await get('src/seg_000009.m4s')).status).toBe(404); // not sent yet

    const stats = await api(c).get(`/api/v1/creator/live/${s.id}`);
    expect(stats.body).toMatchObject({ status: 'LIVE', viewers: 1, durationSeconds: 12, earnedWei: strm('1'), nextIndex: 3 });

    const ended = await api(c).post(`/api/v1/creator/live/${s.id}/end`).send({});
    expect(ended.body).toMatchObject({ status: 'ENDED', endReason: 'ENDED_BY_CREATOR' });
    const video = await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: s.videoId } });
    expect(video).toMatchObject({ processingStatus: 'COMPLETED', isPublished: true, durationSeconds: 12 });
    expect(fs.existsSync(video.hlsManifestPath!)).toBe(true);
    expect((await h.req().get('/api/v1/videos')).body.items.map((x: { id: string }) => x.id)).toEqual([s.videoId]);
    expect((await h.req().get('/api/v1/live')).body.items).toHaveLength(0);

    // The open session now reads the final files: same pieces, same price, with an end.
    const final = await get('src/index.m3u8');
    expect(final.text).toContain('#EXT-X-ENDLIST');
    expect((await get('src/seg_000001.m4s')).status).toBe(200);
    expect((await get('src/seg_000002.m4s')).status).toBe(200);
    expect((await api(v).get('/api/v1/wallet/summary')).body.availableWei).toBe(strm('98'));
    const endSession = await api(v).post(`/api/v1/watch/sessions/${sid}/end`).send({});
    expect(endSession.body.chargedWei).toBe(strm('2'));
  });

  it('needs about a minute of balance to start watching', async () => {
    const c = await creator();
    const s = await goLive(c);
    const poor = await viewer('10'); // a minute costs 15
    const res = await api(poor).post('/api/v1/watch/sessions').send({ videoId: s.videoId });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
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
