import { test, expect, parseEther } from '../fixtures';

// Runs last: it moves the chain clock forward, which persists for the rest of the worker.
test('withdrawal is requested, time-locked and then executed', async ({ page, platform, helpers }) => {
  const acct = await platform.newAccount({ strm: '10' });
  await platform.deposit(acct, '4');
  await platform.fundGas(acct.address);
  await page.clock.install();
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  await page.goto('/wallet');
  await page.getByLabel('Amount (STRM)').fill('3');
  await page.getByRole('button', { name: 'Request withdrawal' }).click();
  await expect(page.getByTestId('withdraw-pending')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('withdraw-countdown')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw now' })).toBeDisabled();

  // Chain timestamps can run ahead of wall time (Hardhat never reuses a timestamp), so aim the browser clock at the unlock time the API reports.
  const { withdrawUnlockAt } = await platform.summary(acct);
  await platform.provider.send('evm_increaseTime', [901]);
  await platform.provider.send('evm_mine', []);
  await page.clock.fastForward(Math.max(1_000, new Date(withdrawUnlockAt!).getTime() - Date.now() + 2_000));
  await expect(page.getByRole('button', { name: 'Withdraw now' })).toBeEnabled({ timeout: 30_000 });

  const before = await platform.strmBalance(acct.address);
  await page.getByRole('button', { name: 'Withdraw now' }).click();
  await expect.poll(() => platform.strmBalance(acct.address), { timeout: 60_000 }).toBe(before + parseEther('3'));
  await expect(page.getByTestId('withdraw-pending')).toBeHidden({ timeout: 60_000 });
});
