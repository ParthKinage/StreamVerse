import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse, UserDto, WalletSummary } from '@tesor_gp/shared';
import { ToastProvider } from '../components/Toasts';
import { TopUpDialog } from './TopUpDialog';
import type { WalletState } from './walletMachine';

const config: ConfigResponse = {
  paymentsMode: 'chain',
  currencyCode: 'STRM',
  currencySymbol: '',
  bankAccounts: [],
  minTopUpWei: '0',
  maxTopUpWei: '0',
  chainId: 31337,
  chainName: 'Hardhat',
  rpcUrl: 'http://localhost:8545',
  explorerUrl: 'https://explorer.test',
  streamCoinAddress: '0x' + '1'.repeat(40),
  paymentRouterAddress: '0x' + '2'.repeat(40),
  heartbeatIntervalSec: 10,
  welcomeBonusWei: '0',
  withdrawDelaySec: 900,
  feeBps: 1000,
  maxPriceWei: '500000000000000000000',
  accessHours: 48,
  maxUploadMb: 1024,
  categories: ['General'],
};
const user: UserDto = { id: 'u1', email: 'a@b.co', username: 'alice', role: 'USER', walletAddress: '0x' + 'a'.repeat(40), channelName: null, createdAt: new Date().toISOString() };
const walletState: WalletState = { status: 'connected', address: user.walletAddress, chainId: 31337, linkedAddress: user.walletAddress, mismatch: false, notice: null, error: null };
let summary: WalletSummary;

vi.mock('./WalletContext', () => ({
  useWallet: () => ({ state: walletState, config, connect: vi.fn(), switchNetwork: vi.fn(), linkWallet: vi.fn(), dismissNotice: vi.fn() }),
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user }) }));
vi.mock('../api/endpoints', () => ({ walletApi: { summary: vi.fn(async () => summary) }, configApi: { get: vi.fn() } }));

const chain = vi.hoisted(() => ({ topUp: vi.fn(), gas: vi.fn(), balance: vi.fn() }));
vi.mock('./chainActions', async () => {
  const real = await vi.importActual<typeof import('./chainActions')>('./chainActions');
  return {
    ...real,
    getSigner: vi.fn(async () => ({})),
    gasBalance: chain.gas,
    tokenBalance: chain.balance,
    topUp: chain.topUp,
  };
});

function renderDialog(ui: ReactNode = <TopUpDialog onClose={vi.fn()} onDone={vi.fn()} />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['wallet', 'summary'], summary);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  summary = { walletAddress: user.walletAddress, escrowWei: '0', pendingWithdrawalWei: '0', withdrawUnlockAt: null, unsettledChargesWei: '0', availableWei: '0', creatorEarningsWei: '0' };
  chain.topUp.mockReset();
  chain.gas.mockReset().mockResolvedValue(1n);
  chain.balance.mockReset().mockResolvedValue(100n * 10n ** 18n);
});

describe('top-up flow', () => {
  it('validates the amount inline and keeps submit from running', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = await screen.findByLabelText(/amount/i);
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Deposit' }));
    expect(await screen.findByText('Enter an amount')).toBeInTheDocument();

    await user.type(input, '1.1234567890123456789');
    await user.tab();
    expect(await screen.findByText(/up to 18 decimals/i)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '500');
    await user.tab();
    expect(await screen.findByText(/wallet holds 100 STRM/i)).toBeInTheDocument();
    expect(chain.topUp).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeDisabled();
  });

  it('shows each step, disables the buttons while pending, then confirms', async () => {
    const u = userEvent.setup();
    let finish: () => void = () => undefined;
    chain.topUp.mockImplementation(async (_cfg, _amount, hooks) => {
      hooks.onStep('signing');
      hooks.onStep('depositing');
      hooks.onTx('0xabc');
      await new Promise<void>((r) => (finish = r));
    });
    const onDone = vi.fn();
    renderDialog(<TopUpDialog onClose={vi.fn()} onDone={onDone} />);
    const input = await screen.findByLabelText(/amount/i);
    await u.clear(input);
    await u.type(input, '5');
    // the API balance will reflect the deposit as soon as the dialog checks
    summary = { ...summary, escrowWei: (5n * 10n ** 18n).toString() };
    await u.click(screen.getByRole('button', { name: 'Deposit' }));

    const steps = await screen.findByTestId('topup-steps');
    expect(steps).toHaveTextContent(/confirm the deposit/i);
    expect(screen.getByRole('link', { name: /view transaction/i })).toHaveAttribute('href', 'https://explorer.test/tx/0xabc');
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(chain.topUp).toHaveBeenCalledTimes(1);
    expect(chain.topUp.mock.calls[0]![1]).toBe(5n * 10n ** 18n);

    finish();
    expect(await screen.findByTestId('topup-confirmed', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('treats a rejection in the wallet as a quiet notice, not an error', async () => {
    const u = userEvent.setup();
    chain.topUp.mockRejectedValue(Object.assign(new Error('User denied transaction signature'), { code: 4001 }));
    renderDialog();
    await u.click(await screen.findByRole('button', { name: 'Deposit' }));
    expect(await screen.findByText(/cancelled in your wallet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeEnabled();
  });

  it('shows failures as an alert and lets the user retry', async () => {
    const u = userEvent.setup();
    chain.topUp.mockRejectedValue(new Error('The transaction failed on-chain'));
    renderDialog();
    await u.click(await screen.findByRole('button', { name: 'Deposit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The transaction failed on-chain');
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeEnabled();
  });

  it('points to the faucet only when the gas balance is zero', async () => {
    chain.gas.mockResolvedValue(0n);
    renderDialog();
    expect(await screen.findByTestId('gas-note')).toHaveTextContent(/faucet/i);
  });

  it('does not show the faucet note when the wallet has gas', async () => {
    renderDialog();
    await screen.findByLabelText(/amount/i);
    await waitFor(() => expect(chain.gas).toHaveBeenCalled());
    expect(screen.queryByTestId('gas-note')).not.toBeInTheDocument();
  });
});
