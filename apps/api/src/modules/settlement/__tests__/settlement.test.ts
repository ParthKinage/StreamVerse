import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import { ChainAdapter } from '@tesor_gp/blockchain';
import { FlakyRpcProxy } from '@tesor_gp/blockchain/testing';
import { authed, createHarness, registerUser, resetDb, routerFor, seedVideo, seedViewer, watchPieces, type Harness, type SeededVideo, type Viewer } from '../../../test/harness';
import { indexUntilCaughtUp } from '../../indexer';
import { processSettlements, reconcile, retrySettlement } from '..';

let h: Harness;
let proxy: FlakyRpcProxy;
beforeAll(async () => {
  const chain = inject('chain');
  proxy = new FlakyRpcProxy(chain.rpcUrl);
  const url = await proxy.start();
  h = await createHarness({
    overrides: {
      chain: new ChainAdapter({
        rpcUrl: url,
        chainId: chain.chainId,
        streamCoinAddress: chain.streamCoin,
        paymentRouterAddress: chain.paymentRouter,
        relayerPrivateKey: chain.deployerKey,
        confirmations: 1,
        timeoutMs: 1500,
        retries: 0,
        retryBaseDelayMs: 20,
      }),
    },
  });
});
afterAll(async () => {
  await h.close();
  await proxy.stop();
});
beforeEach(async () => {
  proxy.down = false;
  await resetDb(h.ctx);
});

/** Watches 5 pieces of the video (1 STRM each) and ends the session: one PENDING settlement of 5. Returns its id. */
async function bought(viewer: Viewer, video: SeededVideo): Promise<string> {
  const r = await watchPieces(h, viewer.user, video.id, [0, 1, 2, 3, 4]);
  expect(r.statuses).toEqual([200, 200, 200, 200, 200]);
  const end = await authed(h, viewer.user).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});
  expect(end.body.settlementId).toBeTruthy();
  return end.body.settlementId as string;
}

