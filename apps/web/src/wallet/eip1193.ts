export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
    /** Set by the Playwright harness; only read when VITE_E2E=1. */
    __E2E_WALLET__?: { privateKey: string; rpcUrl: string; chainId: number };
  }
}

let e2eProvider: Eip1193Provider | null | undefined;

/** The injected wallet (MetaMask etc). Under VITE_E2E=1 a test provider backed by a Hardhat key is used instead. */
export async function getProvider(): Promise<Eip1193Provider | null> {
  if (import.meta.env.VITE_E2E === '1' && window.__E2E_WALLET__) {
    if (e2eProvider === undefined) {
      const mod = await import('./e2eProvider');
      e2eProvider = mod.createE2eProvider(window.__E2E_WALLET__);
    }
    return e2eProvider;
  }
  return window.ethereum ?? null;
}

/** Synchronous presence check used for first render. */
export function hasInjectedWallet(): boolean {
  return (import.meta.env.VITE_E2E === '1' && Boolean(window.__E2E_WALLET__)) || Boolean(window.ethereum);
}

export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number | string; info?: { error?: { code?: number } }; message?: string } | undefined;
  return e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001 || /user (rejected|denied)/i.test(e?.message ?? '');
}

export function isUnrecognizedChain(err: unknown): boolean {
  const e = err as { code?: number } | undefined;
  return e?.code === 4902;
}
