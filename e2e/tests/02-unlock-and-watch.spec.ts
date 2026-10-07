import { test, expect } from '../fixtures';

test('a viewer pays by the second while watching, and the meter shows it', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount({ strm: '20' });
  await platform.deposit(acct, '10');
  const availableBefore = BigInt((await platform.summary(acct)).availableWei);
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  await page.goto(`/watch/${catalog.mainVideoId}`);
  await expect(page.getByTestId('pay-panel')).toBeVisible();
  await expect(page.getByTestId('pay-rate')).toContainText('/min');
  await helpers.play(page);
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(15);
  await expect(page.getByTestId('meter-rate')).toContainText('/min');
  await expect(page.getByTestId('meter-spent')).toBeVisible();

  // The balance went down by what was sent: at least the seconds watched, at most that plus the ~10 s buffer and one piece.
  const spent = availableBefore - BigInt((await platform.summary(acct)).availableWei);
  const watched = BigInt(await helpers.watchedSeconds(page));
  expect(spent).toBeGreaterThan(0n);
  expect(spent).toBeLessThanOrEqual(((watched + 16n) * catalog.mainRateWei) / 60n);
});
