import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Store, hlsPrefix, isObjectKey, joinKey, originalKey, s3SettingsFromEnv } from '../index';

// Runs against the local S3-compatible gateway from docker-compose.yml (`docker compose up -d s3`).
const settings = {
  endpoint: process.env.S3_TEST_ENDPOINT ?? 'http://localhost:7070',
  region: 'us-east-1',
  bucket: `test-${crypto.randomBytes(4).toString('hex')}`,
  accessKeyId: 'devaccesskey',
  secretAccessKey: 'devsecretkey',
  forcePathStyle: true,
};
const store = new S3Store(settings);
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-s3-'));
  await store.ensureBucket();
});
afterAll(async () => {
  await store.deletePrefix('').catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('S3Store', () => {
  it('uploads a folder, reads it back and deletes it by prefix', async () => {
    const dir = path.join(tmp, 'out');
    fs.mkdirSync(path.join(dir, '360p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'master.m3u8'), '#EXTM3U\n360p/index.m3u8\n');
    fs.writeFileSync(path.join(dir, '360p', 'seg_000.ts'), Buffer.alloc(1024, 7));

    const keys = await store.putDirectory('hls/v1/a/', dir);
    expect(keys.sort()).toEqual(['hls/v1/a/360p/seg_000.ts', 'hls/v1/a/master.m3u8']);
    expect(await store.getText('hls/v1/a/master.m3u8')).toContain('360p/index.m3u8');
    expect(await store.head('hls/v1/a/360p/seg_000.ts')).toEqual({ size: 1024, contentType: 'video/mp2t' });

    expect(await store.deletePrefix('hls/v1/')).toBe(2);
    expect(await store.exists('hls/v1/a/master.m3u8')).toBe(false);
  });

  it('reports a missing object as undefined instead of throwing', async () => {
    expect(await store.head('hls/nope/master.m3u8')).toBeUndefined();
    expect(await store.getText('hls/nope/master.m3u8')).toBeUndefined();
  });

  it('accepts a browser-style PUT to a presigned URL and serves it from a presigned GET', async () => {
    const key = originalKey('u1', 'clip.mp4');
    const put = await store.signedPutUrl(key, 'video/mp4', 60);
    const up = await fetch(put, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.from('fake video') });
    expect(up.status).toBe(200);

    const get = await fetch(await store.signedGetUrl(key, 60));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('fake video');

    const file = path.join(tmp, 'down', 'clip.mp4');
    await store.downloadToFile(key, file);
    expect(fs.readFileSync(file, 'utf8')).toBe('fake video');
  });

  it('rejects a presigned PUT whose content type differs from the signed one', async () => {
    const put = await store.signedPutUrl(originalKey('u1', 'x.mp4'), 'video/mp4', 60);
    const res = await fetch(put, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: '<script>' });
    expect(res.status).toBe(403);
  });

  it('rejects a tampered or expired signed URL', async () => {
    const key = originalKey('u1', 'y.mp4');
    await (await fetch(await store.signedPutUrl(key, 'video/mp4', 60), { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: 'y' })).text();
    const url = new URL(await store.signedGetUrl(key, 60));
    url.searchParams.set('X-Amz-Expires', '600');
    expect((await fetch(url)).status).toBe(403);

    const short = await store.signedGetUrl(key, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await fetch(short)).status).toBe(403);
  });
});

describe('keys and settings', () => {
  it('builds forward-slash keys on every OS', () => {
    expect(joinKey('hls/v1/', 'a\\b', './c.ts')).toBe('hls/v1/a/b/c.ts');
    expect(hlsPrefix('v1', 'abc')).toBe('hls/v1/abc/');
    expect(isObjectKey('hls/v1/abc/master.m3u8')).toBe(true);
    expect(isObjectKey('C:\\app\\hls-output\\v1\\master.m3u8')).toBe(false);
    expect(isObjectKey('/app/hls-output/v1/master.m3u8')).toBe(false);
  });

  it('names every missing variable and never echoes a value', () => {
    expect(() => s3SettingsFromEnv({ S3_ENDPOINT: 'https://x', S3_SECRET_ACCESS_KEY: 'shh' })).toThrow(/S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID$/);
    try {
      s3SettingsFromEnv({ S3_SECRET_ACCESS_KEY: 'shh' });
    } catch (err) {
      expect((err as Error).message).not.toContain('shh');
    }
  });
});
