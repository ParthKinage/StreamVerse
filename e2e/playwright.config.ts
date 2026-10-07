import { defineConfig } from '@playwright/test';

/**
 * One worker: the scenarios share one stack (chain, database, services). The stack is started once by the
 * worker-scoped fixture in fixtures.ts and torn down when the worker exits.
 *
 * Browser selection:
 *  - default: Playwright's Chromium
 *  - E2E_BROWSER_CHANNEL=chrome: system Google Chrome (has H.264, needed for real HLS playback)
 *  - PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome: any Chromium binary
 *  - E2E_FAKE_MEDIA=1: replace the media element with a clock when the browser cannot decode H.264 (see README)
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const channel = process.env.E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  // On CI also report each failure as a GitHub annotation, so the reason is visible on the pull request.
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(channel ? { channel } : {}),
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--autoplay-policy=no-user-gesture-required'] },
  },
});
