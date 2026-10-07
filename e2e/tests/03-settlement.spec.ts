import { test, expect, parseEther } from '../fixtures';

test('what a viewer watched settles on-chain with the creator fee split', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount({ strm: '20' });
  await platform.deposit(acct, '10');
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  const creatorAddr = platform.wallet(catalog.creator.key).address;
  const creatorBefore = await platform.creatorEarningsOf(creatorAddr);
  const escrowBefore = await platform.escrowOf(acct.address);

  await page.goto(`/watch/${catalog.mainVideoId}`);
  await helpers.play(page);
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(8);
  await page.goto('/wallet'); // leaving the page ends the session, which becomes one settlement

  await expect
    .poll(async () => (await platform.settlements(acct.id)).map((s) => s.status), { timeout: 90_000 })
    .toEqual(['SETTLED']);
  const [settlement] = await platform.settlements(acct.id);
  const amount = parseEther(settlement!.amountSTRM);
  expect(amount).toBeGreaterThan(0n);

  const escrowAfter = await platform.escrowOf(acct.address);
  expect(escrowBefore - escrowAfter).toBe(amount);
  const fee = (amount * 1000n) / 10_000n;
  const creatorAfter = await platform.creatorEarningsOf(creatorAddr);
  expect(creatorAfter - creatorBefore).toBe(amount - fee);

  await expect(page.getByTestId('tx-row').filter({ hasText: 'Watched: E2E main video' })).toBeVisible({ timeout: 30_000 });
});
