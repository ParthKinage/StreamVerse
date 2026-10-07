import { describe, expect, it } from 'vitest';
import { summaryHasPending } from './queries';

describe('wallet polling', () => {
  it('polls only while coins are arriving or charges wait to settle', () => {
    expect(summaryHasPending(undefined)).toBe(false);
    expect(summaryHasPending({ arrivingWei: '0', unsettledChargesWei: '0' })).toBe(false);
    expect(summaryHasPending({ arrivingWei: '5', unsettledChargesWei: '0' })).toBe(true);
    expect(summaryHasPending({ arrivingWei: '0', unsettledChargesWei: '1' })).toBe(true);
    expect(summaryHasPending({})).toBe(false);
  });
});
