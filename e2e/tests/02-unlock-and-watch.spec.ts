import { test, expect } from '../fixtures';

test('a video is paid for once to unlock it, and watching costs nothing more', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount({ strm: '20' });
  await platform.deposit(acct, '10');
  const availableBefore = BigInt((await platform.summary(acct)).availableWei);
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  await page.goto(`/watch/${catalog.mainVideoId}`);
  await expect(page.getByTestId('unlock-panel')).toBeVisible();
  await expect(page.getByTestId('start-playback')).toHaveCount(0); // locked until bought
  await helpers.unlock(page);

  await expect.poll(async () => BigInt((await platform.summary(acct)).availableWei), { timeout: 30_000 }).toBe(availableBefore - catalog.mainPriceWei);
  const afterUnlock = BigInt((await platform.summary(acct)).availableWei);

  await page.getByTestId('start-playback').click();
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(15);
  await expect(page.getByTestId('meter-access')).toContainText('Until');
  // Watching is free once unlocked: the balance has not moved.
  expect(BigInt((await platform.summary(acct)).availableWei)).toBe(afterUnlock);
});
