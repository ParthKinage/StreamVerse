import { test, expect } from '../fixtures';

test('a creator claims earnings into their wallet', async ({ page, platform, catalog, helpers }) => {
  const viewer = await platform.newAccount({ strm: '8' });
  await platform.deposit(viewer, '6');
  // Generate earnings for the seeded creator: the viewer unlocks the main video.
  const bought = await platform.api(`/videos/${catalog.mainVideoId}/purchase`, { token: viewer.token, body: {} });
  expect(bought.status, JSON.stringify(bought.body)).toBe(200);

  const creatorAddr = platform.wallet(catalog.creator.key).address;
  await expect.poll(async () => await platform.creatorEarningsOf(creatorAddr), { timeout: 90_000 }).toBeGreaterThan(0n);

  await platform.fundGas(creatorAddr);
  await expect.poll(async () => BigInt((await platform.api<{ claimableWei: string }>('/creator/earnings', { token: catalog.creator.token })).body.claimableWei), { timeout: 60_000 }).toBeGreaterThan(0n);
  await helpers.withWallet(page, catalog.creator.key);
  await helpers.login(page, catalog.creator);
  await page.goto('/wallet');

  const claimable = await platform.creatorEarningsOf(creatorAddr);
  const before = await platform.strmBalance(creatorAddr);
  await page.getByRole('button', { name: 'Claim earnings' }).click();
  await expect.poll(() => platform.strmBalance(creatorAddr), { timeout: 60_000 }).toBe(before + claimable);
});
