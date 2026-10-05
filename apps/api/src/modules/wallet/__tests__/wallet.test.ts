import { parseEther } from 'ethers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { indexOnce, indexUntilCaughtUp } from '../../indexer';
import { processReward } from '../../rewards';
import { authed, createHarness, fundAndDeposit, linkWallet, newWallet, registerUser, resetDb, routerFor, type Harness } from '../../../test/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.ctx);
});

describe('wallet linking', () => {
  it('links a wallet by signature and exposes it on the user', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    const api = authed(h, user);
    const nonce = await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
    expect(nonce.status).toBe(200);
    expect(nonce.body.message).toContain(user.id);
    expect(nonce.body.message).toContain(String(h.env.CHAIN_ID));
    expect(nonce.body.message).toContain(nonce.body.nonce);
    const signature = await wallet.signMessage(nonce.body.message);
    const link = await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature });
    expect(link.status).toBe(200);
    expect(link.body.user.walletAddress).toBe(wallet.address.toLowerCase());
  });

  it('makes the nonce single-use and expiring', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    const api = authed(h, user);
    const { body } = await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
    const signature = await wallet.signMessage(body.message);
    expect((await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature })).status).toBe(200);
    const replay = await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('NONCE_EXPIRED');

    const other = await registerUser(h);
    const w2 = await newWallet(h);
    const n2 = await authed(h, other).post('/api/v1/wallet/nonce').send({ address: w2.address });
    await h.ctx.redis.del(`wallet:nonce:${other.id}`); // simulate TTL expiry
    const sig2 = await w2.signMessage(n2.body.message);
    const expired = await authed(h, other).post('/api/v1/wallet/link').send({ address: w2.address, signature: sig2 });
    expect(expired.body.error.code).toBe('NONCE_EXPIRED');
  });

  it('rejects signatures from the wrong key, for a different address, or over a different message', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    const attacker = await newWallet(h);
    const api = authed(h, user);

    let n = await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
    let res = await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature: await attacker.signMessage(n.body.message) });
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');

    n = await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
    res = await api.post('/api/v1/wallet/link').send({ address: attacker.address, signature: await attacker.signMessage(n.body.message) });
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');

    await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
    res = await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature: await wallet.signMessage('some other message') });
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');

    await api.post('/api/v1/wallet/nonce').send({ address: wallet.address });
    res = await api.post('/api/v1/wallet/link').send({ address: wallet.address, signature: '0x1234' });
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it("refuses a wallet already linked to someone else and a second wallet for the same user", async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, a, wallet);
    const nonce = await authed(h, b).post('/api/v1/wallet/nonce').send({ address: wallet.address });
    const res = await authed(h, b).post('/api/v1/wallet/link').send({ address: wallet.address, signature: await wallet.signMessage(nonce.body.message) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_IN_USE');

    const second = await newWallet(h);
    const n2 = await authed(h, a).post('/api/v1/wallet/nonce').send({ address: second.address });
    const r2 = await authed(h, a).post('/api/v1/wallet/link').send({ address: second.address, signature: await second.signMessage(n2.body.message) });
    expect(r2.body.error.code).toBe('WALLET_ALREADY_LINKED');
  });

  it('requires authentication', async () => {
    expect((await h.req().post('/api/v1/wallet/nonce').send({ address: '0x' + '1'.repeat(40) })).status).toBe(401);
    expect((await h.req().get('/api/v1/wallet/summary')).status).toBe(401);
  });

  it('credits escrow that was deposited before the wallet was linked', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await fundAndDeposit(h, wallet, '25'); // deposited while unlinked
    await linkWallet(h, user, wallet);
    const summary = await authed(h, user).get('/api/v1/wallet/summary');
    expect(summary.body.escrowWei).toBe(parseEther('25').toString());
    expect(summary.body.availableWei).toBe(parseEther('25').toString());
  });

  it('blocks unlinking while there is escrow, allows it when empty', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    await fundAndDeposit(h, wallet, '5');
    const blocked = await authed(h, user).delete('/api/v1/wallet/link');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('WALLET_HAS_BALANCE');

    await (await routerFor(h, wallet).getFunction('requestWithdraw')(parseEther('5'))).wait();
    await indexUntilCaughtUp(h.ctx);
    expect((await authed(h, user).delete('/api/v1/wallet/link')).status).toBe(409); // pending withdrawal still counts
    await h.provider.send('evm_increaseTime', [h.ctx.deployment!.withdrawDelaySec! + 5]);
    await h.provider.send('evm_mine', []);
    await (await routerFor(h, wallet).getFunction('executeWithdraw')()).wait();
    await indexUntilCaughtUp(h.ctx);
    const ok = await authed(h, user).delete('/api/v1/wallet/link');
    expect(ok.status).toBe(200);
    expect(ok.body.user.walletAddress).toBeNull();
  });
});

