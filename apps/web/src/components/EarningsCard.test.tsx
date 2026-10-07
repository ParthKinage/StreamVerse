import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse, CreatorEarnings } from '@tesor_gp/shared';
import { ToastProvider } from './Toasts';
import { EarningsCard } from './EarningsCard';

const E18 = 10n ** 18n;
const config = { paymentsMode: 'chain', walletMode: 'managed', feeBps: 3000, minPayoutWei: (5n * E18).toString() } as unknown as ConfigResponse;
const earningsOf = (claimable: bigint, extra: Partial<CreatorEarnings> = {}): CreatorEarnings => ({
  claimableWei: (claimable * E18).toString(),
  lifetimeEarnedWei: (70n * E18).toString(),
  pendingSettlementWei: '0',
  paidOutWei: (21n * E18).toString(),
  payoutPending: false,
  ...extra,
});

const api = vi.hoisted(() => ({ earnings: vi.fn(), payout: vi.fn() }));
vi.mock('../api/endpoints', () => ({ creatorApi: { earnings: api.earnings, payout: api.payout }, configApi: { get: vi.fn() } }));
// The linked-wallet variant talks to a browser wallet; it is not rendered here.
vi.mock('../wallet/ConnectGate', () => ({ ConnectGate: () => null }));
vi.mock('../wallet/chainActions', () => ({ routerCall: vi.fn() }));

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['config'], config);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <EarningsCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.earnings.mockReset();
  api.payout.mockReset();
});

describe('creator earnings with built-in wallets', () => {
  it('shows the split and pays out with one click, no wallet prompt', async () => {
    const u = userEvent.setup();
    api.earnings.mockResolvedValueOnce(earningsOf(49n)).mockResolvedValue(earningsOf(49n, { payoutPending: true }));
    api.payout.mockResolvedValue({ amountWei: (49n * E18).toString() });
    renderCard();
    expect((await screen.findByTestId('earnings-claimable')).textContent).toContain('49');
    expect(screen.getByTestId('earnings-paid').textContent).toContain('21');
    expect(screen.getByText(/you keep 70% of every sale/i)).toBeTruthy();

    await u.click(screen.getByTestId('payout'));
    expect(api.payout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('payout').textContent).toMatch(/on its way/i));
    expect((screen.getByTestId('payout') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the button off below the payout minimum and says why', async () => {
    api.earnings.mockResolvedValue(earningsOf(3n));
    renderCard();
    expect((await screen.findByTestId('earnings-claimable')).textContent).toContain('3');
    expect((screen.getByTestId('payout') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/payouts start at 5 STRM/i)).toBeTruthy();
  });
});
