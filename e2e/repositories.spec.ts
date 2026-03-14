import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Repositories', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    // Add mock for synced-repos endpoint
    await page.route('**/api/integrations/*/github/synced-repos', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repos: [
            {
              owner: 'nyx',
              name: 'app',
              fullName: 'nyx/app',
              syncStatus: 'active',
              webhookId: 12345,
              lastPushAt: '2025-01-15T10:30:00Z',
              linkedDocCount: 2,
            },
            {
              owner: 'nyx',
              name: 'docs',
              fullName: 'nyx/docs',
              syncStatus: 'disconnected',
              webhookId: null,
              lastPushAt: null,
              linkedDocCount: 0,
            },
          ],
        }),
      });
    });

    await page.goto('/repositories');
    await expect(page.locator('h1:has-text("Repositories")')).toBeVisible({ timeout: 10_000 });
  });

  test('77.1 — page shows synced repositories', async ({ authenticatedPage: page }) => {
    await expect(page.locator('text=nyx/app')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=nyx/docs')).toBeVisible({ timeout: 5_000 });
  });

  test('77.2 — shows sync status badges', async ({ authenticatedPage: page }) => {
    await expect(page.locator('text=Active').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Disconnected').first()).toBeVisible({ timeout: 5_000 });
  });

  test('77.3 — shows linked document count', async ({ authenticatedPage: page }) => {
    await expect(page.locator('text=2 docs')).toBeVisible({ timeout: 5_000 });
  });

  test('77.4 — Remove button visible for each repo', async ({ authenticatedPage: page }) => {
    const removeButtons = page.locator('button:has-text("Remove")');
    await expect(removeButtons.first()).toBeVisible({ timeout: 5_000 });
    expect(await removeButtons.count()).toBe(2);
  });

  test('77.5 — Remove shows confirmation', async ({ authenticatedPage: page }) => {
    const removeButton = page.locator('button:has-text("Remove")').first();
    await removeButton.click();
    // Should show Yes/No confirmation
    await expect(page.locator('button:has-text("Yes")')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button:has-text("No")')).toBeVisible({ timeout: 5_000 });
  });

  test('77.6 — repo name links to GitHub', async ({ authenticatedPage: page }) => {
    const repoLink = page.locator('a[href="https://github.com/nyx/app"]');
    await expect(repoLink).toBeVisible({ timeout: 5_000 });
  });
});