describe('welcome reward', () => {
  it('is created once on first link and credited into escrow without the user needing gas', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    const reward = await h.ctx.prisma.tokenReward.findFirstOrThrow({ where: { userId: user.id } });
    expect(reward.status).toBe('PENDING');
    expect(reward.reason).toBe('WELCOME');
    await processReward(h.ctx, reward.id);
    await indexUntilCaughtUp(h.ctx);
    const done = await h.ctx.prisma.tokenReward.findUniqueOrThrow({ where: { id: reward.id } });
    expect(done.status).toBe('SENT');
    expect(done.txHash).toMatch(/^0x/);
    const summary = await authed(h, user).get('/api/v1/wallet/summary');
    expect(summary.body.escrowWei).toBe(parseEther('50').toString());
    // processing twice must not pay twice
    await processReward(h.ctx, reward.id);
    await indexUntilCaughtUp(h.ctx);
    expect((await authed(h, user).get('/api/v1/wallet/summary')).body.escrowWei).toBe(parseEther('50').toString());
  });

  it('is not repeated when the wallet is unlinked and linked again, or reused by another account', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    expect(await h.ctx.prisma.tokenReward.count()).toBe(1);
    await authed(h, user).delete('/api/v1/wallet/link');
    await linkWallet(h, user, wallet);
    expect(await h.ctx.prisma.tokenReward.count()).toBe(1);

    await authed(h, user).delete('/api/v1/wallet/link');
    const farmer = await registerUser(h);
    await linkWallet(h, farmer, wallet); // same wallet, different account: no second bonus
    expect(await h.ctx.prisma.tokenReward.count()).toBe(1);
  });

  it('stays queued while the chain is unavailable and succeeds later', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    const reward = await h.ctx.prisma.tokenReward.findFirstOrThrow({ where: { userId: user.id } });
    const chain = h.ctx.chain!;
    const original = chain.depositFor.bind(chain);
    chain.depositFor = async () => {
      throw new Error('RPC down');
    };
    await expect(processReward(h.ctx, reward.id)).rejects.toThrow('RPC down');
    const failed = await h.ctx.prisma.tokenReward.findUniqueOrThrow({ where: { id: reward.id } });
    expect(failed.status).toBe('PENDING');
    expect(failed.attempts).toBe(1);
    chain.depositFor = original;
    await processReward(h.ctx, reward.id);
    expect((await h.ctx.prisma.tokenReward.findUniqueOrThrow({ where: { id: reward.id } })).status).toBe('SENT');
  });
});

