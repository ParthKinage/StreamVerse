import { test, expect, parseEther } from '../fixtures';

test('a new user registers, links a wallet and receives the welcome bonus', async ({ page, platform, helpers }) => {
  const key = platform.stack.accountKey(platform.nextAccountIndex());
  await helpers.withWallet(page, key);
  const username = platform.uniq('newbie');

  await page.goto('/register');
  await page.getByLabel('Email').fill(`${username}@e2e.test`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('Passw0rd!123');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect(page).toHaveURL(/\/wallet/);
  await page.getByRole('button', { name: 'Link wallet' }).click();

  // The welcome bonus is credited on-chain by the relayer and picked up by the indexer.
  await expect(page.getByTestId('nav-balance')).toContainText('50', { timeout: 60_000 });
  await expect(page.getByTestId('tx-row').filter({ hasText: 'Welcome bonus' })).toBeVisible({ timeout: 30_000 });

  const address = platform.wallet(key).address;
  expect(await platform.escrowOf(address)).toBe(parseEther('50'));
});
