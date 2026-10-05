import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConfigResponse } from '@tesor_gp/shared';
import { useAuth } from '../auth/AuthContext';
import { walletApi } from '../api/endpoints';
import { keys, useConfig } from '../api/queries';
import { errorMessage } from '../api/client';
import { getProvider, hasInjectedWallet, isUserRejection } from './eip1193';
import { getSigner, readChainId, switchToAppNetwork } from './chainActions';
import { initialWalletState, walletReducer, type WalletState } from './walletMachine';

interface WalletApi {
  state: WalletState;
  config: ConfigResponse | undefined;
  connect(): Promise<void>;
  switchNetwork(): Promise<void>;
  /** Signs the server's nonce message and links the connected account to the signed-in user. */
  linkWallet(): Promise<boolean>;
  dismissNotice(): void;
}

const Ctx = createContext<WalletApi | null>(null);

export function WalletProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user, setUser } = useAuth();
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const expected = config?.chainId ?? null;
  const reducer = useMemo(() => walletReducer(expected), [expected]);
  const [state, dispatch] = useReducer(reducer, undefined, () => initialWalletState(hasInjectedWallet(), null));

  useEffect(() => {
    dispatch({ type: 'LINKED_ADDRESS', address: user?.walletAddress ?? null });
  }, [user?.walletAddress]);
  useEffect(() => {
    dispatch({ type: 'REEVALUATE' });
  }, [expected]);

  // Restore an already-authorised account silently and follow account/network changes.
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const provider = await getProvider();
      if (!provider || cancelled) {
        dispatch({ type: 'PROVIDER_DETECTED', present: Boolean(provider) });
        return;
      }
      dispatch({ type: 'PROVIDER_DETECTED', present: true });
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        if (accounts.length && !cancelled) dispatch({ type: 'ACCOUNTS', accounts, chainId: await readChainId(provider) });
      } catch {
        // Not authorised yet; the user connects explicitly.
      }
      const onAccounts = (...args: unknown[]): void => {
        const accounts = (args[0] as string[]) ?? [];
        void readChainId(provider).then((chainId) => dispatch({ type: 'ACCOUNTS', accounts, chainId }));
      };
      const onChain = (...args: unknown[]): void => dispatch({ type: 'CHAIN_CHANGED', chainId: Number.parseInt(String(args[0]), 16) });
      provider.on?.('accountsChanged', onAccounts);
      provider.on?.('chainChanged', onChain);
      off = () => {
        provider.removeListener?.('accountsChanged', onAccounts);
        provider.removeListener?.('chainChanged', onChain);
      };
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = await getProvider();
    if (!provider) {
      dispatch({ type: 'PROVIDER_DETECTED', present: false });
      return;
    }
    dispatch({ type: 'CONNECT_REQUESTED' });
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      dispatch({ type: 'ACCOUNTS', accounts, chainId: await readChainId(provider) });
    } catch (err) {
      if (isUserRejection(err)) dispatch({ type: 'USER_REJECTED' });
      else dispatch({ type: 'ERROR', message: errorMessage(err) });
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!config) return;
    try {
      await switchToAppNetwork(config);
    } catch (err) {
      if (isUserRejection(err)) dispatch({ type: 'USER_REJECTED' });
      else dispatch({ type: 'ERROR', message: errorMessage(err) });
    }
  }, [config]);

  const linkWallet = useCallback(async (): Promise<boolean> => {
    if (!state.address) return false;
    try {
      const nonce = await walletApi.nonce(state.address);
      const signer = await getSigner();
      const signature = await signer.signMessage(nonce.message);
      const res = await walletApi.link(state.address, signature);
      setUser(res.user);
      await qc.invalidateQueries({ queryKey: keys.summary });
      await qc.invalidateQueries({ queryKey: keys.transactions });
      return true;
    } catch (err) {
      if (isUserRejection(err)) dispatch({ type: 'USER_REJECTED' });
      else dispatch({ type: 'ERROR', message: errorMessage(err) });
      return false;
    }
  }, [state.address, setUser, qc]);

  const value = useMemo<WalletApi>(
    () => ({ state, config, connect, switchNetwork, linkWallet, dismissNotice: () => dispatch({ type: 'DISMISS_NOTICE' }) }),
    [state, config, connect, switchNetwork, linkWallet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside WalletProvider');
  return v;
}
