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

const api = (u: Pick<TestUser, 'token'>) => authed(h, u);

async function admin(): Promise<TestUser> {
  const u = await registerUser(h);
  await h.ctx.prisma.user.update({ where: { id: u.id }, data: { role: 'ADMIN' } });
  return u;
}

async function chatMessage(videoId: string, profileId: string, userId: string, text: string): Promise<number> {
  const stream = await h.ctx.prisma.liveStream.create({ data: { creatorId: profileId, videoId, status: 'LIVE' } });
  const m = await h.ctx.prisma.liveChatMessage.create({ data: { liveStreamId: stream.id, userId, text } });
  return m.id;
}

describe('reporting', () => {
  it('lets signed-in viewers report videos, chat messages and channels, once each, and groups them for admins', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false, title: 'Free crypto giveaway' });
    const a = await registerUser(h);
    const b = await registerUser(h);
    const report = (u: TestUser, body: Record<string, unknown>) => api(u).post('/api/v1/reports').send(body);

    expect((await report(a, { targetType: 'VIDEO', targetId: v.id, reason: 'SPAM' })).status).toBe(201);
    expect((await report(a, { targetType: 'VIDEO', targetId: v.id, reason: 'SPAM', details: 'scam link' })).status).toBe(201); // updates, not a second report
    expect((await report(b, { targetType: 'VIDEO', targetId: v.id, reason: 'ABUSE' })).status).toBe(201);
    const msg = await chatMessage(v.id, v.creatorProfileId, b.id, '@x you are...');
    expect((await report(a, { targetType: 'CHAT_MESSAGE', targetId: String(msg), reason: 'ABUSE' })).status).toBe(201);
    expect((await report(a, { targetType: 'CHANNEL', targetId: v.creatorProfileId, reason: 'OTHER' })).status).toBe(201);

    expect((await report(a, { targetType: 'VIDEO', targetId: 'nope', reason: 'SPAM' })).status).toBe(404);
    expect((await report(a, { targetType: 'CHAT_MESSAGE', targetId: 'abc', reason: 'SPAM' })).status).toBe(400);
    expect((await report(a, { targetType: 'VIDEO', targetId: v.id, reason: 'BORING' })).status).toBe(400);
    expect((await h.req().post('/api/v1/reports').send({ targetType: 'VIDEO', targetId: v.id, reason: 'SPAM' })).status).toBe(401);

    const boss = await admin();
    const queue = await api(boss).get('/api/v1/admin/reports');
    expect(queue.status).toBe(200);
    expect(queue.body.items[0]).toMatchObject({ targetType: 'VIDEO', targetId: v.id, count: 2, reasons: { SPAM: 1, ABUSE: 1 }, details: ['scam link'], target: { label: 'Free crypto giveaway', state: null } });
    expect(queue.body.items.map((i: { targetType: string }) => i.targetType).sort()).toEqual(['CHANNEL', 'CHAT_MESSAGE', 'VIDEO']);
    expect((await api(boss).get('/api/v1/admin/overview')).body).toMatchObject({ openReports: 3, newUsers7d: 4, suspendedUsers: 0, hiddenVideos: 0, tipsTodayWei: '0' });
    expect((await api(a).get('/api/v1/admin/reports')).status).toBe(403);
  });
});

