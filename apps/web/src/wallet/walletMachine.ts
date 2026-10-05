/** Pure state machine for the wallet connection. UI and tests drive it with events; it never touches the network. */
export type WalletStatus =
  | 'no-wallet' // nothing injected: show install guidance
  | 'disconnected' // wallet present, not connected
  | 'connecting'
  | 'locked' // wallet present but no account available (locked or access denied)
  | 'wrong-network'
  | 'connected';

export interface WalletState {
  status: WalletStatus;
  address: string | null;
  chainId: number | null;
  /** Wallet address the server has linked to the signed-in user (lowercase) or null. */
  linkedAddress: string | null;
  /** The account in the wallet differs from the linked one. */
  mismatch: boolean;
  /** Quiet, non-error message (for example after the user declined a request). */
  notice: string | null;
  error: string | null;
}

export type WalletEvent =
  | { type: 'PROVIDER_DETECTED'; present: boolean }
  | { type: 'CONNECT_REQUESTED' }
  | { type: 'ACCOUNTS'; accounts: string[]; chainId: number | null }
  | { type: 'CHAIN_CHANGED'; chainId: number }
  | { type: 'USER_REJECTED' }
  | { type: 'ERROR'; message: string }
  | { type: 'LINKED_ADDRESS'; address: string | null }
  | { type: 'DISCONNECTED' }
  | { type: 'DISMISS_NOTICE' }
  | { type: 'REEVALUATE' };

export function initialWalletState(present: boolean, linkedAddress: string | null = null): WalletState {
  return { status: present ? 'disconnected' : 'no-wallet', address: null, chainId: null, linkedAddress, mismatch: false, notice: null, error: null };
}

function derive(s: WalletState, expectedChainId: number | null): WalletState {
  if (s.status === 'no-wallet' || s.status === 'connecting' || s.status === 'disconnected' || s.status === 'locked') return { ...s, mismatch: false };
  const wrong = expectedChainId !== null && s.chainId !== null && s.chainId !== expectedChainId;
  const mismatch = Boolean(s.address && s.linkedAddress && s.address.toLowerCase() !== s.linkedAddress.toLowerCase());
  return { ...s, status: wrong ? 'wrong-network' : 'connected', mismatch };
}

export function walletReducer(expectedChainId: number | null) {
  return (state: WalletState, event: WalletEvent): WalletState => {
    switch (event.type) {
      case 'PROVIDER_DETECTED':
        if (!event.present) return { ...state, status: 'no-wallet', address: null, chainId: null, mismatch: false };
        return state.status === 'no-wallet' ? { ...state, status: 'disconnected' } : state;
      case 'CONNECT_REQUESTED':
        return state.status === 'no-wallet' ? state : { ...state, status: 'connecting', notice: null, error: null };
      case 'ACCOUNTS': {
        const address = event.accounts[0]?.toLowerCase() ?? null;
        if (!address) return { ...state, status: 'locked', address: null, mismatch: false };
        return derive({ ...state, status: 'connected', address, chainId: event.chainId ?? state.chainId, error: null }, expectedChainId);
      }
      case 'CHAIN_CHANGED':
        return state.address ? derive({ ...state, chainId: event.chainId }, expectedChainId) : { ...state, chainId: event.chainId };
      case 'USER_REJECTED':
        return { ...state, status: state.address ? state.status : 'disconnected', notice: 'Request cancelled in your wallet. Nothing was changed.', error: null };
      case 'ERROR':
        return { ...state, status: state.address ? state.status : 'disconnected', error: event.message };
      case 'LINKED_ADDRESS':
        return derive({ ...state, linkedAddress: event.address?.toLowerCase() ?? null }, expectedChainId);
      case 'DISCONNECTED':
        return { ...state, status: 'disconnected', address: null, chainId: null, mismatch: false };
      case 'REEVALUATE':
        return state.address ? derive(state, expectedChainId) : state;
      case 'DISMISS_NOTICE':
        return { ...state, notice: null };
      default:
        return state;
    }
  };
}
