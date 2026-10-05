import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@tesor_gp/shared';
import { ConnectGate } from './ConnectGate';
import type { WalletState } from './walletMachine';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
let wallet: WalletState;
let user: UserDto;
const actions = vi.hoisted(() => ({ connect: vi.fn(), switchNetwork: vi.fn(), linkWallet: vi.fn(async () => true), dismissNotice: vi.fn() }));
vi.mock('./WalletContext', () => ({ useWallet: () => ({ state: wallet, config: { chainName: 'Polygon Amoy' }, ...actions }) }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user }) }));

const base: WalletState = { status: 'connected', address: A, chainId: 80002, linkedAddress: A, mismatch: false, notice: null, error: null };
beforeEach(() => {
  Object.values(actions).forEach((f) => f.mockClear());
  wallet = { ...base };
  user = { id: 'u', email: 'x@y.zz', username: 'x', role: 'USER', walletAddress: A, channelName: null, createdAt: '' };
});

describe('ConnectGate', () => {
  it('shows install guidance when no wallet is present', () => {
    wallet = { ...base, status: 'no-wallet', address: null };
    render(<ConnectGate>secret</ConnectGate>);
    expect(screen.getByTestId('gate-no-wallet')).toHaveTextContent(/install/i);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('asks to connect and calls connect', async () => {
    wallet = { ...base, status: 'disconnected', address: null };
    render(<ConnectGate>secret</ConnectGate>);
    await userEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(actions.connect).toHaveBeenCalled();
  });

  it('offers a one-click network switch', async () => {
    wallet = { ...base, status: 'wrong-network', chainId: 1 };
    render(<ConnectGate>secret</ConnectGate>);
    expect(screen.getByTestId('gate-wrong-network')).toHaveTextContent('Polygon Amoy');
    await userEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    expect(actions.switchNetwork).toHaveBeenCalled();
  });

  it('warns when the selected account differs from the linked wallet', () => {
    wallet = { ...base, address: B, mismatch: true };
    render(<ConnectGate>secret</ConnectGate>);
    expect(screen.getByRole('alert')).toHaveTextContent(/not the wallet linked/i);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('asks the user to sign to link a wallet that is not linked yet', async () => {
    user = { ...user, walletAddress: null };
    wallet = { ...base, linkedAddress: null };
    render(<ConnectGate>secret</ConnectGate>);
    await userEvent.click(screen.getByRole('button', { name: 'Link wallet' }));
    expect(actions.linkWallet).toHaveBeenCalled();
  });

  it('renders children when everything is in order and shows quiet notices', () => {
    wallet = { ...base, notice: 'Request cancelled in your wallet. Nothing was changed.' };
    render(<ConnectGate>secret</ConnectGate>);
    expect(screen.getByText('secret')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/cancelled/i);
  });
});
