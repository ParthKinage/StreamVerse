import { test, expect } from '../fixtures';

test('a Redis restart keeps users signed in and playback recovers', async ({ page, platform, catalog, helpers }) => {
  const acct = await platform.newAccount({ strm: '10' });
  await platform.deposit(acct, '5');
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  await page.goto(`/watch/${catalog.mainVideoId}`);
  await helpers.play(page);
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);

  await platform.stack.restartRedis();

  await page.reload();
  await expect(page.getByRole('link', { name: acct.username })).toBeVisible();
  await page.getByTestId('start-playback').or(page.getByRole('button', { name: 'Resume' })).first().click();
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
  await page.goto('/');

  await expect.poll(async () => (await platform.settlements(acct.id)).map((s) => s.status).sort(), { timeout: 120_000 }).toEqual(expect.arrayContaining(['SETTLED']));
});
