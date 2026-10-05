import { test, expect, parseEther } from '../fixtures';

test('a video cannot be unlocked without enough funds, and can after a top-up', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount({ strm: '20' });
  // New accounts get a welcome bonus; park everything except 2 STRM in a withdrawal so the premium video (8 STRM) is out of reach.
  await expect.poll(async () => BigInt((await platform.summary(acct)).escrowWei), { timeout: 60_000 }).toBeGreaterThan(0n);
  const escrow = BigInt((await platform.summary(acct)).escrowWei);
  await (await platform.router(platform.wallet(acct.key)).getFunction('requestWithdraw')(escrow - parseEther('2'))).wait();
  await expect.poll(async () => BigInt((await platform.summary(acct)).availableWei), { timeout: 30_000 }).toBe(parseEther('2'));
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  await page.goto(`/watch/${catalog.priceyVideoId}`);
  await expect(page.getByTestId('unlock-video')).toHaveCount(0);
  await page.getByTestId('add-money-watch').click();
  await page.getByLabel('Amount (STRM)').fill('10');
  await page.getByRole('button', { name: 'Deposit' }).click();
  await expect(page.getByTestId('topup-confirmed')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Done' }).click();

  await helpers.unlock(page);
  await page.getByTestId('start-playback').click();
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 30_000 }).toBeGreaterThan(0);
});
