import { test, expect } from '../fixtures';

test('stack starts and the catalog is seeded', async ({ page, catalog, platform }) => {
  const list = await platform.api<{ items: Array<{ title: string }> }>('/videos');
  expect(list.body.items.map((v) => v.title).sort()).toEqual(['E2E main video', 'E2E premium video']);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pay only for what you watch' })).toBeVisible();
  expect(catalog.mainVideoId).toBeTruthy();
});
