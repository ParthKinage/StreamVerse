import { test, expect } from '../fixtures';

/**
 * Live streaming from the browser. Chrome's fake camera and microphone (see playwright.config.ts) stand in for a real
 * camera or OBS Virtual Camera: the Studio encodes them into 4-second pieces, the viewer's player plays the stream and
 * pays per second, and the recording becomes a normal video when the creator ends the stream.
 */
test('a creator goes live from the browser, a viewer watches and pays, and the recording is kept', async ({ page, browser, baseURL, platform, helpers }) => {
  const creator = await platform.newAccount({ strm: '1' });
  await platform.makeCreator(creator, 'Live Channel');
  await helpers.withWallet(page, creator.key);
  await helpers.login(page, creator);
  const title = platform.uniq('Live ');

  await page.goto('/studio');
  await page.getByRole('tab', { name: 'Go live' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Rate per minute (STRM)').fill('3');
  await page.getByRole('button', { name: 'Set up stream' }).click();
  await page.getByTestId('live-preview').click();
  await expect(page.getByTestId('go-live')).toBeEnabled();
  await page.getByTestId('go-live').click();
  await expect(page.getByTestId('sender-status')).toContainText('You are live', { timeout: 60_000 });
  await expect(page.getByTestId('live-status')).toHaveText('Live', { timeout: 30_000 });

  // A viewer, in their own browser window, finds the stream on the home page and watches it.
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
  await helpers.play(viewerPage);
  await expect.poll(() => helpers.watchedSeconds(viewerPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await expect(viewerPage.getByTestId('player-live')).toBeVisible();
  expect(BigInt((await platform.summary(viewer)).unsettledChargesWei)).toBeGreaterThan(0n);

  // The creator sees the viewer, then ends the stream.
  await expect(page.getByTestId('live-viewers')).toHaveText('1', { timeout: 30_000 });
  await page.getByTestId('end-live').click();
  await expect(page.getByText('Past streams')).toBeVisible({ timeout: 30_000 });

  const videos = await platform.api<{ items: Array<{ title: string; live: { status: string } | null }> }>('/videos?limit=50');
  expect(videos.body.items.find((v) => v.title === title)?.live?.status).toBe('ENDED');
  await viewerContext.close();
});
