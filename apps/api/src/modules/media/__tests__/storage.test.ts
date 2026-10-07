import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { S3Store } from '@tesor_gp/storage';
import { authed, createHarness, registerUser, resetDb, uniq, type Harness, type TestUser } from '../../../test/harness';
import { MEDIA_MISSING_REASON, reconcileMissingMedia } from '../reconcile';
import { PlaylistCache, signMediaPlaylist, resolveMediaKey } from '../../playback/playlist';

// Runs against the local S3-compatible gateway from docker-compose.yml (`docker compose up -d s3`).
const S3 = {
  S3_ENDPOINT: process.env.S3_TEST_ENDPOINT ?? 'http://localhost:7070',
  S3_REGION: 'us-east-1',
  S3_BUCKET: `api-test-${crypto.randomBytes(4).toString('hex')}`,
  S3_ACCESS_KEY_ID: 'devaccesskey',
  S3_SECRET_ACCESS_KEY: 'devsecretkey',
  S3_FORCE_PATH_STYLE: 'true',
};

let h: Harness;
let local: Harness;
let store: S3Store;

beforeAll(async () => {
  h = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank', STORAGE_PROVIDER: 's3', MAX_UPLOAD_MB: '5', ...S3 } });
  local = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank' } });
  store = h.ctx.storage.s3!;
  await store.ensureBucket();
});
afterAll(async () => {
  await store.deletePrefix('').catch(() => undefined);
  await h.close();
  await local.close();
});
beforeEach(() => resetDb(h.ctx));

const fixture = (name: string): string => path.join(inject('fixtureDir'), name);

async function creator(harness: Harness = h): Promise<TestUser> {
  const user = await registerUser(harness);
  const res = await authed(harness, user).post('/api/v1/creator/profile').send({ channelName: `Channel ${uniq('c')}` });
  expect(res.status).toBe(201);
  return user;
}

/** A published, free, COMPLETED video whose HLS files are in the bucket under hls/<id>/v1/. */
async function storedVideo(owner: TestUser, opts: { upload?: boolean } = {}): Promise<string> {
  const profile = await h.ctx.prisma.creatorProfile.findUniqueOrThrow({ where: { userId: owner.id } });
  const video = await h.ctx.prisma.video.create({
    data: { title: uniq('v'), description: 'stored', category: 'Education', tags: ['test'], creatorId: profile.id, originalFilePath: 'originals/x/source.mp4', priceSTRM: '0', processingStatus: 'COMPLETED', transcodeProgress: 100, durationSeconds: 24, isPublished: true },
  });
  const prefix = `hls/${video.id}/v1/`;
  if (opts.upload !== false) {
    const dir = inject('fixtureDir');
    for (const rel of ['master.m3u8', 'thumbnail.jpg', ...fs.readdirSync(path.join(dir, '360p')).map((f) => `360p/${f}`)]) await store.putFile(prefix + rel, path.join(dir, rel));
  }
  await h.ctx.prisma.video.update({ where: { id: video.id }, data: { hlsManifestPath: `${prefix}master.m3u8`, thumbnailPath: `${prefix}thumbnail.jpg` } });
  return video.id;
}

async function directUpload(user: TestUser, file: string, contentType = 'video/mp4', fileName = 'clip.mp4') {
  const size = fs.statSync(file).size;
  const step1 = await authed(h, user).post('/api/v1/creator/uploads').send({ fileName, contentType, sizeBytes: size });
  expect(step1.status).toBe(201);
  const put = await fetch(step1.body.uploadUrl, { method: 'PUT', headers: step1.body.headers, body: fs.readFileSync(file) });
  expect(put.status).toBe(200);
  return step1.body as { uploadToken: string; uploadUrl: string };
}

