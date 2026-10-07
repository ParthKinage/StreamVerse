import { Contract, parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STREAM_COIN_ABI } from '@tesor_gp/blockchain';
import { authed, createHarness, registerUser, resetDb, seedVideo, type Harness, type TestUser, watchPieces } from '../../../test/harness';
import { DEV_WALLET_SEED } from '../../../config/env';
import { indexUntilCaughtUp } from '../../indexer';
import { processSettlements } from '../../settlement';
import { getConfig } from '../../wallet';
import {
  backfillManagedWallets,
  creditKeyFor,
  deriveAddress,
  deriveWallet,
  ensureLedgerScope,
  ensureManagedWallet,
  processCredits,
  processPayout,
} from '..';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ env: { WALLET_MODE: 'managed', MIN_PAYOUT_STRM: '2', TOPUP_DAILY_LIMIT_STRM: '1000' } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.ctx);
  h.clock.t = Date.now(); // one test moves the clock forward a day
});

const api = (u: Pick<TestUser, 'token'>) => authed(h, u);
const strm = (n: string): string => parseEther(n).toString();

interface Summary {
  walletAddress: string | null;
  escrowWei: string;
  availableWei: string;
  arrivingWei: string;
  creatorEarningsWei: string;
}
const summary = async (u: TestUser): Promise<Summary> => (await api(u).get('/api/v1/wallet/summary')).body as Summary;
const buy = (u: TestUser, amount: string, accountId = 'demo-savings') => api(u).post('/api/v1/wallet/topup').send({ accountId, amountWei: strm(amount) });
/**
 * Watches the whole 24 s fixture (every 4-second piece) and ends the session, so the viewer pays the full-watch cost.
 * Returns 200 with the viewer's summary when every piece was paid, otherwise the refusal.
 */
async function unlock(u: TestUser, videoId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await watchPieces(h, u, videoId, [0, 1, 2, 3, 4, 5]);
  if (r.start.status !== 201) return { status: r.start.status, body: r.start.body };
  await api(u).post(`/api/v1/watch/sessions/${r.sid}/end`).send({});
  return { status: r.statuses.every((st) => st === 200) ? 200 : 402, body: (await summary(u)) as unknown as Record<string, unknown> };
}
const transactions = async (u: TestUser) =>
  (await api(u).get('/api/v1/wallet/transactions')).body.items as Array<{ type: string; status: string; label: string; amountWei: string; explorerUrl: string | null; txHash: string | null }>;

/** Writes everything that is waiting to the chain and lets the indexer catch up, like the background worker does. */
async function settleAll(): Promise<void> {
  await processCredits(h.ctx);
  await indexUntilCaughtUp(h.ctx);
  await processSettlements(h.ctx);
  await indexUntilCaughtUp(h.ctx);
}

/** A creator with a video whose full 24 s watch costs `fullWatchStrm` (rate = that x 2.5 per minute). */
async function creatorWithVideo(fullWatchStrm: string) {
  const video = await seedVideo(h, { rateStrm: String(Number(fullWatchStrm) * 2.5), linkCreatorWallet: false });
  const login = await h.req().post('/api/v1/auth/login').send({ email: video.creatorUser.email, password: video.creatorUser.password });
  const creator: TestUser = { ...video.creatorUser, token: login.body.accessToken as string };
  const address = (await h.ctx.prisma.user.findUniqueOrThrow({ where: { id: creator.id } })).walletAddress as string;
  return { video, creator, address };
}

describe('config', () => {
  it('advertises built-in wallets, the demo bank accounts and the payout minimum', async () => {
    const cfg = (await h.req().get('/api/v1/config')).body;
    expect(cfg).toMatchObject({ paymentsMode: 'chain', walletMode: 'managed', currencyCode: 'STRM', fiatSymbol: '₹', minPayoutWei: strm('2') });
    expect(cfg.bankAccounts.map((a: { id: string }) => a.id)).toContain('demo-savings');
  });
});

