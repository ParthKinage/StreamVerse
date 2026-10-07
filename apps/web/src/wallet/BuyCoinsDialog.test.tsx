import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse, WalletSummary } from '@tesor_gp/shared';
import { ApiError } from '../api/client';
import { ToastProvider } from '../components/Toasts';
import { BuyCoinsDialog } from './BuyCoinsDialog';

const E18 = 10n ** 18n;
const config = {
  paymentsMode: 'chain',
  walletMode: 'managed',
  fiatSymbol: '₹',
  currencyCode: 'STRM',
  currencySymbol: '',
  bankAccounts: [
    { id: 'demo-savings', name: 'Demo Savings', last4: '4242', kind: 'Savings' },
    { id: 'demo-declined', name: 'Always Declines', last4: '0002', kind: 'Current' },
  ],
  minTopUpWei: (10n * E18).toString(),
  maxTopUpWei: (50000n * E18).toString(),
} as unknown as ConfigResponse;

const summaryOf = (available: bigint, arriving: bigint): WalletSummary => ({
  walletAddress: '0x' + 'a'.repeat(40),
  escrowWei: (available * E18).toString(),
  pendingWithdrawalWei: '0',
  withdrawUnlockAt: null,
  unsettledChargesWei: '0',
  availableWei: (available * E18).toString(),
  creatorEarningsWei: '0',
  arrivingWei: (arriving * E18).toString(),
});

const api = vi.hoisted(() => ({ buyCoins: vi.fn(), summary: vi.fn() }));
vi.mock('../api/endpoints', () => ({ walletApi: { buyCoins: api.buyCoins, summary: api.summary }, configApi: { get: vi.fn() } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

function renderDialog(onDone = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['config'], config);
  qc.setQueryData(['wallet', 'summary'], summaryOf(50n, 0n));
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BuyCoinsDialog onClose={vi.fn()} onDone={onDone} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc, onDone };
}

beforeEach(() => {
  api.buyCoins.mockReset();
  api.summary.mockReset().mockResolvedValue(summaryOf(50n, 0n));
});

describe('buy coins dialog', () => {
  it('rejects amounts outside the limits without calling the API', async () => {
    const u = userEvent.setup();
    renderDialog();
    const input = await screen.findByLabelText(/coins to buy/i);
    await u.clear(input);
    await u.type(input, '5');
    await u.click(screen.getByTestId('coin-submit'));
    expect(await screen.findByText(/minimum is 10 STRM/i)).toBeTruthy();
    expect(api.buyCoins).not.toHaveBeenCalled();
  });

  it('shows the price in the buyer currency and says no real money is charged', async () => {
    renderDialog();
    expect(await screen.findByText(/no real money is charged/i)).toBeTruthy();
    expect(screen.getByTestId('coin-submit').textContent).toBe('Pay ₹500');
  });

  it('waits for the blockchain, then confirms the coins and tells the page', async () => {
    const u = userEvent.setup();
    api.buyCoins.mockResolvedValue({ orderId: 'o1', amountWei: (200n * E18).toString(), summary: summaryOf(50n, 200n) });
    // First poll: still on its way. Second poll: confirmed.
    api.summary.mockResolvedValueOnce(summaryOf(50n, 200n)).mockResolvedValue(summaryOf(250n, 0n));
    const { onDone } = renderDialog();
    const input = await screen.findByLabelText(/coins to buy/i);
    await u.clear(input);
    await u.type(input, '200');
    await u.click(screen.getByTestId('coin-submit'));

    expect(api.buyCoins).toHaveBeenCalledWith('demo-savings', (200n * E18).toString());
    expect((await screen.findByTestId('coins-arriving')).textContent).toMatch(/adding 200 STRM/i);
    expect(onDone).not.toHaveBeenCalled();
    expect((await screen.findByTestId('coins-confirmed', {}, { timeout: 5000 })).textContent).toMatch(/200 STRM is now in your wallet/);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the bank message when the payment is declined and stays on the form', async () => {
    const u = userEvent.setup();
    api.buyCoins.mockRejectedValue(new ApiError(402, 'BANK_DECLINED', 'The bank declined this payment'));
    const { onDone } = renderDialog();
    await u.selectOptions(await screen.findByTestId('coin-account'), 'demo-declined');
    await u.click(screen.getByTestId('coin-submit'));
    expect((await screen.findByTestId('coin-error')).textContent).toMatch(/declined/i);
    expect(screen.queryByTestId('coins-arriving')).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });
});
