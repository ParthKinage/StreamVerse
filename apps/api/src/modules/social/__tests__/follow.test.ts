import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, registerUser, resetDb, seedVideo, type Harness, type TestUser } from '../../../test/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => resetDb(h.ctx));

/** Marks every 4 s piece of the 24 s seeded video (or only the first `pieces`) as paid by the user. */
async function payFor(user: TestUser, videoId: string, pieces = 6): Promise<void> {
  await h.ctx.prisma.paidSegment.createMany({
    data: Array.from({ length: pieces }, (_, i) => ({ userId: user.id, videoId, segmentIndex: i, durationMs: 4000, amountSTRM: '1', sessionId: 'test' })),
  });
}

describe('following channels', () => {
  it('follows and unfollows a channel, with counts and the viewer’s flag on the channel page', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    const viewer = await registerUser(h);
    const channel = `/api/v1/creators/${v.creatorProfileId}`;

    expect((await authed(h, viewer).get(channel)).body).toMatchObject({ followersCount: 0, following: false });
    const on = await authed(h, viewer).post(`${channel}/follow`);
    expect(on.body).toEqual({ following: true, followersCount: 1 });
    expect((await authed(h, viewer).get(channel)).body).toMatchObject({ followersCount: 1, following: true });
    expect((await h.req().get(channel)).body.following).toBeUndefined(); // signed out: no flag

    const list = await authed(h, viewer).get('/api/v1/me/following');
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([v.creatorProfileId]);

    expect((await authed(h, viewer).post(`${channel}/follow`)).body).toEqual({ following: false, followersCount: 0 });
    expect((await authed(h, viewer).get('/api/v1/me/following')).body.items).toEqual([]);
  });

  it('refuses following your own channel, unknown channels and signed-out requests', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    expect((await authed(h, v.creatorUser).post(`/api/v1/creators/${v.creatorProfileId}/follow`)).status).toBe(400);
    const viewer = await registerUser(h);
    expect((await authed(h, viewer).post('/api/v1/creators/nope/follow')).status).toBe(404);
    expect((await h.req().post(`/api/v1/creators/${v.creatorProfileId}/follow`)).status).toBe(401);
  });

  it('shows only followed channels’ published videos in the feed, newest first', async () => {
    const a1 = await seedVideo(h, { linkCreatorWallet: false, title: 'A one' });
    const a2 = await seedVideo(h, { creator: a1, title: 'A two' });
    await seedVideo(h, { creator: a1, title: 'A draft', published: false });
    await seedVideo(h, { linkCreatorWallet: false, title: 'Someone else' });
    const viewer = await registerUser(h);
    expect((await authed(h, viewer).get('/api/v1/me/feed')).body).toEqual({ items: [], nextCursor: null });

    await authed(h, viewer).post(`/api/v1/creators/${a1.creatorProfileId}/follow`);
    const feed = await authed(h, viewer).get('/api/v1/me/feed');
    expect(feed.body.items.map((x: { id: string }) => x.id)).toEqual([a2.id, a1.id]);
  });
});

describe('owned videos and search filters', () => {
  it('counts a video as owned once every second is paid for, never a free one', async () => {
    const full = await seedVideo(h, { linkCreatorWallet: false, title: 'Fully watched' });
    const part = await seedVideo(h, { creator: full, title: 'Half watched' });
    const viewer = await registerUser(h);
    await payFor(viewer, full.id);
    await payFor(viewer, part.id, 3);

    expect((await authed(h, viewer).get('/api/v1/me/owned')).body).toEqual({ videoIds: [full.id] });
    const owned = await authed(h, viewer).get('/api/v1/videos').query({ owned: '1' });
    expect(owned.body.items.map((x: { id: string }) => x.id)).toEqual([full.id]);
    // Signed out, "owned" means nothing and is ignored.
    expect((await h.req().get('/api/v1/videos').query({ owned: '1' })).body.items).toHaveLength(2);
  });

  it('filters by free or paid and by length', async () => {
    const paid = await seedVideo(h, { linkCreatorWallet: false, title: 'Paid one' });
    const free = await seedVideo(h, { creator: paid, title: 'Free one', rateStrm: '0' });
    const long = await seedVideo(h, { creator: paid, title: 'Long one' });
    await h.ctx.prisma.video.update({ where: { id: long.id }, data: { durationSeconds: 1500 } });
    const ids = async (query: Record<string, string>): Promise<string[]> =>
      ((await h.req().get('/api/v1/videos').query(query)).body.items as Array<{ id: string }>).map((x) => x.id).sort();

    expect(await ids({ price: 'free' })).toEqual([free.id]);
    expect(await ids({ price: 'paid' })).toEqual([paid.id, long.id].sort());
    expect(await ids({ length: 'short' })).toEqual([paid.id, free.id].sort());
    expect(await ids({ length: 'long' })).toEqual([long.id]);
    expect(await ids({ length: 'medium' })).toEqual([]);
    expect((await h.req().get('/api/v1/videos').query({ price: 'cheap' })).status).toBe(400);
  });

  it('finds channels by name, most followed first', async () => {
    const quiet = await seedVideo(h, { linkCreatorWallet: false });
    const popular = await seedVideo(h, { linkCreatorWallet: false });
    await h.ctx.prisma.creatorProfile.update({ where: { id: quiet.creatorProfileId }, data: { channelName: 'Mountain Diaries' } });
    await h.ctx.prisma.creatorProfile.update({ where: { id: popular.creatorProfileId }, data: { channelName: 'Mountain Runs' } });
    const fan = await registerUser(h);
    await authed(h, fan).post(`/api/v1/creators/${popular.creatorProfileId}/follow`);

    const res = await h.req().get('/api/v1/creators').query({ q: 'mountain' });
    expect(res.body.items.map((c: { channelName: string }) => c.channelName)).toEqual(['Mountain Runs', 'Mountain Diaries']);
    expect((await h.req().get('/api/v1/creators')).body.items).toEqual([]);
  });
});
