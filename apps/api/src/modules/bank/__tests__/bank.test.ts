import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, registerUser, resetDb, seedVideo, type Harness, type TestUser } from '../../../test/harness';

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

const api = (u: Pick<TestUser, 'token'>) => authed(h, u);
const strm = (n: string): string => parseEther(n).toString();

async function summary(u: TestUser) {
  return (await api(u).get('/api/v1/wallet/summary')).body as { escrowWei: string; availableWei: string; creatorEarningsWei: string; walletAddress: string | null };
}
async function addMoney(u: TestUser, amount: string, accountId = 'demo-savings') {
  return api(u).post('/api/v1/bank/topup').send({ accountId, amountWei: strm(amount) });
}
async function unlock(u: TestUser, videoId: string) {
  return api(u).post(`/api/v1/videos/${videoId}/purchase`).send({});
}

describe('config', () => {
  it('advertises the demo bank, the currency and the dummy accounts', async () => {
    const cfg = (await h.req().get('/api/v1/config')).body;
    expect(cfg.paymentsMode).toBe('bank');
    expect(cfg.currencySymbol).toBe('₹');
    expect(cfg.bankAccounts.map((a: { id: string }) => a.id)).toContain('demo-savings');
    expect(cfg.feeBps).toBe(0);
  });
});

describe('adding money from a dummy bank account', () => {
  it('credits the wallet and records a history entry', async () => {
    const u = await registerUser(h);
    expect((await summary(u)).availableWei).toBe('0');
    const res = await addMoney(u, '500');
    expect(res.status).toBe(201);
    expect(res.body.summary.availableWei).toBe(strm('500'));
    const txs = (await api(u).get('/api/v1/wallet/transactions')).body.items;
    expect(txs[0]).toMatchObject({ type: 'DEPOSIT', status: 'CONFIRMED', amountWei: strm('500'), label: expect.stringContaining('Demo Bank Savings') });
    expect(txs[0].explorerUrl).toBeNull();
  });

  it('adds up across several top-ups', async () => {
    const u = await registerUser(h);
    await addMoney(u, '100');
    await addMoney(u, '250', 'demo-current');
    expect((await summary(u)).availableWei).toBe(strm('350'));
  });

  it('rejects amounts outside the limits, unknown accounts and the declining account', async () => {
    const u = await registerUser(h);
    expect((await addMoney(u, '1')).body.error.code).toBe('INVALID_AMOUNT');
    expect((await addMoney(u, '999999')).body.error.code).toBe('INVALID_AMOUNT');
    expect((await addMoney(u, '100', 'nope')).body.error.code).toBe('UNKNOWN_BANK_ACCOUNT');
    const declined = await addMoney(u, '100', 'demo-declined');
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe('BANK_DECLINED');
    expect((await summary(u)).availableWei).toBe('0');
  });

  it('requires a signed-in user', async () => {
    const res = await h.req().post('/api/v1/bank/topup').send({ accountId: 'demo-savings', amountWei: strm('100') });
    expect(res.status).toBe(401);
  });

  it('does not use wallet linking in this mode', async () => {
    const u = await registerUser(h);
    const res = await api(u).post('/api/v1/wallet/nonce').send({ address: '0x' + '1'.repeat(40) });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_AVAILABLE_IN_THIS_MODE');
  });
});