describe('config privacy', () => {
  it('never sends the server RPC URL (which carries a private API key) to the browser', () => {
    const hosted = { ...h.ctx, env: { ...h.ctx.env, CHAIN_ID: 80002, POLYGON_AMOY_RPC_URL: 'https://polygon-amoy.example/v2/SECRET-KEY', RPC_URL: 'https://polygon-amoy.example/v2/SECRET-KEY' } };
    expect(JSON.stringify(getConfig(hosted))).not.toContain('SECRET-KEY');
    expect(getConfig(hosted).rpcUrl).toBe('https://rpc-amoy.polygon.technology');
    expect(getConfig({ ...hosted, env: { ...hosted.env, PUBLIC_RPC_URL: 'https://public.example' } }).rpcUrl).toBe('https://public.example');
  });
});

describe('a wallet for every account', () => {
  it('is created at sign-up from the master seed, with the welcome bonus on its way', async () => {
    const u = await registerUser(h);
    const row = await h.ctx.prisma.managedWallet.findUniqueOrThrow({ where: { userId: u.id } });
    expect(row.address).toBe(deriveAddress(DEV_WALLET_SEED, row.index));
    expect(row.address).toBe(deriveWallet(DEV_WALLET_SEED, row.index).address.toLowerCase());
    const before = await summary(u);
    expect(before.walletAddress).toBe(row.address);
    expect(before).toMatchObject({ escrowWei: '0', availableWei: '0', arrivingWei: strm('50') });

    await settleAll();
    const after = await summary(u);
    expect(after).toMatchObject({ escrowWei: strm('50'), availableWei: strm('50'), arrivingWei: '0' });
    expect((await h.ctx.chain!.getEscrow(row.address)).escrow).toBe(parseEther('50'));
    const reward = await h.ctx.prisma.tokenReward.findFirstOrThrow({ where: { userId: u.id } });
    expect(reward).toMatchObject({ status: 'SENT', reason: 'WELCOME' });
    expect(reward.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('never needs gas: the wallet holds no native coin and still gets credited', async () => {
    const u = await registerUser(h);
    await settleAll();
    const address = (await summary(u)).walletAddress as string;
    expect(await h.provider.getBalance(address)).toBe(0n);
    expect((await summary(u)).availableWei).toBe(strm('50'));
  });

  it('gives each account its own wallet and keeps it across sign-ins', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    const first = (await summary(a)).walletAddress;
    expect(first).not.toBe((await summary(b)).walletAddress);
    const login = await h.req().post('/api/v1/auth/login').send({ email: a.email, password: a.password });
    expect(login.body.user.walletAddress).toBe(first);
    expect((await api(a).get('/api/v1/auth/me')).body.user.walletAddress).toBe(first);
    expect(await h.ctx.prisma.managedWallet.count()).toBe(2);
    expect(await h.ctx.prisma.tokenReward.count()).toBe(2);
  });

  it('survives two sign-ins racing to create the same wallet', async () => {
    const u = await registerUser(h);
    await h.ctx.prisma.managedWallet.deleteMany({ where: { userId: u.id } });
    const results = await Promise.all([ensureManagedWallet(h.ctx, u.id), ensureManagedWallet(h.ctx, u.id), ensureManagedWallet(h.ctx, u.id)]);
    expect(new Set(results).size).toBe(1);
    expect(await h.ctx.prisma.managedWallet.count({ where: { userId: u.id } })).toBe(1);
    expect(await h.ctx.prisma.tokenReward.count({ where: { userId: u.id } })).toBe(1);
  });

  it('has no linking or unlinking: there is nothing for the user to set up', async () => {
    const u = await registerUser(h);
    const address = (await summary(u)).walletAddress;
    for (const res of [
      await api(u).post('/api/v1/wallet/nonce').send({ address }),
      await api(u).post('/api/v1/wallet/link').send({ address, signature: '0x00' }),
      await api(u).delete('/api/v1/wallet/link'),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_AVAILABLE_IN_THIS_MODE');
    }
    expect((await summary(u)).walletAddress).toBe(address);
  });

  it('prepares wallets for accounts that existed before, replacing a stale linked address', async () => {
    const old = await registerUser(h);
    await h.ctx.prisma.managedWallet.deleteMany();
    await h.ctx.prisma.tokenReward.deleteMany();
    await h.ctx.prisma.user.update({ where: { id: old.id }, data: { walletAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' } });
    const result = await backfillManagedWallets(h.ctx);
    expect(result).toEqual({ created: 1, bonuses: 0 });
    const row = await h.ctx.prisma.managedWallet.findUniqueOrThrow({ where: { userId: old.id } });
    expect((await h.ctx.prisma.user.findUniqueOrThrow({ where: { id: old.id } })).walletAddress).toBe(row.address);
    expect(await h.ctx.prisma.tokenReward.count({ where: { userId: old.id, walletAddress: row.address } })).toBe(1);
    expect(await backfillManagedWallets(h.ctx)).toEqual({ created: 0, bonuses: 0 });
  });
});

describe('buying coins', () => {
  it('credits the wallet on-chain and shows one clear history entry', async () => {
    const u = await registerUser(h);
    await settleAll();
    const res = await buy(u, '200');
    expect(res.status).toBe(202);
    expect(res.body.amountWei).toBe(strm('200'));
    expect(res.body.summary).toMatchObject({ availableWei: strm('50'), arrivingWei: strm('200') });
    expect((await transactions(u))[0]).toMatchObject({ type: 'DEPOSIT', status: 'PENDING', amountWei: strm('200'), label: expect.stringContaining('Demo Bank Savings') });

    await settleAll();
    expect(await summary(u)).toMatchObject({ escrowWei: strm('250'), availableWei: strm('250'), arrivingWei: '0' });
    const txs = await transactions(u);
    expect(txs.map((t) => t.type)).toEqual(['DEPOSIT', 'REWARD']);
    expect(txs[0]).toMatchObject({ status: 'CONFIRMED', amountWei: strm('200') });
    expect(txs[0]?.explorerUrl).toContain('/tx/0x');
  });

  it('puts several purchases and bonuses into a single transaction', async () => {
    const [a, b, c] = [await registerUser(h), await registerUser(h), await registerUser(h)];
    await buy(a, '10');
    await buy(b, '20');
    const before = await h.provider.getTransactionCount(h.ctx.chain!.relayerAddress as string);
    expect(await processCredits(h.ctx)).toEqual({ credited: 5 }); // 3 welcome bonuses + 2 purchases
    const after = await h.provider.getTransactionCount(h.ctx.chain!.relayerAddress as string);
    expect(after - before).toBe(1);
    await indexUntilCaughtUp(h.ctx);
    expect((await summary(a)).availableWei).toBe(strm('60'));
    expect((await summary(b)).availableWei).toBe(strm('70'));
    expect((await summary(c)).availableWei).toBe(strm('50'));
    const hashes = new Set((await h.ctx.prisma.coinOrder.findMany()).map((o) => o.txHash));
    expect(hashes.size).toBe(1);
  });

  it('rejects bad amounts, unknown accounts, the declining account and purchases over the daily limit', async () => {
    const u = await registerUser(h);
    expect((await buy(u, '1')).body.error.code).toBe('INVALID_AMOUNT');
    expect((await buy(u, '60000')).body.error.code).toBe('INVALID_AMOUNT');
    expect((await buy(u, '100', 'nope')).body.error.code).toBe('UNKNOWN_BANK_ACCOUNT');
    const declined = await buy(u, '100', 'demo-declined');
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe('BANK_DECLINED');
    expect(await h.ctx.prisma.coinOrder.count()).toBe(0);

    expect((await buy(u, '900')).status).toBe(202);
    const over = await buy(u, '200');
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'DAILY_LIMIT_REACHED', details: { remainingWei: strm('100') } });
    expect((await buy(u, '100')).status).toBe(202);
    h.clock.advance(25 * 3600); // the test clock started a little before these purchases were recorded
    expect((await buy(u, '500')).status).toBe(202);
  });

  it('holds the daily limit even when many purchases are sent at the same moment', async () => {
    const u = await registerUser(h);
    const results = await Promise.all(Array.from({ length: 8 }, () => buy(u, '300')));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3); // 3 x 300 fits under 1000, a fourth does not
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(await h.ctx.prisma.coinOrder.count({ where: { userId: u.id } })).toBe(3);
  });

  it('never offers a single purchase larger than the daily limit', async () => {
    expect((await h.req().get('/api/v1/config')).body.maxTopUpWei).toBe(strm('1000'));
  });

  it('requires signing in', async () => {
    expect((await h.req().post('/api/v1/wallet/topup').send({ accountId: 'demo-savings', amountWei: strm('100') })).status).toBe(401);
  });

  it('never credits twice when the transaction was mined but not acknowledged', async () => {
    const u = await registerUser(h);
    await settleAll();
    await buy(u, '100');
    const order = await h.ctx.prisma.coinOrder.findFirstOrThrow({ where: { userId: u.id } });
    // The relayer's transaction goes through, but the app "crashes" before it records that.
    const sent = await h.ctx.chain!.creditBatch([{ id: creditKeyFor('coin', order.id), viewer: order.walletAddress, amount: parseEther('100') }]);
    expect((await h.ctx.prisma.coinOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');

    await settleAll();
    const done = await h.ctx.prisma.coinOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(done).toMatchObject({ status: 'SENT', txHash: sent.txHash });
    expect((await summary(u)).escrowWei).toBe(strm('150'));
    await settleAll();
    expect((await summary(u)).escrowWei).toBe(strm('150'));
  });

  it('keeps the purchase waiting while the chain is unreachable and delivers it afterwards', async () => {
    const u = await registerUser(h);
    await settleAll();
    await buy(u, '100');
    const chain = h.ctx.chain!;
    const original = chain.creditBatch.bind(chain);
    chain.creditBatch = async () => {
      throw new Error('RPC down');
    };
    try {
      for (let i = 0; i < 12; i++) await expect(processCredits(h.ctx)).rejects.toThrow('RPC down');
    } finally {
      chain.creditBatch = original;
    }
    const waiting = await h.ctx.prisma.coinOrder.findFirstOrThrow({ where: { userId: u.id } });
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 12, lastError: 'RPC down' });
    expect((await summary(u)).arrivingWei).toBe(strm('100'));

    await settleAll();
    expect(await summary(u)).toMatchObject({ escrowWei: strm('150'), arrivingWei: '0' });
  });
});

describe('paying for a video', () => {
  it('moves coins from the viewer to the creator and the platform on-chain, then pays the creator out', async () => {
    const { video, creator, address } = await creatorWithVideo('12');
    const viewer = await registerUser(h);
    await settleAll();

    const res = await unlock(viewer, video.id);
    expect(res.status).toBe(200);
    expect(res.body.availableWei).toBe(strm('38'));
    const feesBefore = await h.ctx.chain!.getPlatformEarnings();
    await settleAll();

    // Commission on the test chain is 10%: the viewer pays 12, the creator gets 10.8, the platform keeps 1.2.
    expect((await summary(viewer)).escrowWei).toBe(strm('38'));
    expect(await h.ctx.chain!.getCreatorEarnings(address)).toBe(parseEther('10.8'));
    expect((await h.ctx.chain!.getPlatformEarnings()) - feesBefore).toBe(parseEther('1.2'));
    const earnings = (await api(creator).get('/api/v1/creator/earnings')).body;
    expect(earnings).toMatchObject({ claimableWei: strm('10.8'), lifetimeEarnedWei: strm('10.8'), paidOutWei: '0', payoutPending: false });

    const payout = await api(creator).post('/api/v1/creator/earnings/payout');
    expect(payout.status).toBe(202);
    expect(payout.body.amountWei).toBe(strm('10.8'));
    expect((await api(creator).get('/api/v1/creator/earnings')).body.payoutPending).toBe(true);
    // A second click while the payout is on its way does not queue another transaction.
    expect((await api(creator).post('/api/v1/creator/earnings/payout')).status).toBe(202);
    const jobs = await h.ctx.queues.settlement.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((j) => j.name === 'payout')).toHaveLength(1);

    await processPayout(h.ctx, { userId: creator.id, address });
    await indexUntilCaughtUp(h.ctx);
    const token = new Contract(h.ctx.deployment!.streamCoin, STREAM_COIN_ABI, h.provider);
    expect(await token.getFunction('balanceOf')(address)).toBe(parseEther('10.8'));
    expect(await h.provider.getBalance(address)).toBe(0n); // the creator never needed gas
    expect((await api(creator).get('/api/v1/creator/earnings')).body).toMatchObject({ claimableWei: '0', paidOutWei: strm('10.8'), lifetimeEarnedWei: strm('10.8') });
    expect((await transactions(creator)).find((t) => t.type === 'EARNINGS_CLAIMED')).toMatchObject({ label: 'Earnings paid to your wallet', amountWei: strm('10.8'), status: 'CONFIRMED' });

    // Running the payout again (a retried job) pays nothing more.
    await processPayout(h.ctx, { userId: creator.id, address });
    expect(await token.getFunction('balanceOf')(address)).toBe(parseEther('10.8'));
  });

  it('refuses to spend coins that have not arrived yet', async () => {
    const { video } = await creatorWithVideo('60');
    const viewer = await registerUser(h);
    await settleAll(); // 50 from the welcome bonus
    await buy(viewer, '100'); // still on its way
    const res = await unlock(viewer, video.id);
    expect(res.status).toBe(402);
    expect((res.body.error as { code: string }).code).toBe('INSUFFICIENT_BALANCE');
    await settleAll();
    expect((await unlock(viewer, video.id)).status).toBe(200);
  });

  it('works for a creator whose wallet was never prepared', async () => {
    const { video, creator } = await creatorWithVideo('6');
    await h.ctx.prisma.managedWallet.deleteMany({ where: { userId: creator.id } });
    await h.ctx.prisma.user.update({ where: { id: creator.id }, data: { walletAddress: null } });
    const viewer = await registerUser(h);
    await settleAll();
    expect((await unlock(viewer, video.id)).status).toBe(200);
    await settleAll();
    const address = (await h.ctx.prisma.user.findUniqueOrThrow({ where: { id: creator.id } })).walletAddress as string;
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(await h.ctx.chain!.getCreatorEarnings(address)).toBe(parseEther('5.4'));
  });
});

describe('creator payouts', () => {
  it('needs a creator profile and at least the minimum amount', async () => {
    const viewer = await registerUser(h);
    const notCreator = await api(viewer).post('/api/v1/creator/earnings/payout');
    expect(notCreator.status).toBe(403);
    expect(notCreator.body.error.code).toBe('NOT_CREATOR');

    const { video, creator } = await creatorWithVideo('1.2'); // creator share 1.08, below the minimum of 2
    await settleAll();
    await unlock(viewer, video.id);
    await settleAll();
    const tooSmall = await api(creator).post('/api/v1/creator/earnings/payout');
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.error).toMatchObject({ code: 'INVALID_AMOUNT', details: { minWei: strm('2'), claimableWei: strm('1.08') } });
    expect((await h.ctx.queues.settlement.getJobs(['waiting', 'delayed'])).filter((j) => j.name === 'payout')).toHaveLength(0);
  });
});

describe('admin revenue', () => {
  it('reports sales, the platform commission and the state of the wallet that pays gas', async () => {
    const { video } = await creatorWithVideo('12');
    const viewer = await registerUser(h);
    await buy(viewer, '100');
    await settleAll();
    await unlock(viewer, video.id);
    await settleAll();

    const adminUser = await registerUser(h);
    await h.ctx.prisma.user.update({ where: { id: adminUser.id }, data: { role: 'ADMIN' } });
    const login = await h.req().post('/api/v1/auth/login').send({ email: adminUser.email, password: adminUser.password });
    expect((await api(viewer).get('/api/v1/admin/revenue')).status).toBe(403);

    const res = await authed(h, { token: login.body.accessToken as string }).get('/api/v1/admin/revenue');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      paymentsMode: 'chain',
      walletMode: 'managed',
      feeBps: 1000,
      grossSalesWei: strm('12'),
      platformFeesWei: strm('1.2'),
      creatorEarningsWei: strm('10.8'),
      coinsSoldWei: strm('100'),
      pendingSettlements: 0,
      lowGas: false,
      walletCount: 3,
    });
    expect(res.body.pendingCredits).toBe(1); // the admin's own welcome bonus
    expect(BigInt(res.body.bonusesWei)).toBe(parseEther('100'));
    expect(BigInt(res.body.platformFeesOnChainWei)).toBeGreaterThanOrEqual(parseEther('1.2'));
    expect(res.body.relayerAddress).toBe(h.ctx.chain!.relayerAddress);
    expect(BigInt(res.body.relayerGasWei)).toBeGreaterThan(0n);
    expect(BigInt(res.body.relayerCoinsWei)).toBeGreaterThan(0n);
  });
});

