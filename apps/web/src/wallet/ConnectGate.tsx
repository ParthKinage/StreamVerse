import { useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { shortAddress } from '../lib/format';
import { useWallet } from './WalletContext';

/**
 * Renders `children` only when the wallet is installed, unlocked, on the right network, and linked to the account.
 * Otherwise explains the one thing the user needs to do next.
 */
export function ConnectGate({ children, requireLinked = true }: { children: ReactNode; requireLinked?: boolean }): JSX.Element {
  const { state, config, connect, switchNetwork, linkWallet, dismissNotice } = useWallet();
  const { user } = useAuth();
  const [linking, setLinking] = useState(false);

  const notice = state.notice ? (
    <p className="notice" role="status">
      {state.notice}{' '}
      <button type="button" className="link-btn" onClick={dismissNotice}>
        Dismiss
      </button>
    </p>
  ) : null;
  const error = state.error ? (
    <p className="form-error" role="alert">
      {state.error}
    </p>
  ) : null;

  if (state.status === 'no-wallet') {
    return (
      <div className="gate" data-testid="gate-no-wallet">
        <h3>A wallet is required</h3>
        <p className="muted">Install a browser wallet such as MetaMask, then reload this page to connect it.</p>
        <a className="btn primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer noopener">
          Get MetaMask
        </a>
      </div>
    );
  }
  if (state.status === 'disconnected' || state.status === 'connecting') {
    return (
      <div className="gate" data-testid="gate-connect">
        {notice}
        {error}
        <p className="muted">Connect your wallet to continue.</p>
        <button type="button" className="btn primary" disabled={state.status === 'connecting'} onClick={() => void connect()}>
          {state.status === 'connecting' ? 'Waiting for your wallet…' : 'Connect wallet'}
        </button>
      </div>
    );
  }
  if (state.status === 'locked') {
    return (
      <div className="gate" data-testid="gate-locked">
        <p>Your wallet is locked or has not shared an account. Unlock it, then try again.</p>
        <button type="button" className="btn" onClick={() => void connect()}>
          Try again
        </button>
      </div>
    );
  }
  if (state.status === 'wrong-network') {
    return (
      <div className="gate" data-testid="gate-wrong-network">
        {notice}
        {error}
        <p>Your wallet is on the wrong network. Switch to {config?.chainName ?? 'the app network'} to continue.</p>
        <button type="button" className="btn primary" onClick={() => void switchNetwork()}>
          Switch network
        </button>
      </div>
    );
  }
  if (state.mismatch) {
    return (
      <div className="gate warn" data-testid="gate-mismatch" role="alert">
        <p>
          The account selected in your wallet ({shortAddress(state.address)}) is not the wallet linked to your profile ({shortAddress(state.linkedAddress)}). Switch back to the linked account in your
          wallet to continue.
        </p>
      </div>
    );
  }
  if (requireLinked && user && !user.walletAddress) {
    return (
      <div className="gate" data-testid="gate-link">
        {notice}
        {error}
        <p>Link {shortAddress(state.address)} to your account by signing a message. This costs no gas.</p>
        <button
          type="button"
          className="btn primary"
          disabled={linking}
          onClick={() => {
            setLinking(true);
            void linkWallet().finally(() => setLinking(false));
          }}
        >
          {linking ? 'Waiting for signature…' : 'Link wallet'}
        </button>
      </div>
    );
  }
  return (
    <>
      {notice}
      {children}
    </>
  );
}
