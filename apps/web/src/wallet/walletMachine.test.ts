import { describe, expect, it } from 'vitest';
import { initialWalletState, walletReducer, type WalletEvent, type WalletState } from './walletMachine';

const CHAIN = 80002;
const A = '0xAbC0000000000000000000000000000000000001';
const B = '0xdef0000000000000000000000000000000000002';
const run = (events: WalletEvent[], from: WalletState = initialWalletState(true)): WalletState => events.reduce(walletReducer(CHAIN), from);

describe('wallet state machine', () => {
  it('starts as no-wallet when nothing is injected', () => {
    expect(initialWalletState(false).status).toBe('no-wallet');
    expect(run([{ type: 'CONNECT_REQUESTED' }], initialWalletState(false)).status).toBe('no-wallet');
  });

  it('connects on the right network', () => {
    const s = run([{ type: 'CONNECT_REQUESTED' }, { type: 'ACCOUNTS', accounts: [A], chainId: CHAIN }]);
    expect(s).toMatchObject({ status: 'connected', address: A.toLowerCase(), chainId: CHAIN });
  });

  it('reports a wrong network and recovers when the chain changes', () => {
    let s = run([{ type: 'ACCOUNTS', accounts: [A], chainId: 1 }]);
    expect(s.status).toBe('wrong-network');
    s = run([{ type: 'CHAIN_CHANGED', chainId: CHAIN }], s);
    expect(s.status).toBe('connected');
  });

  it('treats an empty account list as locked', () => {
    expect(run([{ type: 'CONNECT_REQUESTED' }, { type: 'ACCOUNTS', accounts: [], chainId: CHAIN }]).status).toBe('locked');
  });

  it('warns when the account differs from the linked wallet, and clears when it matches again', () => {
    let s = run([{ type: 'LINKED_ADDRESS', address: B }, { type: 'ACCOUNTS', accounts: [A], chainId: CHAIN }]);
    expect(s).toMatchObject({ status: 'connected', mismatch: true });
    s = run([{ type: 'ACCOUNTS', accounts: [B], chainId: CHAIN }], s);
    expect(s.mismatch).toBe(false);
  });

  it('does not flag a mismatch when no wallet is linked yet', () => {
    expect(run([{ type: 'ACCOUNTS', accounts: [A], chainId: CHAIN }]).mismatch).toBe(false);
  });

  it('treats a rejected request as a quiet notice, not an error', () => {
    const s = run([{ type: 'CONNECT_REQUESTED' }, { type: 'USER_REJECTED' }]);
    expect(s.status).toBe('disconnected');
    expect(s.error).toBeNull();
    expect(s.notice).toMatch(/cancelled/i);
    expect(run([{ type: 'DISMISS_NOTICE' }], s).notice).toBeNull();
  });

  it('keeps the connection when a later request is rejected', () => {
    const s = run([{ type: 'ACCOUNTS', accounts: [A], chainId: CHAIN }, { type: 'USER_REJECTED' }]);
    expect(s.status).toBe('connected');
  });

  it('returns to disconnected when the wallet disconnects', () => {
    const s = run([{ type: 'ACCOUNTS', accounts: [A], chainId: CHAIN }, { type: 'DISCONNECTED' }]);
    expect(s).toMatchObject({ status: 'disconnected', address: null });
  });

  it('does not flag a wrong network until the expected chain is known', () => {
    const reducer = walletReducer(null);
    expect(reducer(initialWalletState(true), { type: 'ACCOUNTS', accounts: [A], chainId: 5 }).status).toBe('connected');
  });
});
