import { test, expect } from '../fixtures';

test('home recommendations fall back when the AI service is down', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount();
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);
  await platform.stack.stopAi();
  try {
    const rec = await platform.api<{ source: string; items: unknown[] }>('/recommendations', { token: acct.token });
    expect(rec.status).toBe(200);
    expect(rec.body.source).toBe('fallback');
    expect(rec.body.items.length).toBeGreaterThan(0);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Pay only for what you watch' })).toBeVisible();
    await expect(page.getByText('E2E main video').first()).toBeVisible();
  } finally {
    await platform.stack.startAi();
  }
  expect(catalog.mainVideoId).toBeTruthy();
});
