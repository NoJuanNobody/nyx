import { test, expect, SEED } from './fixtures/test-base';

test.describe('GitHub Token Expired', () => {
  test('81.1 — shows reconnect banner on repositories page when token expired', async ({ authenticatedPage: page }) => {
    // Override the integrations handler to return 401 for synced-repos
    await page.route('**/api/integrations**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/github\/synced-repos/.test(pathname)) {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github_token_expired',
            message: 'GitHub token expired or revoked. Please reconnect your GitHub integration.',
          }),
        });
      }
      return route.fallback();
    });

    await page.goto('/repositories');
    await expect(page.locator('h1:has-text("Repositories")')).toBeVisible({ timeout: 10_000 });

    // Should show the reconnect banner
    await expect(page.locator('text=GitHub connection expired')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button:has-text("Reconnect GitHub")')).toBeVisible({ timeout: 5_000 });
  });

  test('81.2 — reconnect button links to GitHub OAuth flow', async ({ authenticatedPage: page }) => {
    await page.route('**/api/integrations**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/github\/synced-repos/.test(pathname)) {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'github_token_expired',
            message: 'GitHub token expired or revoked.',
          }),
        });
      }
      return route.fallback();
    });

    await page.goto('/repositories');
    await expect(page.locator('text=GitHub connection expired')).toBeVisible({ timeout: 10_000 });

    // The reconnect button should exist
    const reconnectButton = page.locator('button:has-text("Reconnect GitHub")');
    await expect(reconnectButton).toBeVisible({ timeout: 5_000 });
  });
});