describe('direct upload to object storage', () => {
  it('advertises direct upload in /config', async () => {
    expect((await h.req().get('/api/v1/config')).body.uploadMode).toBe('direct');
    expect((await local.req().get('/api/v1/config')).body.uploadMode).toBe('multipart');
  });

  it('issues a signed URL, checks the uploaded file and queues an object-storage transcode', async () => {
    const user = await creator();
    const { uploadToken } = await directUpload(user, fixture('source.mp4'));
    const done = await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken, title: 'Direct', tags: 'a,b' });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ title: 'Direct', processingStatus: 'PENDING', tags: ['a', 'b'] });

    const row = await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: done.body.id } });
    expect(row.originalFilePath).toMatch(new RegExp(`^originals/${user.id}/[0-9a-f-]+\\.mp4$`));
    const job = await h.ctx.queues.transcode.getJob(`transcode-${row.id}`);
    expect(job?.data).toEqual({ videoId: row.id, inputPath: row.originalFilePath, outputDir: `hls/${row.id}/`, storage: 's3' });

    // a retried completion returns the same video instead of creating a second one
    const again = await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken, title: 'Direct' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(row.id);
    expect(await h.ctx.prisma.video.count()).toBe(1);
  });

  it('refuses to complete before the file has arrived', async () => {
    const user = await creator();
    const step1 = await authed(h, user).post('/api/v1/creator/uploads').send({ fileName: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1000 });
    const res = await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken: step1.body.uploadToken, title: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
  });

  it('rejects a file that is not a video and deletes it from the bucket', async () => {
    const user = await creator();
    const junk = path.join(h.uploadDir, 'junk.mp4');
    fs.writeFileSync(junk, 'not a video at all');
    const { uploadToken } = await directUpload(user, junk);
    const res = await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken, title: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UPLOAD_INVALID');
    const listed = await store.deletePrefix(`originals/${user.id}/`);
    expect(listed).toBe(0);
  });

  it('rejects a file larger than announced', async () => {
    const user = await creator();
    const step1 = await authed(h, user).post('/api/v1/creator/uploads').send({ fileName: 'a.mp4', contentType: 'video/mp4', sizeBytes: 10 });
    await fetch(step1.body.uploadUrl, { method: 'PUT', headers: step1.body.headers, body: fs.readFileSync(fixture('source.mp4')) });
    const res = await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken: step1.body.uploadToken, title: 'x' });
    expect(res.status).toBe(413);
  });

  it('validates the request and protects the token', async () => {
    const user = await creator();
    const other = await creator();
    const big = await authed(h, user).post('/api/v1/creator/uploads').send({ fileName: 'a.mp4', contentType: 'video/mp4', sizeBytes: 6 * 1024 * 1024 });
    expect(big.status).toBe(413);
    const ext = await authed(h, user).post('/api/v1/creator/uploads').send({ fileName: 'a.exe', contentType: 'video/mp4', sizeBytes: 10 });
    expect(ext.body.error.code).toBe('UPLOAD_INVALID');
    const type = await authed(h, user).post('/api/v1/creator/uploads').send({ fileName: 'a.mp4', contentType: 'text/html', sizeBytes: 10 });
    expect(type.status).toBe(400);
    const notCreator = await authed(h, await registerUser(h)).post('/api/v1/creator/uploads').send({ fileName: 'a.mp4', contentType: 'video/mp4', sizeBytes: 10 });
    expect(notCreator.body.error.code).toBe('NOT_CREATOR');

    const { uploadToken } = await directUpload(user, fixture('source.mp4'));
    expect((await authed(h, other).post('/api/v1/creator/uploads/complete').send({ uploadToken, title: 'x' })).status).toBe(403);
    const tampered = `${uploadToken.split('.')[0]}x.${uploadToken.split('.')[1]}`;
    expect((await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken: tampered, title: 'x' })).body.error.code).toBe('UPLOAD_INVALID');
    h.clock.advance(h.env.UPLOAD_URL_TTL_SEC + 3601);
    expect((await authed(h, user).post('/api/v1/creator/uploads/complete').send({ uploadToken, title: 'x' })).body.error.code).toBe('UPLOAD_INVALID');
  });

  it('is not offered on local storage', async () => {
    const user = await creator(local);
    const res = await authed(local, user).post('/api/v1/creator/uploads').send({ fileName: 'a.mp4', contentType: 'video/mp4', sizeBytes: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_AVAILABLE_IN_THIS_MODE');
  });

  it('still accepts a multipart upload and moves it into the bucket', async () => {
    const user = await creator();
    const res = await authed(h, user).post('/api/v1/creator/videos').field('title', 'Multipart').attach('file', fixture('source.mp4'), { contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    const row = await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(await store.exists(row.originalFilePath)).toBe(true);
    expect(fs.readdirSync(h.uploadDir).filter((f) => f.endsWith('.mp4') && f !== 'junk.mp4')).toEqual([]);
  });
});

describe('playback from object storage', () => {
  async function playing(opts: { upload?: boolean } = {}) {
    const owner = await creator();
    const videoId = await storedVideo(owner, opts);
    const viewer = await registerUser(h);
    const res = await authed(h, viewer).post('/api/v1/watch/sessions').send({ videoId });
    expect(res.status).toBe(201);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pbt='))!.split(';')[0]!;
    return { videoId, sid: res.body.sessionId as string, cookie };
  }

  it('serves playlists from the API and every segment from a signed bucket URL', async () => {
    const { sid, cookie } = await playing();
    const master = await h.req().get(`/playback/${sid}/master.m3u8`).set('Cookie', cookie);
    expect(master.status).toBe(200);
    expect(master.headers['cache-control']).toBe('no-store');
    expect(master.text).toContain('360p/index.m3u8');

    const variant = await h.req().get(`/playback/${sid}/360p/index.m3u8`).set('Cookie', cookie);
    expect(variant.status).toBe(200);
    const urls = variant.text.split('\n').filter((l) => l.startsWith('http'));
    expect(urls).toHaveLength(6);
    expect(variant.text).toContain('#EXT-X-ENDLIST');
    // later segments stay valid longer, in step with when they play
    const expires = urls.map((u) => Number(new URL(u).searchParams.get('X-Amz-Expires')));
    expect(expires[0]).toBe(h.env.SEGMENT_URL_SLACK_SEC);
    expect(expires[5]).toBe(h.env.SEGMENT_URL_SLACK_SEC + 20);

    const seg = await fetch(urls[0]!);
    expect(seg.status).toBe(200);
    expect(seg.headers.get('content-type')).toBe('video/mp2t');
    expect((await seg.arrayBuffer()).byteLength).toBe(fs.statSync(path.join(inject('fixtureDir'), '360p', 'seg_000.ts')).size);
  });

  it('never serves segments through the API, refuses path tricks and missing cookies', async () => {
    const { sid, cookie } = await playing();
    expect((await h.req().get(`/playback/${sid}/360p/seg_000.ts`).set('Cookie', cookie)).status).toBe(404);
    expect((await h.req().get(`/playback/${sid}/../../other/master.m3u8`).set('Cookie', cookie)).status).toBe(404);
    expect((await h.req().get(`/playback/${sid}/master.m3u8`)).status).toBe(401);
  });

  it('reports MEDIA_MISSING when the files are gone', async () => {
    const { sid, cookie } = await playing({ upload: false });
    const res = await h.req().get(`/playback/${sid}/master.m3u8`).set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MEDIA_MISSING');
  });

  it('redirects thumbnails to a signed bucket URL with a versioned, cacheable link', async () => {
    const owner = await creator();
    const id = await storedVideo(owner);
    const list = await h.req().get('/api/v1/videos');
    const thumb = list.body.items.find((v: { id: string }) => v.id === id).thumbnailUrl as string;
    expect(thumb).toBe(`/api/v1/videos/${id}/thumbnail?v=v1`);
    const res = await h.req().get(thumb);
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toContain('immutable');
    const img = await fetch(res.headers.location as string);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
  });
});

describe('reconciling missing media', () => {
  it('marks only videos whose files are gone as FAILED, with a clear reason', async () => {
    const owner = await creator();
    const present = await storedVideo(owner);
    const gone = await storedVideo(owner, { upload: false });
    const result = await reconcileMissingMedia(h.ctx);
    expect(result.failed).toEqual([gone]);
    const rows = await h.ctx.prisma.video.findMany({ where: { id: { in: [present, gone] } } });
    expect(rows.find((r) => r.id === present)).toMatchObject({ processingStatus: 'COMPLETED', isPublished: true });
    expect(rows.find((r) => r.id === gone)).toMatchObject({ processingStatus: 'FAILED', isPublished: false, failureReason: MEDIA_MISSING_REASON });
    // the catalog no longer lists it
    const ids = (await h.req().get('/api/v1/videos')).body.items.map((v: { id: string }) => v.id);
    expect(ids).toEqual([present]);
  });

  it('leaves videos alone when storage cannot be reached', async () => {
    const owner = await creator();
    const id = await storedVideo(owner, { upload: false });
    const spy = vi.spyOn(h.ctx.storage, 'exists').mockRejectedValue(new Error('connect ECONNREFUSED'));
    try {
      expect((await reconcileMissingMedia(h.ctx)).failed).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect((await h.ctx.prisma.video.findUniqueOrThrow({ where: { id } })).processingStatus).toBe('COMPLETED');
  });

  it('treats files left over from local storage as missing after the switch to a bucket', async () => {
    const owner = await creator();
    const id = await storedVideo(owner);
    await h.ctx.prisma.video.update({ where: { id }, data: { hlsManifestPath: '/app/hls-output/x/master.m3u8' } });
    expect((await reconcileMissingMedia(h.ctx)).failed).toEqual([id]);
  });
});

describe('playlist signing', () => {
  const sign = async (key: string, ttl: number): Promise<string> => `https://cdn.test/${key}?ttl=${ttl}`;

  it('signs each segment with an expiry that follows its start time', async () => {
    const text = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg_000.ts\n#EXTINF:3.5,\nseg_001.ts\n#EXT-X-ENDLIST\n';
    const out = await signMediaPlaylist(text, 'hls/v/1/360p/index.m3u8', 'hls/v/1/master.m3u8', sign, 100);
    expect(out).toBe('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nhttps://cdn.test/hls/v/1/360p/seg_000.ts?ttl=100\n#EXTINF:3.5,\nhttps://cdn.test/hls/v/1/360p/seg_001.ts?ttl=104\n#EXT-X-ENDLIST\n');
  });

  it('caches playlists for a while, not forever, and never caches a miss', async () => {
    let now = 0;
    let loads = 0;
    const cache = new PlaylistCache(2, 1000, () => now);
    const load = async (k: string) => (loads++, k === 'gone' ? undefined : `text:${k}`);
    expect(await cache.get('a', load)).toBe('text:a');
    expect(await cache.get('a', load)).toBe('text:a');
    expect(loads).toBe(1);
    now = 1001;
    await cache.get('a', load);
    expect(loads).toBe(2);
    expect(await cache.get('gone', load)).toBeUndefined();
    expect(await cache.get('gone', load)).toBeUndefined();
    expect(loads).toBe(4);
  });

  it('refuses segment paths outside the video folder', async () => {
    await expect(signMediaPlaylist('#EXTINF:4,\n../../other/seg.ts\n', 'hls/v/1/360p/index.m3u8', 'hls/v/1/master.m3u8', sign, 100)).rejects.toThrow(/outside/);
    expect(resolveMediaKey('hls/v/1/master.m3u8', '../2/master.m3u8')).toBeUndefined();
    expect(resolveMediaKey('hls/v/1/master.m3u8', 'https://evil.test/x.ts')).toBeUndefined();
    expect(resolveMediaKey('hls/v/1/master.m3u8', '360p/index.m3u8')).toBe('hls/v/1/360p/index.m3u8');
  });
});