describe('switching ledgers', () => {
  it('records the ledger once and leaves matching data alone', async () => {
    const u = await registerUser(h);
    await settleAll();
    expect(await ensureLedgerScope(h.ctx)).toBe('recorded');
    expect(await ensureLedgerScope(h.ctx)).toBe('unchanged');
    expect((await summary(u)).escrowWei).toBe(strm('50'));
  });

  it('reports a mismatch with another real ledger without touching anything unless a reset is allowed', async () => {
    const u = await registerUser(h);
    await settleAll();
    const other = 'chain:31337:0x0000000000000000000000000000000000000001';
    await h.ctx.prisma.appSetting.create({ data: { key: 'ledgerScope', value: other } });
    expect(await ensureLedgerScope(h.ctx)).toBe('mismatch');
    expect((await summary(u)).escrowWei).toBe(strm('50'));
    expect((await h.ctx.prisma.appSetting.findUniqueOrThrow({ where: { key: 'ledgerScope' } })).value).toBe(other);
  });

  it('always clears simulated demo-bank money when the app moves to the blockchain', async () => {
    // A database left behind by the demo bank: a balance and a ledger entry, nothing ever indexed from a chain.
    const u = await registerUser(h);
    await h.ctx.prisma.tokenReward.deleteMany();
    await h.ctx.prisma.escrowAccount.upsert({ where: { userId: u.id }, update: { onChainBalance: '500' }, create: { userId: u.id, onChainBalance: '500' } });
    await h.ctx.prisma.ledgerEntry.create({ data: { userId: u.id, type: 'BANK_TOPUP', amountSTRM: '500', label: 'Added from Demo Bank' } });
    expect((await summary(u)).availableWei).toBe(strm('500'));

    expect(h.ctx.env.LEDGER_RESET_ON_CHANGE).toBe(false);
    expect(await ensureLedgerScope(h.ctx)).toBe('reset');
    expect((await summary(u)).availableWei).toBe('0');
    expect(await h.ctx.prisma.ledgerEntry.count()).toBe(0);
    expect(await backfillManagedWallets(h.ctx)).toEqual({ created: 0, bonuses: 1 });
    await settleAll();
    expect((await summary(u)).availableWei).toBe(strm('50'));

    // The same holds when the previous ledger was recorded as the demo bank.
    await h.ctx.prisma.appSetting.update({ where: { key: 'ledgerScope' }, data: { value: 'bank' } });
    expect(await ensureLedgerScope(h.ctx)).toBe('reset');
  });

  it('clears old balances and payments when allowed, keeping accounts, videos and wallet addresses', async () => {
    const { video, creator } = await creatorWithVideo('10');
    const viewer = await registerUser(h);
    await settleAll();
    await unlock(viewer, video.id);
    await settleAll();
    const address = (await summary(viewer)).walletAddress;
    await h.ctx.prisma.appSetting.create({ data: { key: 'ledgerScope', value: 'chain:31337:0x0000000000000000000000000000000000000001' } });

    const resetting = { ...h.ctx, env: { ...h.ctx.env, LEDGER_RESET_ON_CHANGE: true } };
    expect(await ensureLedgerScope(resetting)).toBe('reset');
    expect(await ensureLedgerScope(resetting)).toBe('unchanged');

    expect(await h.ctx.prisma.paymentSettlement.count()).toBe(0);
    expect(await h.ctx.prisma.videoPurchase.count()).toBe(0);
    expect(await h.ctx.prisma.tokenReward.count()).toBe(0);
    expect(await h.ctx.prisma.escrowAccount.count()).toBe(0);
    expect(await h.ctx.prisma.chainCursor.count()).toBe(0);
    expect(await h.ctx.prisma.user.count()).toBe(2);
    expect(await h.ctx.prisma.video.count()).toBe(1);
    expect((await h.ctx.prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creator.id } })).totalEarnings.toFixed()).toBe('0');
    expect((await summary(viewer)).walletAddress).toBe(address);
    expect((await api(viewer).get(`/api/v1/videos/${video.id}`)).body.accessUntil ?? null).toBeNull();

    // Everyone gets their welcome bonus again on the new ledger.
    expect(await backfillManagedWallets(h.ctx)).toEqual({ created: 0, bonuses: 2 });
  });
});
