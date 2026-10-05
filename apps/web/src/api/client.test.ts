import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setAuthLostHandler, tokenStore } from './client';

const json = (status: number, body: unknown): Response => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 5)); // let the previous test's shared refresh settle
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  tokenStore.set('old');
  setAuthLostHandler(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('sends the bearer token and parses JSON', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    expect(await api('/x')).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer old' });
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new', user: { id: 'u' } }))
      .mockResolvedValueOnce(json(200, { data: 1 }));
    expect(await api('/x')).toEqual({ data: 1 });
    expect(fetchMock.mock.calls[1]![0]).toContain('/auth/refresh');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer new' });
    expect(tokenStore.get()).toBe('new');
  });

  it('shares one refresh between concurrent 401s', async () => {
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/auth/refresh')) {
        refreshes += 1;
        return json(200, { accessToken: 'new', user: { id: 'u' } });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(200, { ok: 1 }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } });
    });
    await Promise.all([api('/a'), api('/b'), api('/c')]);
    expect(refreshes).toBe(1);
  });

  it('signals auth loss when the refresh fails', async () => {
    const lost = vi.fn();
    setAuthLostHandler(lost);
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } })).mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie' } }));
    await expect(api('/x')).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(tokenStore.get()).toBeNull();
  });

  it('does not refresh for anonymous requests such as login', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' } }));
    await expect(api('/auth/login', { method: 'POST', body: {}, anonymous: true })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps network failures and error bodies to ApiError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'CONFLICT', message: 'Nope', details: { a: 1 } } }));
    const err = await api('/x').catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Nope', details: { a: 1 } });
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(json(204, null));
    expect(await api('/x', { method: 'DELETE' })).toBeUndefined();
  });
});
