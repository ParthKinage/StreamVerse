/* Test-only EIP-1193 provider (bundled only when VITE_E2E=1). Signs with a Hardhat key so Playwright needs no extension. */
import { JsonRpcProvider, Network, Wallet, type TransactionRequest } from 'ethers';
import type { Eip1193Provider } from './eip1193';

export function createE2eProvider(cfg: { privateKey: string; rpcUrl: string; chainId: number }): Eip1193Provider {
  const rpc = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: Network.from(cfg.chainId), cacheTimeout: -1 });
  const wallet = new Wallet(cfg.privateKey, rpc);
  let chainId = cfg.chainId;
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]): void => listeners.get(event)?.forEach((fn) => fn(...args));

  return {
    isMetaMask: false,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    async request({ method, params }) {
      const p = (Array.isArray(params) ? params : []) as unknown[];
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [wallet.address.toLowerCase()];
        case 'eth_chainId':
          return `0x${chainId.toString(16)}`;
        case 'net_version':
          return String(chainId);
        case 'wallet_switchEthereumChain': {
          const target = Number.parseInt((p[0] as { chainId: string }).chainId, 16);
          chainId = target;
          emit('chainChanged', `0x${target.toString(16)}`);
          return null;
        }
        case 'wallet_addEthereumChain':
          return null;
        case 'personal_sign': {
          // params: [message(hex), address]
          const raw = String(p[0]);
          const bytes = raw.startsWith('0x') ? Uint8Array.from(raw.slice(2).match(/.{1,2}/g)?.map((h) => Number.parseInt(h, 16)) ?? []) : new TextEncoder().encode(raw);
          return wallet.signMessage(bytes);
        }
        case 'eth_signTypedData_v4': {
          const typed = JSON.parse(String(p[1])) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, unknown>; primaryType: string };
          const types = { ...typed.types };
          delete (types as Record<string, unknown>).EIP712Domain;
          return wallet.signTypedData(typed.domain, types, typed.message);
        }
        case 'eth_sendTransaction': {
          const tx = p[0] as TransactionRequest & { gas?: string };
          const sent = await wallet.sendTransaction({ to: tx.to ?? null, data: tx.data ?? '0x', value: tx.value ?? 0n, ...(tx.gas ? { gasLimit: tx.gas } : {}) });
          return sent.hash;
        }
        default:
          return rpc.send(method, p);
      }
    },
  };
}