describe('summary, config and transactions', () => {
  it('serves public config', async () => {
    const res = await h.req().get('/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      chainId: 31337,
      streamCoinAddress: h.ctx.deployment!.streamCoin,
      paymentRouterAddress: h.ctx.deployment!.paymentRouter,
      heartbeatIntervalSec: 10,
    });
    expect(res.body.welcomeBonusWei).toBe(parseEther('50').toString());
  });

  it('lists deposits and withdrawals with explorer links, newest first, with cursors', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    await fundAndDeposit(h, wallet, '10');
    await (await routerFor(h, wallet).getFunction('requestWithdraw')(parseEther('4'))).wait();
    await indexUntilCaughtUp(h.ctx);
    const page1 = await authed(h, user).get('/api/v1/wallet/transactions?limit=2');
    expect(page1.status).toBe(200);
    const types = page1.body.items.map((i: { type: string }) => i.type);
    expect(types).toContain('WITHDRAW_REQUESTED');
    expect(page1.body.items[0].explorerUrl).toContain('/tx/0x');
    const all = await authed(h, user).get('/api/v1/wallet/transactions?limit=50');
    expect(all.body.items.map((i: { type: string }) => i.type)).toEqual(expect.arrayContaining(['DEPOSIT', 'WITHDRAW_REQUESTED', 'REWARD']));
    if (page1.body.nextCursor) {
      const page2 = await authed(h, user).get(`/api/v1/wallet/transactions?limit=2&cursor=${page1.body.nextCursor}`);
      expect(page2.status).toBe(200);
      expect(page2.body.items.map((i: { id: string }) => i.id)).not.toEqual(expect.arrayContaining(page1.body.items.map((i: { id: string }) => i.id)));
    }
  });
});

describe('chain indexer', () => {
  it('applies deposits, withdraw request/cancel/execute to the ledger', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    await fundAndDeposit(h, wallet, '10');
    const api = authed(h, user);
    expect((await api.get('/api/v1/wallet/summary')).body.escrowWei).toBe(parseEther('10').toString());

    const router = routerFor(h, wallet);
    await (await router.getFunction('requestWithdraw')(parseEther('6'))).wait();
    await indexUntilCaughtUp(h.ctx);
    let s = (await api.get('/api/v1/wallet/summary')).body;
    expect(s.escrowWei).toBe(parseEther('4').toString());
    expect(s.pendingWithdrawalWei).toBe(parseEther('6').toString());
    expect(s.withdrawUnlockAt).toEqual(expect.any(String));

    await (await router.getFunction('cancelWithdraw')()).wait();
    await indexUntilCaughtUp(h.ctx);
    s = (await api.get('/api/v1/wallet/summary')).body;
    expect(s.escrowWei).toBe(parseEther('10').toString());
    expect(s.pendingWithdrawalWei).toBe('0');

    await (await router.getFunction('requestWithdraw')(parseEther('3'))).wait();
    await h.provider.send('evm_increaseTime', [h.ctx.deployment!.withdrawDelaySec! + 5]);
    await h.provider.send('evm_mine', []);
    await (await router.getFunction('executeWithdraw')()).wait();
    await indexUntilCaughtUp(h.ctx);
    s = (await api.get('/api/v1/wallet/summary')).body;
    expect(s.escrowWei).toBe(parseEther('7').toString());
    expect(s.pendingWithdrawalWei).toBe('0');
    expect(s.withdrawUnlockAt).toBeNull();
  });

  it('processes the same block range twice without double-crediting', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    await fundAndDeposit(h, wallet, '10');
    const before = await h.ctx.prisma.chainEvent.count();
    // Rewind the cursor so the very same blocks are fetched and applied again.
    await h.ctx.prisma.chainCursor.updateMany({ data: { lastProcessedBlock: BigInt(h.ctx.deployment!.deploymentBlock - 1) } });
    const result = await indexOnce(h.ctx);
    expect(result.processed).toBe(0);
    expect(await h.ctx.prisma.chainEvent.count()).toBe(before);
    expect((await authed(h, user).get('/api/v1/wallet/summary')).body.escrowWei).toBe(parseEther('10').toString());
  });

  it('reconstructs the exact ledger after a database reset by replaying the chain', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    await fundAndDeposit(h, wallet, '12');
    await h.ctx.prisma.escrowAccount.deleteMany();
    await h.ctx.prisma.chainEvent.deleteMany();
    await h.ctx.prisma.chainCursor.deleteMany();
    await indexUntilCaughtUp(h.ctx);
    expect((await authed(h, user).get('/api/v1/wallet/summary')).body.escrowWei).toBe(parseEther('12').toString());
  });
});
