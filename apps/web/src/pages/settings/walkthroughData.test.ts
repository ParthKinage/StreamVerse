import { describe, expect, it } from 'vitest';
import { chapters } from './walkthroughData';

describe('the walkthrough', () => {
  it('covers every part of the app in order, with a page to open where there is one', () => {
    const list = chapters({ addMoney: 'Buy coins', balance: 'coin balance' });
    expect(list.map((c) => c.id)).toEqual(['welcome', 'discover', 'watch', 'live', 'wallet', 'library', 'studio', 'go-live', 'safety', 'account', 'admin']);
    expect(list.filter((c) => c.adminOnly).map((c) => c.id)).toEqual(['admin']);
    for (const c of list) {
      expect(c.points.length, c.id).toBeGreaterThan(0);
      for (const l of c.links) expect(l.to.startsWith('/'), `${c.id} ${l.to}`).toBe(true);
    }
  });

  it('uses the money words of the payment mode', () => {
    const bank = chapters({ addMoney: 'Add money', balance: 'balance' });
    expect(bank.find((c) => c.id === 'wallet')!.points[0]).toBe('Add money adds to your balance.');
    expect(bank.find((c) => c.id === 'watch')!.points.join(' ')).toContain('use Add money');
  });
});
