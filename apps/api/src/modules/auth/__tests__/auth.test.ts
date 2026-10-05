import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createHarness, registerUser, type Harness } from '../../../test/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ useChain: false });
});
afterAll(async () => {
  await h.close();
});

describe('auth', () => {
  it('registers, returns an access token and sets an httpOnly signed refresh cookie', async () => {
    const res = await h.req().post('/api/v1/auth/register').send({ email: 'A@Example.test', username: 'alice_1', password: 'Passw0rd!123' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'a@example.test', username: 'alice_1', role: 'USER', walletAddress: null });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(decodeURIComponent(cookie ?? '')).toContain('s:'); // signed
  });

  it('rejects duplicate email and username with specific codes', async () => {
    await registerUser(h, { email: 'dup@example.test', username: 'dupuser' });
    const email = await h.req().post('/api/v1/auth/register').send({ email: 'dup@example.test', username: 'other_name', password: 'Passw0rd!123' });
    expect(email.status).toBe(409);
    expect(email.body.error.code).toBe('EMAIL_TAKEN');
    const name = await h.req().post('/api/v1/auth/register').send({ email: 'other@example.test', username: 'dupuser', password: 'Passw0rd!123' });
    expect(name.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('validates input with field details', async () => {
    const res = await h.req().post('/api/v1/auth/register').send({ email: 'nope', username: 'x', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'password', 'username']);
  });

  it('logs in with the right password and rejects the wrong one without revealing which part failed', async () => {
    const u = await registerUser(h);
    expect((await h.req().post('/api/v1/auth/login').send({ email: u.email, password: u.password })).status).toBe(200);
    const bad = await h.req().post('/api/v1/auth/login').send({ email: u.email, password: 'wrong-password' });
    const unknown = await h.req().post('/api/v1/auth/login').send({ email: 'ghost@example.test', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error).toEqual(bad.body.error);
  });

  it('protects /auth/me and returns the profile for a valid token', async () => {
    expect((await h.req().get('/api/v1/auth/me')).status).toBe(401);
    expect((await h.req().get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const u = await registerUser(h);
    const me = await authed(h, u).get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(u.id);
  });

  it('rotates refresh tokens and revokes everything when an old token is replayed', async () => {
    const u = await registerUser(h);
    const first = await h.req().post('/api/v1/auth/refresh').set('Cookie', u.cookies);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    const rotated = first.headers['set-cookie'] as unknown as string[];

    const replay = await h.req().post('/api/v1/auth/refresh').set('Cookie', u.cookies);
    expect(replay.status).toBe(401);
    // reuse detection killed the rotated token too
    const afterReplay = await h.req().post('/api/v1/auth/refresh').set('Cookie', rotated);
    expect(afterReplay.status).toBe(401);
  });

  it('refresh fails without a cookie, with a forged cookie and after expiry', async () => {
    expect((await h.req().post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await h.req().post('/api/v1/auth/refresh').set('Cookie', 'refresh_token=forged')).status).toBe(401);
    const u = await registerUser(h);
    h.clock.advance(8 * 86400);
    expect((await h.req().post('/api/v1/auth/refresh').set('Cookie', u.cookies)).status).toBe(401);
    h.clock.advance(-8 * 86400);
  });

  it('logout revokes the refresh token and clears the cookie', async () => {
    const u = await registerUser(h);
    const out = await h.req().post('/api/v1/auth/logout').set('Cookie', u.cookies);
    expect(out.status).toBe(204);
    expect((await h.req().post('/api/v1/auth/refresh').set('Cookie', u.cookies)).status).toBe(401);
  });

  it('supports changing username and password (password change signs out other sessions)', async () => {
    const u = await registerUser(h);
    const api = authed(h, u);
    const rename = await api.patch('/api/v1/users/me').send({ username: `${u.username}_x` });
    expect(rename.status).toBe(200);
    const wrong = await api.post('/api/v1/users/me/password').send({ currentPassword: 'nope-nope', newPassword: 'NewPassw0rd!1' });
    expect(wrong.status).toBe(401);
    const ok = await api.post('/api/v1/users/me/password').send({ currentPassword: u.password, newPassword: 'NewPassw0rd!1' });
    expect(ok.status).toBe(204);
    expect((await h.req().post('/api/v1/auth/login').send({ email: u.email, password: 'NewPassw0rd!1' })).status).toBe(200);
    expect((await h.req().post('/api/v1/auth/refresh').set('Cookie', u.cookies)).status).toBe(401);
  });

  it('never leaks stack traces and returns the standard error shape for unknown routes', async () => {
    const res = await h.req().get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    const bad = await h.req().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts/);
  });
});
