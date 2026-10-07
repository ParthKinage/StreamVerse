import { Contract, FeeData, JsonRpcProvider, Wallet, id as keccak, parseEther, parseUnits } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChainAdapter, cappedFeeData } from '../adapter';
import { PAYMENT_ROUTER_ABI, STREAM_COIN_ABI } from '../abis';
import { InsufficientGas, Reverted, RpcUnavailable } from '../errors';
import { FlakyRpcProxy, fundWithStrm, hardhatAccount, startLocalChain, type LocalChain } from '../testing';
import { Mutex } from '../mutex';

let chain: LocalChain;
let adapter: ChainAdapter;
const viewerWallet = hardhatAccount(5);
const creatorWallet = hardhatAccount(6);

function cfg(rpcUrl: string, extra: Partial<ConstructorParameters<typeof ChainAdapter>[0]> = {}) {
  return {
    rpcUrl,
    chainId: chain.chainId,
    streamCoinAddress: chain.streamCoin,
    paymentRouterAddress: chain.paymentRouter,
    relayerPrivateKey: chain.deployer.privateKey,
    timeoutMs: 3000,
    retries: 2,
    retryBaseDelayMs: 50,
    ...extra,
  };
}

beforeAll(async () => {
  chain = await startLocalChain();
  adapter = new ChainAdapter(cfg(chain.rpcUrl));
  await fundWithStrm(chain, viewerWallet.address, '1000');
  const viewer = new Wallet(viewerWallet.privateKey, adapter.provider);
  const token = new Contract(chain.streamCoin, STREAM_COIN_ABI, viewer);
  const router = new Contract(chain.paymentRouter, PAYMENT_ROUTER_ABI, viewer);
  await (await token.getFunction('approve')(chain.paymentRouter, parseEther('1000'))).wait();
  await (await router.getFunction('deposit')(parseEther('100'))).wait();
});

afterAll(async () => {
  adapter?.destroy();
  await chain?.stop();
});

describe('ChainAdapter reads', () => {
  it('reads escrow, balances and config', async () => {
    const state = await adapter.getEscrow(viewerWallet.address);
    expect(state.escrow).toBe(parseEther('100'));
    expect(state.pendingWithdrawal).toBe(0n);
    expect(await adapter.getTokenBalance(viewerWallet.address)).toBe(parseEther('900'));
    expect(await adapter.getFeeBps()).toBe(1000);
    expect(await adapter.getWithdrawDelay()).toBe(900);
  });
});

describe('ChainAdapter settlement', () => {
  const key = keccak('session-1');
  it('settles a batch, exposes logs and rejects double settlement with a typed error', async () => {
    const items = [{ id: key, viewer: viewerWallet.address, creator: creatorWallet.address, amount: parseEther('10') }];
    await adapter.simulateSettleBatch(items);
    const result = await adapter.settleBatch(items);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await adapter.isSettled(key)).toBe(true);
    expect(await adapter.getCreatorEarnings(creatorWallet.address)).toBe(parseEther('9'));
    expect((await adapter.getEscrow(viewerWallet.address)).escrow).toBe(parseEther('90'));

    const logs = await adapter.getLogs(0, await adapter.getBlockNumber());
    const names = logs.map((l) => l.name);
    expect(names).toContain('Deposited');
    const settled = logs.find((l) => l.name === 'Settled');
    expect(settled?.address).toBe(viewerWallet.address.toLowerCase());
    expect(settled?.args.amount).toBe(parseEther('10').toString());

    const found = await adapter.findSettlementTx(key, 0);
    expect(found?.txHash).toBe(result.txHash);

    await expect(adapter.settleBatch(items)).rejects.toMatchObject({ name: 'Reverted', reason: 'AlreadySettled' });
  });

  it('maps an insufficient-escrow revert', async () => {
    const items = [{ id: keccak('big'), viewer: viewerWallet.address, creator: creatorWallet.address, amount: parseEther('5000') }];
    const err = await adapter.simulateSettleBatch(items).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Reverted);
    expect((err as Reverted).reason).toBe('InsufficientEscrow');
  });

  it('serialises concurrent relayer sends without nonce collisions', async () => {
    const batches = [1, 2, 3].map((n) => [
      { id: keccak(`parallel-${n}`), viewer: viewerWallet.address, creator: creatorWallet.address, amount: parseEther('1') },
    ]);
    const results = await Promise.all(batches.map((b) => adapter.settleBatch(b)));
    expect(new Set(results.map((r) => r.txHash)).size).toBe(3);
  });

  it('depositFor credits another account from the relayer balance', async () => {
    const target = hardhatAccount(7).address;
    await adapter.depositFor(target, parseEther('50'));
    expect((await adapter.getEscrow(target)).escrow).toBe(parseEther('50'));
  });
});

