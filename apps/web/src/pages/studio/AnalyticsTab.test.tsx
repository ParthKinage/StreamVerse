import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreatorAnalytics } from '@tesor_gp/shared';
import { AnalyticsTab, fillDays, watchTime } from './AnalyticsTab';

const E18 = 10n ** 18n;
const today = new Date().toISOString().slice(0, 10);
const data: CreatorAnalytics = {
  totalViews: 12,
  totalWatchSeconds: 3_900,
  totalEarningsWei: (40n * E18).toString(),
  videos: [
    { videoId: 'a', title: 'Alpha', views: 2, watchSeconds: 600, earningsWei: (10n * E18).toString() },
    { videoId: 'b', title: 'Bravo', views: 10, watchSeconds: 3_300, earningsWei: (30n * E18).toString() },
  ],
  daily: [{ date: today, views: 3, watchSeconds: 420, earningsWei: (5n * E18).toString() }],
};

const api = vi.hoisted(() => ({ analytics: vi.fn() }));
vi.mock('../../api/endpoints', () => ({ creatorApi: { analytics: api.analytics } }));

function renderTab() {
  api.analytics.mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AnalyticsTab />
    </QueryClientProvider>,
  );
}

describe('creator analytics', () => {
  it('formats watch time and fills the last 30 days with zeros', () => {
    expect(watchTime(45)).toBe('45 s');
    expect(watchTime(720)).toBe('12 min');
    expect(watchTime(7_500)).toBe('2 h 05 min');
    const days = fillDays([{ date: '2026-10-10', views: 1, watchSeconds: 60, earningsWei: '1' }], 30, new Date('2026-10-15T12:00:00Z'));
    expect(days).toHaveLength(30);
    expect(days[29]?.date).toBe('2026-10-15');
    expect(days.find((d) => d.date === '2026-10-10')?.views).toBe(1);
    expect(days.filter((d) => d.views === 0)).toHaveLength(29);
  });

  it('shows the headline numbers, the top video and each video’s share of earnings', async () => {
    renderTab();
    expect(await screen.findByText('Top video')).toBeTruthy();
    expect(screen.getByText('1 h 05 min')).toBeTruthy(); // total watch time
    expect(within(screen.getByText('Average per view').parentElement as HTMLElement).getByText('5 min')).toBeTruthy(); // 3900 s over 12 views
    const top = screen.getByText('Top video').parentElement as HTMLElement;
    expect(within(top).getByText('Bravo')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
  });

  it('sorts the table and switches the chart between measures', async () => {
    const u = userEvent.setup();
    renderTab();
    await screen.findByText('By video');
    const firstVideo = (): string => (screen.getAllByRole('row')[1]?.querySelector('td')?.textContent ?? '');
    expect(firstVideo()).toBe('Bravo'); // most earnings first
    await u.click(screen.getByRole('button', { name: /^Video/ }));
    expect(firstVideo()).toBe('Alpha'); // A to Z
    const measure = within(screen.getByRole('group', { name: 'Measure' }));
    await u.click(measure.getByRole('button', { name: 'Views' }));
    expect(measure.getByRole('button', { name: 'Views' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { name: /3 views$/ })).toHaveLength(1); // today's bar
  });
});
