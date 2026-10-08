import { test, expect, parseEther } from '../fixtures';

/**
 * Live streaming from the browser. Chrome's fake camera and microphone (see playwright.config.ts) stand in for a real
 * camera or OBS Virtual Camera. The viewer buys access once (no per-second charges), the two chat, the stream keeps
 * going while the creator moves around the app, and the recording becomes a normal video when the stream ends.
 */
test('a creator goes live, a viewer buys access, they chat, and the recording is kept', async ({ page, browser, baseURL, platform, helpers }) => {
  const creator = await platform.newAccount({ strm: '1' });
  await platform.makeCreator(creator, 'Live Channel');
  await helpers.withWallet(page, creator.key);
  await helpers.login(page, creator);
  const title = platform.uniq('Live ');

  await page.goto('/studio');
  await page.getByRole('tab', { name: 'Go live' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Price to watch (STRM)').fill('5');
  await page.getByRole('button', { name: 'Set up stream' }).click();
  await page.getByTestId('live-preview').click();
  await expect(page.getByTestId('go-live')).toBeEnabled();
  await page.getByTestId('go-live').click();
  await expect(page.getByTestId('sender-status')).toContainText('You are live', { timeout: 60_000 });
  await expect(page.getByTestId('live-status')).toHaveText('Live', { timeout: 30_000 });

  // Moving to another Studio tab and another page does not stop the stream; the top bar shows it is still live.
  await page.getByRole('tab', { name: 'Videos' }).click();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByTestId('nav-live')).toBeVisible();

  // A viewer, in their own browser window, finds the stream, buys access once and watches.
  const viewerContext = await browser.newContext({ ...(baseURL ? { baseURL } : {}) });
  const viewerPage = await viewerContext.newPage();
  const viewer = await platform.newAccount({ strm: '20' });
  await platform.deposit(viewer, '10');
  await helpers.withWallet(viewerPage, viewer.key);
  await helpers.login(viewerPage, viewer);
  await viewerPage.goto('/');
  const liveNow = viewerPage.getByTestId('live-now');
  await expect(liveNow).toContainText(title, { timeout: 45_000 });
  await liveNow.getByRole('link', { name: new RegExp(title) }).first().click();
  await expect(viewerPage.getByTestId('watch-live')).toBeVisible();
  await viewerPage.getByTestId('buy-access').click();
  await expect(viewerPage.getByTestId('access-owned')).toBeVisible({ timeout: 30_000 });
  await helpers.play(viewerPage);
  await expect.poll(() => helpers.watchedSeconds(viewerPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await expect(viewerPage.getByTestId('player-live')).toBeVisible();
  // One payment for access, nothing per second (read from the payments, so a welcome bonus landing meanwhile cannot skew it).
  const payments = await platform.settlements(viewer.id);
  expect(payments.map((p) => parseEther(String(p.amountSTRM)))).toEqual([parseEther('5')]);
  expect(BigInt((await platform.summary(viewer)).unsettledChargesWei)).toBe(0n);

  // Chat both ways.
  await viewerPage.getByRole('textbox', { name: 'Message' }).fill('Hello from the audience');
  await viewerPage.getByRole('button', { name: 'Send' }).click();
  await page.getByTestId('nav-live').click();
  await expect(page.getByTestId('sender-status')).toContainText('You are live');
  await expect(page.getByTestId('chat-message').filter({ hasText: 'Hello from the audience' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Message' }).fill('Thanks for watching');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(viewerPage.getByTestId('chat-message').filter({ hasText: 'Thanks for watching' })).toBeVisible({ timeout: 15_000 });

  // The creator sees the viewer and the sale, then ends the stream.
  await expect(page.getByTestId('live-viewers')).toHaveText('1', { timeout: 30_000 });
  await expect(page.getByTestId('live-buyers')).toHaveText('1');
  await page.getByTestId('end-live').click();
  await expect(page.getByText('Past streams')).toBeVisible({ timeout: 30_000 });

  const videos = await platform.api<{ items: Array<{ title: string; live: { status: string } | null }> }>('/videos?limit=50');
  expect(videos.body.items.find((v) => v.title === title)?.live?.status).toBe('ENDED');
  await viewerContext.close();
});
