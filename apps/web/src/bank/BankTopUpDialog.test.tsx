import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse } from '@tesor_gp/shared';
import { ApiError } from '../api/client';
import { ToastProvider } from '../components/Toasts';
import { setMoneyFormat } from '../lib/format';
import { BankTopUpDialog } from './BankTopUpDialog';

const E18 = 10n ** 18n;
const config = {
  paymentsMode: 'bank',
  currencyCode: 'INR',
  currencySymbol: '₹',
  bankAccounts: [
    { id: 'demo-savings', name: 'Demo Savings', last4: '4242', kind: 'Savings' },
    { id: 'demo-declined', name: 'Always Declines', last4: '0002', kind: 'Current' },
  ],
  minTopUpWei: (10n * E18).toString(),
  maxTopUpWei: (50000n * E18).toString(),
} as unknown as ConfigResponse;

const api = vi.hoisted(() => ({ topUp: vi.fn() }));
vi.mock('../api/endpoints', () => ({ bankApi: { topUp: api.topUp }, configApi: { get: vi.fn() } }));

function renderDialog(onDone = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['config'], config);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BankTopUpDialog onClose={vi.fn()} onDone={onDone} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.topUp.mockReset();
  setMoneyFormat({ mode: 'bank', symbol: '₹', code: 'INR' });
});
afterEach(() => setMoneyFormat({ mode: 'chain', symbol: '', code: 'STRM' }));

describe('bank top-up dialog', () => {
  it('rejects amounts below the minimum without calling the API', async () => {
    const u = userEvent.setup();
    renderDialog();
    const input = await screen.findByLabelText(/amount/i);
    await u.clear(input);
    await u.type(input, '5');
    await u.click(screen.getByTestId('bank-submit'));
    expect(await screen.findByText('Minimum is ₹10.00')).toBeInTheDocument();
    expect(api.topUp).not.toHaveBeenCalled();
  });

  it('adds money from the chosen account and confirms', async () => {
    api.topUp.mockResolvedValue({ summary: {} });
    const onDone = vi.fn();
    const u = userEvent.setup();
    renderDialog(onDone);
    await u.click(await screen.findByTestId('bank-submit'));
    expect(await screen.findByTestId('topup-confirmed')).toHaveTextContent('₹500.00 was added');
    expect(api.topUp).toHaveBeenCalledWith('demo-savings', (500n * E18).toString());
    expect(onDone).toHaveBeenCalled();
  });

  it('shows the bank decline message', async () => {
    api.topUp.mockRejectedValue(new ApiError(402, 'BANK_DECLINED', 'Your bank declined this payment'));
    const u = userEvent.setup();
    renderDialog();
    await u.selectOptions(await screen.findByTestId('bank-account'), 'demo-declined');
    await u.click(screen.getByTestId('bank-submit'));
    expect(await screen.findByTestId('bank-error')).toHaveTextContent('declined');
  });
});
