import { describe, expect, it } from 'vitest';
import { InsufficientGas, Reverted } from '@tesor_gp/blockchain';
import { sendAffordable } from '../affordable';

/** A relayer that can pay for at most `max` items per transaction. */
const relayerFor = (max: number) => {
  const tried: number[] = [];
  const send = async (batch: number[]): Promise<string> => {
    tried.push(batch.length);
    if (batch.length > max) throw new InsufficientGas('Relayer account has insufficient gas funds');
    return `tx-${batch.join(',')}`;
  };
  return { tried, send };
};

describe('sendAffordable', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];

  it('sends everything in one transaction when the gas is there', async () => {
    const r = relayerFor(100);
    expect(await sendAffordable(items, r.send)).toEqual({ sent: items, result: 'tx-1,2,3,4,5,6,7,8' });
    expect(r.tried).toEqual([8]);
  });

  it('sends the oldest items it can afford when gas is short, halving down', async () => {
    const r = relayerFor(2);
    expect(await sendAffordable(items, r.send)).toEqual({ sent: [1, 2], result: 'tx-1,2' });
    expect(r.tried).toEqual([8, 4, 2]);
  });

  it('gives up with InsufficientGas when not even one item fits', async () => {
    const r = relayerFor(0);
    await expect(sendAffordable(items, r.send)).rejects.toBeInstanceOf(InsufficientGas);
    expect(r.tried).toEqual([8, 4, 2, 1]);
  });

  it('does not shrink the batch for other errors', async () => {
    let calls = 0;
    const send = async (): Promise<string> => {
      calls++;
      throw new Reverted('Transaction failed on-chain');
    };
    await expect(sendAffordable(items, send)).rejects.toBeInstanceOf(Reverted);
    expect(calls).toBe(1);
  });
});