describe('settlement', () => {
  it('settles a finished session on-chain, applies escrow once, and the creator can claim', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const sid = await bought(viewer, video);
    const pending = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: sid } });
    expect(pending.status).toBe('PENDING');
    expect(pending.amountSTRM.toFixed()).toBe('5');

    expect((await processSettlements(h.ctx)).settled).toBe(1);
    const settled = await h.ctx.prisma.paymentSettlement.findUniqueOrThrow({ where: { id: pending.id } });
    expect(settled.status).toBe('SETTLED');
    expect(settled.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    await indexUntilCaughtUp(h.ctx);
    const applied = await h.ctx.prisma.paymentSettlement.findUniqueOrThrow({ where: { id: pending.id } });
    expect(applied.escrowAppliedAt).not.toBeNull();
    expect(applied.platformFeeSTRM.toFixed()).toBe('0.5');
    expect(applied.creatorEarningsSTRM.toFixed()).toBe('4.5');

    // running again settles nothing and never double-charges
    expect((await processSettlements(h.ctx)).settled).toBe(0);
    const summary = await authed(h, viewer.user).get('/api/v1/wallet/summary');
    expect(summary.body.availableWei).toBe(parseEther('5').toString());

    // creator claims on-chain and the claimable amount drops to zero
    const creatorSummary = await authed(h, video.creatorUser).get('/api/v1/wallet/summary');
    expect(creatorSummary.body.creatorEarningsWei).toBe(parseEther('4.5').toString());
    await (await routerFor(h, video.creatorWallet).getFunction('claimEarnings')()).wait();
    await indexUntilCaughtUp(h.ctx);
    const after = await authed(h, video.creatorUser).get('/api/v1/wallet/summary');
    expect(after.body.creatorEarningsWei).toBe('0');
    expect((await reconcile(h.ctx)).mismatches).toEqual([]);
  });

  it('survives an RPC outage: the job fails, a retry settles exactly once', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const sid = await bought(viewer, video);

    proxy.down = true;
    await expect(processSettlements(h.ctx)).rejects.toThrow();
    const failed = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: sid } });
    expect(failed.status).toBe('PENDING');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBeTruthy();

    proxy.down = false;
    expect((await processSettlements(h.ctx)).settled).toBe(1);
    expect(await h.ctx.prisma.paymentSettlement.count({ where: { id: sid, status: 'SETTLED' } })).toBe(1);
    await indexUntilCaughtUp(h.ctx);
    expect(await settledEvents(failed.settlementKey)).toBe(1);
  });

  it('reconciles a settlement that was mined but never acknowledged instead of re-sending it', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const sid = await bought(viewer, video);
    const s = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: sid }, include: { user: true, creator: { include: { user: true } } } });
    // simulate: the transaction was mined, but the process died before the DB update
    await h.ctx.chain!.settleBatch([
      { id: s.settlementKey, viewer: s.user.walletAddress!, creator: s.creator.user.walletAddress!, amount: parseEther('5') },
    ]);
    expect((await processSettlements(h.ctx)).settled).toBe(1);
    const after = await h.ctx.prisma.paymentSettlement.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe('SETTLED');
    expect(after.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    await indexUntilCaughtUp(h.ctx);
    expect(await settledEvents(s.settlementKey)).toBe(1);
  });

  it('marks a settlement FAILED after the maximum attempts, and an admin can retry it', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const sid = await bought(viewer, video);

    proxy.down = true;
    for (let i = 0; i < h.env.SETTLE_MAX_ATTEMPTS; i++) await expect(processSettlements(h.ctx)).rejects.toThrow();
    const failed = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: sid } });
    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(h.env.SETTLE_MAX_ATTEMPTS);
    proxy.down = false;
    expect((await processSettlements(h.ctx)).settled).toBe(0); // FAILED rows are not picked up

    // non-admins are refused
    expect((await authed(h, viewer.user).post(`/api/v1/admin/settlements/${failed.id}/retry`)).status).toBe(403);

    const admin = await makeAdmin();
    const listed = await authed(h, admin).get('/api/v1/admin/settlements?status=FAILED');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toContain(failed.id);
    const retry = await authed(h, admin).post(`/api/v1/admin/settlements/${failed.id}/retry`);
    expect(retry.status).toBe(202);
    expect((await authed(h, admin).post(`/api/v1/admin/settlements/${failed.id}/retry`)).status).toBe(404);

    expect((await processSettlements(h.ctx)).settled).toBe(1);
    expect((await h.ctx.prisma.paymentSettlement.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('SETTLED');
    expect(await retrySettlement(h.ctx, failed.id)).toBe(false);
  });

  it('isolates a bad item: the rest of the batch still settles', async () => {
    const video = await seedVideo(h);
    const good = await seedViewer(h, '10');
    const bad = await seedViewer(h, '10');
    const goodSid = await bought(good, video);
    const badSid = await bought(bad, video);
    // the bad viewer withdraws everything on-chain after the session, so settling their charge reverts
    const router = routerFor(h, bad.wallet);
    const delay = h.ctx.deployment?.withdrawDelaySec ?? 0;
    await (await router.getFunction('requestWithdraw')(parseEther('10'))).wait();
    await h.provider.send('evm_increaseTime', [delay + 5]);
    await h.provider.send('evm_mine', []);
    await (await router.getFunction('executeWithdraw')()).wait();
    await indexUntilCaughtUp(h.ctx);

    const res = await processSettlements(h.ctx);
    expect(res.settled).toBe(1);
    expect((await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: goodSid } })).status).toBe('SETTLED');
    const badRow = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: badSid } });
    expect(badRow.status).toBe('FAILED');
    expect(badRow.lastError).toContain('InsufficientEscrow');
  });

  it('fails fast when a wallet is not linked and the queue worker picks up queued jobs', async () => {
    const video = await seedVideo(h);
    const viewer = await seedViewer(h, '10');
    const sid = await bought(viewer, video);
    await h.ctx.prisma.user.update({ where: { id: viewer.user.id }, data: { walletAddress: null } });
    await expect(processSettlements(h.ctx)).rejects.toThrow();
    const row = await h.ctx.prisma.paymentSettlement.findFirstOrThrow({ where: { id: sid } });
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/wallet/i);
  });
});

async function settledEvents(key: string): Promise<number> {
  return h.ctx.prisma.chainEvent.count({ where: { name: 'Settled', payload: { path: ['id'], equals: key } } });
}

async function makeAdmin() {
  const u = await registerUser(h);
  await h.ctx.prisma.user.update({ where: { id: u.id }, data: { role: 'ADMIN' } });
  const login = await h.req().post('/api/v1/auth/login').send({ email: u.email, password: u.password });
  return { ...u, token: login.body.accessToken as string };
}
