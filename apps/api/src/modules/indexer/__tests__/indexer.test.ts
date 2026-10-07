import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'ethers';
import { RpcUnavailable } from '@tesor_gp/blockchain';
import { authed, createHarness, fundAndDeposit, linkWallet, newWallet, registerUser, resetDb, type Harness } from '../../../test/harness';
import { indexOnce, indexUntilCaughtUp } from '../indexer.service';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.ctx);
  await indexUntilCaughtUp(h.ctx);
});

/** Makes the chain behave like a free RPC plan: eth_getLogs over more than `max` blocks is refused. */
function capLogRange(max: number) {
  const chain = h.ctx.chain!;
  const real = chain.getLogs.bind(chain);
  const ranges: number[] = [];
  const spy = vi.spyOn(chain, 'getLogs').mockImplementation(async (from: number, to: number) => {
    ranges.push(to - from + 1);
    if (to - from + 1 > max) throw new RpcUnavailable('RPC unavailable: server response 400 Bad Request');
    return real(from, to);
  });
  return { ranges, restore: () => spy.mockRestore() };
}

describe('indexer with an RPC that limits the log range', () => {
  it('steps down to a range the RPC accepts and still shows the deposit', async () => {
    const user = await registerUser(h);
    const wallet = await newWallet(h);
    await linkWallet(h, user, wallet);
    // Push the chain well past a 10-block window so the indexer has to make many small requests.
    for (let i = 0; i < 30; i++) await h.provider.send('evm_mine', []);
    const cap = capLogRange(10);
    try {
      await fundAndDeposit(h, wallet, '25');
    } finally {
      cap.restore();
    }
    expect(cap.ranges.some((r) => r > 10)).toBe(true); // it tried the default first
    expect(cap.ranges.filter((r, i) => i > 0 && cap.ranges[i - 1]! <= 10).every((r) => r <= 10)).toBe(true); // then stayed small
    const summary = await authed(h, user).get('/api/v1/wallet/summary');
    expect(summary.body.escrowWei).toBe(parseEther('25').toString());
  });

  it('reports when it is still behind so the caller keeps reading', async () => {
    for (let i = 0; i < 25; i++) await h.provider.send('evm_mine', []);
    const cap = capLogRange(10);
    try {
      const first = await indexOnce(h.ctx);
      expect(first.behind).toBe(true);
      await indexUntilCaughtUp(h.ctx);
      expect((await indexOnce(h.ctx)).behind).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it('gives up with the RPC error when not even one block can be read', async () => {
    for (let i = 0; i < 3; i++) await h.provider.send('evm_mine', []);
    const cap = capLogRange(0);
    try {
      await expect(indexOnce(h.ctx)).rejects.toBeInstanceOf(RpcUnavailable);
    } finally {
      cap.restore();
    }
  });
});
