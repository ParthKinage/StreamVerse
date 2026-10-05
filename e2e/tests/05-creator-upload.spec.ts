import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '../fixtures';
import { makeClip } from '../stack';

test('a creator uploads, publishes and the video plays', async ({ page, platform, helpers }) => {
  const acct = await platform.newAccount({ strm: '5' });
  await platform.deposit(acct, '2');
  await helpers.withWallet(page, acct.key);
  await helpers.login(page, acct);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamverse-e2e-up-'));
  const clip = path.join(dir, 'upload.mp4');
  makeClip(clip, 20);
  const title = platform.uniq('Uploaded ');

  await page.goto('/studio');
  await page.getByLabel('Channel name').fill('Upload Channel');
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.getByLabel('Video file').setInputFiles(clip);
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Price (STRM)').fill('3');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();

  const row = page.getByTestId('studio-row').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.getByRole('button', { name: 'Publish' })).toBeEnabled({ timeout: 120_000 });
  await row.getByRole('button', { name: 'Publish' }).click();
  await expect(row.getByText('Published')).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: new RegExp(title) }).first().click();
  await page.getByTestId('start-playback').click();
  await expect.poll(() => helpers.watchedSeconds(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  fs.rmSync(dir, { recursive: true, force: true });
});