describe('ChainAdapter platform-run wallets', () => {
  const a = hardhatAccount(8).address;
  const b = hardhatAccount(9).address;

  it('credits several accounts in one transaction and never twice', async () => {
    const items = [
      { id: keccak('credit-a'), viewer: a, amount: parseEther('30') },
      { id: keccak('credit-b'), viewer: b, amount: parseEther('12') },
    ];
    await adapter.simulateCreditBatch(items);
    const result = await adapter.creditBatch(items);
    expect((await adapter.getEscrow(a)).escrow).toBe(parseEther('30'));
    expect((await adapter.getEscrow(b)).escrow).toBe(parseEther('12'));
    expect(await adapter.areCredited([keccak('credit-a'), keccak('credit-b'), keccak('never')])).toEqual([true, true, false]);
    expect((await adapter.findCreditTx(keccak('credit-b'), 0))?.txHash).toBe(result.txHash);

    const logs = await adapter.getLogs(result.blockNumber, result.blockNumber);
    expect(logs.filter((l) => l.name === 'Deposited').map((l) => l.address)).toEqual([a.toLowerCase(), b.toLowerCase()]);

    await expect(adapter.creditBatch(items)).rejects.toMatchObject({ name: 'Reverted', reason: 'AlreadyCredited' });
    expect((await adapter.getEscrow(a)).escrow).toBe(parseEther('30'));
  });

  it('offers a fee ceiling of base fee + 25% + tip instead of 2 x base fee + tip', async () => {
    const plain = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    const uncapped = await plain.getFeeData();
    const result = await adapter.creditBatch([{ id: keccak('fee-cap'), viewer: a, amount: parseEther('1') }]);
    const tx = await plain.getTransaction(result.txHash);
    plain.destroy();
    expect(tx?.maxFeePerGas).toBeDefined();
    expect(tx!.maxFeePerGas! < uncapped.maxFeePerGas!).toBe(true);
  });

  it('pays creator earnings to the creator address with the relayer paying gas', async () => {
    const creator = hardhatAccount(10).address;
    await adapter.settleBatch([{ id: keccak('payout-1'), viewer: a, creator, amount: parseEther('10') }]);
    expect(await adapter.getCreatorEarnings(creator)).toBe(parseEther('9'));
    await adapter.claimEarningsFor(creator);
    expect(await adapter.getTokenBalance(creator)).toBe(parseEther('9'));
    expect(await adapter.getCreatorEarnings(creator)).toBe(0n);
    await expect(adapter.claimEarningsFor(creator)).rejects.toMatchObject({ name: 'Reverted', reason: 'NothingToClaim' });
  });
});

describe('ChainAdapter failure handling', () => {
  it('reports RpcUnavailable when the node is down, then recovers', async () => {
    const proxy = new FlakyRpcProxy(chain.rpcUrl);
    const url = await proxy.start();
    const flaky = new ChainAdapter(cfg(url, { timeoutMs: 1000, retries: 1, retryBaseDelayMs: 20 }));
    try {
      expect(await flaky.getBlockNumber()).toBeGreaterThan(0);
      proxy.down = true;
      await expect(flaky.getBlockNumber()).rejects.toBeInstanceOf(RpcUnavailable);
      proxy.down = false;
      expect(await flaky.getBlockNumber()).toBeGreaterThan(0);
    } finally {
      flaky.destroy();
      await proxy.stop();
    }
  });

  it('maps an unfunded relayer to InsufficientGas', async () => {
    const poor = Wallet.createRandom();
    const router = new Contract(chain.paymentRouter, PAYMENT_ROUTER_ABI, chain.deployer.connect(adapter.provider));
    await (await router.getFunction('grantRole')(await router.getFunction('SETTLER_ROLE')(), poor.address)).wait();
    const broke = new ChainAdapter(cfg(chain.rpcUrl, { relayerPrivateKey: poor.privateKey }));
    try {
      await expect(
        broke.settleBatch([{ id: keccak('nogas'), viewer: viewerWallet.address, creator: creatorWallet.address, amount: 1n }]),
      ).rejects.toBeInstanceOf(InsufficientGas);
    } finally {
      broke.destroy();
    }
  });

  it('refuses writes on a read-only adapter', async () => {
    const ro = new ChainAdapter({ ...cfg(chain.rpcUrl), relayerPrivateKey: undefined });
    try {
      await expect(ro.settleBatch([])).rejects.toThrow(/read-only/);
    } finally {
      ro.destroy();
    }
  });
});

describe('Mutex', () => {
  it('runs tasks strictly in order and survives failures', async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    const a = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const b = mutex.run(async () => {
      order.push(2);
      throw new Error('boom');
    });
    const c = mutex.run(async () => {
      order.push(3);
    });
    await a;
    await expect(b).rejects.toThrow('boom');
    await c;
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('fee ceiling', () => {
  const gwei = (n: number) => parseUnits(String(n), 'gwei');

  it('turns 2 x base + tip into base x 1.25 + tip (Amoy on 2026-10-07: 30 base, 25 tip)', () => {
    const capped = cappedFeeData(new FeeData(gwei(55), gwei(85), gwei(25)), 25);
    expect(capped.maxFeePerGas).toBe(gwei(62.5));
    expect(capped.maxPriorityFeePerGas).toBe(gwei(25));
    expect(capped.gasPrice).toBe(gwei(55));
  });

  it('leaves legacy (non EIP-1559) fee data alone and honours another headroom', () => {
    const legacy = new FeeData(gwei(40), null, null);
    expect(cappedFeeData(legacy, 25)).toBe(legacy);
    expect(cappedFeeData(new FeeData(null, gwei(85), gwei(25)), 0).maxFeePerGas).toBe(gwei(55));
  });
});