describe('moderation', () => {
  it('hides a reported video from everyone but its creator, who cannot republish it, until an admin restores it', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    const viewer = await registerUser(h);
    await api(viewer).post('/api/v1/reports').send({ targetType: 'VIDEO', targetId: v.id, reason: 'COPYRIGHT' });
    const boss = await admin();

    const res = await api(boss).post('/api/v1/admin/reports/resolve').send({ targetType: 'VIDEO', targetId: v.id, action: 'hide_video', reason: 'Copyright claim' });
    expect(res.body).toEqual({ resolved: 1 });
    expect((await h.req().get('/api/v1/videos')).body.items).toHaveLength(0);
    expect((await api(viewer).get(`/api/v1/videos/${v.id}`)).status).toBe(404);
    expect((await api(viewer).post('/api/v1/watch/sessions').send({ videoId: v.id })).status).toBe(404);
    expect((await api(v.creatorUser).get(`/api/v1/videos/${v.id}`)).body.hiddenReason).toBe('Copyright claim');
    const republish = await api(v.creatorUser).post(`/api/v1/creator/videos/${v.id}/publish`).send({});
    expect(republish.status).toBe(409);
    expect(republish.body.error.code).toBe('VIDEO_HIDDEN');
    expect((await api(boss).get('/api/v1/admin/reports')).body.items).toHaveLength(0);
    expect((await api(boss).get('/api/v1/admin/reports?status=ACTIONED')).body.items[0].target.state).toBe('hidden');

    expect((await api(boss).post(`/api/v1/admin/videos/${v.id}/unhide`).send({})).status).toBe(204);
    expect((await h.req().get('/api/v1/videos')).body.items).toHaveLength(1);
  });

  it('suspends an account at once: no requests, no sign-in, no refresh; admins cannot be suspended', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    const boss = await admin();
    const reporter = await registerUser(h);
    await api(reporter).post('/api/v1/reports').send({ targetType: 'CHANNEL', targetId: v.creatorProfileId, reason: 'SPAM' });
    expect((await api(v.creatorUser).get('/api/v1/auth/me')).status).toBe(200);

    const res = await api(boss).post('/api/v1/admin/reports/resolve').send({ targetType: 'CHANNEL', targetId: v.creatorProfileId, action: 'suspend_owner', reason: 'Spam channel' });
    expect(res.body).toEqual({ resolved: 1 });
    const blocked = await api(v.creatorUser).get('/api/v1/auth/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
    const login = await h.req().post('/api/v1/auth/login').send({ email: v.creatorUser.email, password: v.creatorUser.password });
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');
    const refresh = await h.req().post('/api/v1/auth/refresh').set('Cookie', v.creatorUser.cookies);
    expect(refresh.status).toBe(401); // every session was signed out
    const users = await api(boss).get('/api/v1/admin/users');
    expect(users.body.items.find((u: { id: string }) => u.id === v.creatorUser.id)).toMatchObject({ suspended: true, suspendReason: 'Spam channel' });

    expect((await api(boss).post(`/api/v1/admin/users/${boss.id}/suspend`).send({})).status).toBe(400);
    expect((await api(boss).post(`/api/v1/admin/users/${v.creatorUser.id}/unsuspend`).send({})).status).toBe(204);
    expect((await h.req().post('/api/v1/auth/login').send({ email: v.creatorUser.email, password: v.creatorUser.password })).status).toBe(200);
  });

  it('removes a reported chat message, or dismisses reports without acting', async () => {
    const v = await seedVideo(h, { linkCreatorWallet: false });
    const rude = await registerUser(h);
    const reporter = await registerUser(h);
    const msg = await chatMessage(v.id, v.creatorProfileId, rude.id, 'rude words');
    await api(reporter).post('/api/v1/reports').send({ targetType: 'CHAT_MESSAGE', targetId: String(msg), reason: 'ABUSE' });
    await api(reporter).post('/api/v1/reports').send({ targetType: 'VIDEO', targetId: v.id, reason: 'OTHER' });
    const boss = await admin();

    expect((await api(boss).post('/api/v1/admin/reports/resolve').send({ targetType: 'CHAT_MESSAGE', targetId: String(msg), action: 'hide_video' })).status).toBe(400);
    expect((await api(boss).post('/api/v1/admin/reports/resolve').send({ targetType: 'CHAT_MESSAGE', targetId: String(msg), action: 'remove_message' })).body).toEqual({ resolved: 1 });
    expect((await h.ctx.prisma.liveChatMessage.findUniqueOrThrow({ where: { id: msg } })).removedAt).not.toBeNull();
    expect((await api(boss).post('/api/v1/admin/reports/resolve').send({ targetType: 'VIDEO', targetId: v.id, action: 'dismiss' })).body).toEqual({ resolved: 1 });
    expect((await api(boss).get('/api/v1/admin/reports')).body.items).toHaveLength(0);
    expect((await h.req().get('/api/v1/videos')).body.items).toHaveLength(1); // dismissing changes nothing
  });
});
