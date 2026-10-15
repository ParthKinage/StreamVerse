import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, registerUser, resetDb, seedVideo, uniq, type Harness } from '../../../test/harness';
import { isCustomThumbnail } from '../thumbnail';

// A 16 x 16 red PNG (made with FFmpeg).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAIUlEQVR4nGP8y0AaYCFRPcOoBmIAC1GqkMCoBmIAyaEEAGgAATusqEGCAAAAAElFTkSuQmCC', 'base64');

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => resetDb(h.ctx));

const upload = (token: string, videoId: string, body: Buffer, name = 'cover.png', type = 'image/png') =>
  h.req().post(`/api/v1/creator/videos/${videoId}/thumbnail`).set('Authorization', `Bearer ${token}`).attach('file', body, { filename: name, contentType: type });

describe('custom thumbnails', () => {
  it('turns the creator’s picture into the video thumbnail, served as a JPEG, and replaces it cleanly', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    const res = await upload(v.creatorUser.token, v.id, PNG);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.thumbnailUrl).toBe(`/api/v1/videos/${v.id}/thumbnail?v=${/custom-[a-z0-9]+/.exec(res.body.thumbnailUrl)?.[0]}`);
    const row = await h.ctx.prisma.video.findUniqueOrThrow({ where: { id: v.id } });
    expect(isCustomThumbnail(row.thumbnailPath)).toBe(true);
    const img = await h.req().get(res.body.thumbnailUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect((img.body as Buffer).subarray(0, 2).toString('hex')).toBe('ffd8'); // a JPEG, whatever was uploaded

    await new Promise((r) => setTimeout(r, 5)); // a new version name
    const again = await upload(v.creatorUser.token, v.id, PNG);
    expect(again.body.thumbnailUrl).not.toBe(res.body.thumbnailUrl);
    expect(fs.existsSync(row.thumbnailPath as string)).toBe(false); // the old picture is gone
    expect(fs.readdirSync(h.ctx.storage.uploadDir).filter((f) => f.startsWith('thumb-') || f.startsWith('custom-'))).toEqual([]);
  });

  it('refuses files that are not pictures, and other people’s videos', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    const fake = await upload(v.creatorUser.token, v.id, Buffer.from('not an image at all'));
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('UPLOAD_INVALID');
    const wrongType = await upload(v.creatorUser.token, v.id, PNG, 'cover.gif', 'image/gif');
    expect(wrongType.status).toBe(400);

    const other = await registerUser(h);
    await authed(h, other).post('/api/v1/creator/profile').send({ channelName: `Channel ${uniq('c')}` });
    expect((await upload(other.token, v.id, PNG)).status).toBe(404);
    expect((await h.req().post(`/api/v1/creator/videos/${v.id}/thumbnail`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(401);
  });

  it('recognises custom pictures so processing and live streams leave them alone', () => {
    expect(isCustomThumbnail('hls/abc/custom-k3j2/thumbnail.jpg')).toBe(true);
    expect(isCustomThumbnail(path.join('C:', 'media', 'abc', 'custom-k3j2', 'thumbnail.jpg'))).toBe(true);
    expect(isCustomThumbnail('hls/abc/v1/thumbnail.jpg')).toBe(false);
    expect(isCustomThumbnail('hls/abc/live/thumbnail.jpg')).toBe(false);
    expect(isCustomThumbnail(null)).toBe(false);
  });
});
