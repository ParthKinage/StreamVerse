import { test, expect } from '../fixtures';

test('unlocking and playback survive a chain outage and settlement completes after recovery', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount({ strm: '10' });
  await platform.deposit(acct, '5');
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  await page.goto(`/watch/${catalog.mainVideoId}`);
  platform.stack.setChainDown(true);
  await helpers.unlock(page); // payment is reserved in the database; the chain settles later
  await page.getByTestId('start-playback').click();
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
  await page.goto('/');

  await expect.poll(async () => (await platform.settlements(acct.id)).length, { timeout: 30_000 }).toBe(1);
  await new Promise((r) => setTimeout(r, 5000));
  expect((await platform.settlements(acct.id))[0]!.status).toBe('PENDING');

  platform.stack.setChainDown(false);
  await expect.poll(async () => (await platform.settlements(acct.id))[0]?.status, { timeout: 120_000 }).toBe('SETTLED');
});
