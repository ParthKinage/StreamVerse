import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authed, createHarness, fetchPiece, registerUser, resetDb, seedVideo, watchPieces, type Harness, type TestUser } from '../../../test/harness';

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
/** Watches the given 4-second pieces and ends the session; returns the end response (with the settlement). */
async function watch(harness: Harness, u: TestUser, videoId: string, pieces: number[]) {
  const r = await watchPieces(harness, u, videoId, pieces);
  const end = await authed(harness, u).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});
  return { ...r, end };
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

describe('paying per second watched', () => {
  // Rate 60 STRM per minute = 4 STRM per 4-second piece; the 24 s fixture costs 24 in full.
  it('cannot start without money, then charges each piece once, settles instantly and credits the creator', async () => {
    const video = await seedVideo(h, { rateStrm: '60', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    const blocked = await api(viewer).post('/api/v1/watch/sessions').send({ videoId: video.id });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('INSUFFICIENT_BALANCE');

    await addMoney(viewer, '100');
    const w = await watch(h, viewer, video.id, [0, 1, 2]);
    expect(w.statuses).toEqual([200, 200, 200]);
    expect(w.end.body.chargedWei).toBe(strm('12'));

    // The viewer paid for 12 seconds; the creator receives all of it (no fee in this setup).
    expect((await summary(viewer)).availableWei).toBe(strm('88'));
    const settlement = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { userId: viewer.id } });
    expect(settlement.status).toBe('SETTLED');
    expect(settlement.escrowAppliedAt).not.toBeNull();
    expect(settlement.sessionId).toBe(w.sid);

    const creator = await summary(video.creatorUser);
    expect(creator.creatorEarningsWei).toBe(strm('12'));
    const received = (await api(video.creatorUser).get('/api/v1/creator/received')).body;
    expect(received.items).toHaveLength(1);
    expect(received.items[0]).toMatchObject({ amountWei: strm('12'), videoTitle: expect.any(String), viewerName: viewer.username });
    const earnings = (await api(video.creatorUser).get('/api/v1/creator/earnings')).body;
    expect(earnings).toMatchObject({ claimableWei: strm('12'), lifetimeEarnedWei: strm('12'), pendingSettlementWei: '0' });

    const history = (await api(viewer).get('/api/v1/wallet/transactions')).body.items;
    expect(history.map((t: { label: string }) => t.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^Watched: /)]));

    // Watching the same 12 seconds again costs nothing; only new seconds are charged.
    const again = await watch(h, viewer, video.id, [0, 1, 2, 3]);
    expect(again.end.body.chargedWei).toBe(strm('4'));
    expect((await summary(viewer)).availableWei).toBe(strm('84'));
  });

  it('keeps the money conserved: viewer debit equals creator credit plus platform fee', async () => {
    const strict = await createHarness({ useChain: false, env: { PAYMENTS_MODE: 'bank', PLATFORM_FEE_BPS: '1000' } });
    try {
      const video = await seedVideo(strict, { rateStrm: '60', linkCreatorWallet: false });
      const viewer = await registerUser(strict);
      await authed(strict, viewer).post('/api/v1/bank/topup').send({ accountId: 'demo-savings', amountWei: strm('100') });
      await watch(strict, viewer, video.id, [0, 1, 2, 3, 4]);
      const s = await strict.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { userId: viewer.id } });
      expect(s.amountSTRM.toFixed()).toBe('20');
      expect(s.platformFeeSTRM.toFixed()).toBe('2');
      expect(s.creatorEarningsSTRM.toFixed()).toBe('18');
    } finally {
      await strict.close();
    }
  });

  it('stops sending new pieces when the money runs out, and the viewer can top up and carry on', async () => {
    const video = await seedVideo(h, { rateStrm: '60', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    await addMoney(viewer, '25'); // enough to start (the 24 s video in full)
    const r = await watchPieces(h, viewer, video.id, []);
    await api(viewer).post('/api/v1/bank/withdraw').send({ accountId: 'demo-current', amountWei: strm('15') }); // 10 left: two pieces
    const statuses = [];
    for (const i of [0, 1, 2]) statuses.push((await fetchPiece(h, r.sid, r.cookie, i)).status);
    expect(statuses).toEqual([200, 200, 402]);
    await addMoney(viewer, '10');
    expect((await fetchPiece(h, r.sid, r.cookie, 2)).status).toBe(200);
  });

  it('lets a creator watch their own video for free', async () => {
    const video = await seedVideo(h, { rateStrm: '10', linkCreatorWallet: false });
    const w = await watch(h, video.creatorUser, video.id, [0, 1]);
    expect(w.start.body.free).toBe(true);
    expect(w.end.body.chargedWei).toBe('0');
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
    const video = await seedVideo(h, { rateStrm: '60', linkCreatorWallet: false });
    const viewer = await registerUser(h);
    await addMoney(viewer, '100');
    await watch(h, viewer, video.id, [0, 1, 2, 3, 4]); // 20

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