describe('paying for a video', () => {
  it('cannot unlock without money, then pays once, settles instantly and the creator is credited', async () => {
    const video = await seedVideo(h, { priceStrm: '30', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    const broke = await unlock(viewer, video.id);
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const blocked = await api(viewer).post('/api/v1/watch/sessions').send({ videoId: video.id });
    expect(blocked.body.error.code).toBe('PURCHASE_REQUIRED');

    await addMoney(viewer, '100');
    const bought = await unlock(viewer, video.id);
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ alreadyUnlocked: false, priceWei: strm('30'), availableWei: strm('70') });

    // The viewer pays the price once; the creator receives all of it (no fee in this setup).
    expect((await summary(viewer)).availableWei).toBe(strm('70'));
    const settlement = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { userId: viewer.id } });
    expect(settlement.status).toBe('SETTLED');
    expect(settlement.escrowAppliedAt).not.toBeNull();
    expect(settlement.sessionId).toBeNull();

    const creator = await summary(video.creatorUser);
    expect(creator.creatorEarningsWei).toBe(strm('30'));
    const received = (await api(video.creatorUser).get('/api/v1/creator/received')).body;
    expect(received.items).toHaveLength(1);
    expect(received.items[0]).toMatchObject({ amountWei: strm('30'), videoTitle: expect.any(String), viewerName: viewer.username });
    const earnings = (await api(video.creatorUser).get('/api/v1/creator/earnings')).body;
    expect(earnings).toMatchObject({ claimableWei: strm('30'), lifetimeEarnedWei: strm('30'), pendingSettlementWei: '0' });

    const history = (await api(viewer).get('/api/v1/wallet/transactions')).body.items;
    expect(history.map((t: { label: string }) => t.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^Unlocked: /)]));

    // Watching afterwards costs nothing more.
    const watch = await api(viewer).post('/api/v1/watch/sessions').send({ videoId: video.id });
    expect(watch.status).toBe(201);
    h.clock.advance(10);
    await api(viewer).post(`/api/v1/watch/sessions/${watch.body.sessionId}/heartbeat`).send({ sequence: 1, playbackTime: 10, state: 'playing' });
    await api(viewer).post(`/api/v1/watch/sessions/${watch.body.sessionId}/end`).send({});
    expect((await summary(viewer)).availableWei).toBe(strm('70'));
  });

  it('does not charge twice while access is active, and charges again after it expires', async () => {
    const video = await seedVideo(h, { priceStrm: '30', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    await addMoney(viewer, '100');
    await unlock(viewer, video.id);
    const again = await unlock(viewer, video.id);
    expect(again.status).toBe(200);
    expect(again.body.alreadyUnlocked).toBe(true);
    expect((await summary(viewer)).availableWei).toBe(strm('70'));

    h.clock.advance(48 * 3600 + 5);
    const renewed = await unlock(viewer, video.id);
    expect(renewed.body.alreadyUnlocked).toBe(false);
    expect((await summary(viewer)).availableWei).toBe(strm('40'));
    expect(await h.ctx.prisma.videoPurchase.count({ where: { userId: viewer.id } })).toBe(2);
  });

  it('keeps the money conserved: viewer debit equals creator credit plus platform fee', async () => {
    const strict = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank', PLATFORM_FEE_BPS: '1000' } });
    try {
      const video = await seedVideo(strict, { priceStrm: '20', linkCreatorWallet: false });
      const viewer = await registerUser(strict);
      await authed(strict, viewer).post('/api/v1/bank/topup').send({ accountId: 'demo-savings', amountWei: strm('100') });
      const res = await authed(strict, viewer).post(`/api/v1/videos/${video.id}/purchase`).send({});
      expect(res.status).toBe(200);
      const s = await strict.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { userId: viewer.id } });
      expect(s.amountSTRM.toFixed()).toBe('20');
      expect(s.platformFeeSTRM.toFixed()).toBe('2');
      expect(s.creatorEarningsSTRM.toFixed()).toBe('18');
    } finally {
      await strict.close();
    }
  });

  it('stops playback when the access window ends', async () => {
    const video = await seedVideo(h, { priceStrm: '10', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    await addMoney(viewer, '10');
    await unlock(viewer, video.id);
    const start = await api(viewer).post('/api/v1/watch/sessions').send({ videoId: video.id });
    expect(start.status).toBe(201);
    h.clock.advance(48 * 3600);
    const beat = await api(viewer).post(`/api/v1/watch/sessions/${start.body.sessionId}/heartbeat`).send({ sequence: 1, playbackTime: 10, state: 'playing' });
    expect(beat.body.action).toBe('stop');
    expect(beat.body.reason).toBe('ACCESS_EXPIRED');
  });

  it('lets a creator watch their own video for free and refuses to sell it to them', async () => {
    const video = await seedVideo(h, { priceStrm: '10', linkCreatorWallet: false });
    const res = await api(video.creatorUser).post('/api/v1/watch/sessions').send({ videoId: video.id });
    expect(res.status).toBe(201);
    expect(res.body.free).toBe(true);
    expect((await unlock(video.creatorUser, video.id)).status).toBe(400);
  });
});

describe('withdrawing to the bank', () => {
  it('sends unspent money back and refuses more than the balance', async () => {
    const u = await registerUser(h);
    await addMoney(u, '200');
    const ok = await api(u).post('/api/v1/bank/withdraw').send({ accountId: 'demo-current', amountWei: strm('50') });
    expect(ok.status).toBe(200);
    expect(ok.body.summary.availableWei).toBe(strm('150'));
    const tooMuch = await api(u).post('/api/v1/bank/withdraw').send({ accountId: 'demo-current', amountWei: strm('151') });
    expect(tooMuch.status).toBe(402);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const labels = (await api(u).get('/api/v1/wallet/transactions')).body.items.map((t: { label: string }) => t.label);
    expect(labels[0]).toContain('Withdrawn to Demo Bank Current');
  });
});

describe('creator cash-out', () => {
  it('pays out earnings once and shows them as cashed out', async () => {
    const video = await seedVideo(h, { priceStrm: '20', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    await addMoney(viewer, '100');
    await unlock(viewer, video.id);

    const first = await api(video.creatorUser).post('/api/v1/bank/cashout').send({ accountId: 'demo-savings' });
    expect(first.status).toBe(200);
    expect(first.body.amountWei).toBe(strm('20'));
    expect(first.body.summary.creatorEarningsWei).toBe('0');
    const again = await api(video.creatorUser).post('/api/v1/bank/cashout').send({ accountId: 'demo-savings' });
    expect(again.status).toBe(400);
    expect((await api(video.creatorUser).get('/api/v1/creator/earnings')).body).toMatchObject({ claimableWei: '0', lifetimeEarnedWei: strm('20') });
    // Received payments stay visible after cashing out.
    expect((await api(video.creatorUser).get('/api/v1/creator/received')).body.items).toHaveLength(1);
  });

  it('is only for creators', async () => {
    const u = await registerUser(h);
    const res = await api(u).post('/api/v1/bank/cashout').send({ accountId: 'demo-savings' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_CREATOR');
  });
});
