/** Pure state machine mirroring PaymentRouter's escrow accounting, driven by its events. */
export interface EscrowState {
  escrow: bigint;
  pending: bigint;
  unlockAt: number | null;
}

export const EMPTY_ESCROW: EscrowState = { escrow: 0n, pending: 0n, unlockAt: null };

const sub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

export function foldEscrow(state: EscrowState, name: string, args: Record<string, string>): EscrowState {
  const amount = args.amount !== undefined ? BigInt(args.amount) : 0n;
  switch (name) {
    case 'Deposited':
      return { ...state, escrow: state.escrow + amount };
    case 'WithdrawRequested':
      return { escrow: sub(state.escrow, amount), pending: amount, unlockAt: Number(args.unlockAt) };
    case 'WithdrawCancelled':
      return { escrow: state.escrow + state.pending, pending: 0n, unlockAt: null };
    case 'Withdrawn':
      return { ...state, pending: 0n, unlockAt: null };
    case 'Settled': {
      // Escrow first, then the pending withdrawal (same order as the contract).
      if (state.escrow >= amount) return { ...state, escrow: state.escrow - amount };
      const shortfall = amount - state.escrow;
      return { ...state, escrow: 0n, pending: sub(state.pending, shortfall) };
    }
    default:
      return state;
  }
}

/** Event names that change a viewer's escrow. */
export const ESCROW_EVENTS = new Set(['Deposited', 'WithdrawRequested', 'WithdrawCancelled', 'Withdrawn', 'Settled']);
