import { test, expect, parseEther } from '../fixtures';

/**
 * Runs only with E2E_WALLET_MODE=managed. Nobody in this scenario has a browser wallet or any gas: the platform gives
 * each account a wallet, sells coins, moves the payment on-chain and pays the creator out.
 */
test('built-in wallets: sign up, buy coins, unlock a video and pay the creator, all without a browser wallet', async ({ page, platform, catalog, helpers }) => {
  const username = platform.uniq('walletless');
  await page.goto('/register');
  await page.getByLabel('Email').fill(`${username}@e2e.test`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('Passw0rd!123');
  await page.getByRole('button', { name: 'Sign up' }).click();

  // The wallet already exists: an address is shown and there is nothing to connect or link.
  await expect(page).toHaveURL(/\/wallet/);
  const addressEl = page.getByTestId('wallet-address');
  await expect(addressEl).toHaveText(/^0x[0-9a-f]{40}$/);
  const viewerAddress = (await addressEl.textContent()) as string;
  await expect(page.getByRole('button', { name: /link wallet|connect wallet/i })).toHaveCount(0);
  await expect(page.getByText(/metamask/i)).toHaveCount(0);

  // Welcome bonus, credited on-chain by the relayer.
  await expect(page.getByTestId('nav-balance')).toContainText('50', { timeout: 60_000 });
  expect(await platform.escrowOf(viewerAddress)).toBe(parseEther('50'));
  expect(await platform.provider.getBalance(viewerAddress)).toBe(0n);

  // Buy 100 coins with the demo bank.
  await page.getByTestId('buy-coins').click();
  await page.getByLabel('Coins to buy (STRM)').fill('100');
  await page.getByTestId('coin-submit').click();
  await expect(page.getByTestId('coins-confirmed')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('managed-available')).toContainText('150');
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Bought with' })).toContainText('Confirmed');
  expect(await platform.escrowOf(viewerAddress)).toBe(parseEther('150'));

  // Unlock a 5 STRM video. Access is immediate; the payment settles on-chain shortly after.
  await page.goto(`/watch/${catalog.mainVideoId}`);
  await helpers.unlock(page);
  const creatorAddress = catalog.creator.address;
  await expect.poll(() => platform.escrowOf(viewerAddress), { timeout: 90_000 }).toBe(parseEther('145'));
  // The test chain takes a 10% commission: the creator is owed 4.5 of the 5 STRM.
  await expect.poll(() => platform.creatorEarningsOf(creatorAddress), { timeout: 30_000 }).toBe(parseEther('4.5'));

  // The creator signs in and gets paid with one click.
  await page.getByRole('button', { name: 'Log out' }).click();
  await helpers.login(page, catalog.creator);
  await page.goto('/wallet');
  await expect(page.getByTestId('earnings-claimable')).toContainText('4.5', { timeout: 60_000 });
  const before = await platform.strmBalance(creatorAddress);
  await page.getByTestId('payout').click();
  await expect.poll(() => platform.strmBalance(creatorAddress), { timeout: 60_000 }).toBe(before + parseEther('4.5'));
  await expect(page.getByTestId('earnings-paid')).toContainText('4.5', { timeout: 60_000 });
  expect(await platform.creatorEarningsOf(creatorAddress)).toBe(0n);
  expect(await platform.provider.getBalance(creatorAddress)).toBe(0n);
});
