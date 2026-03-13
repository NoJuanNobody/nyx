import { test, expect, SEED } from './fixtures/test-base';

test.describe('GitHub Token Expired', () => {
  test('81.1 — shows reconnect banner on repositories page when token expired', async ({ authenticatedPage: page }) => {
    // Override the synced-repos endpoint to return 401 with github_token_expired
    await page.route('**/api/integrations/*/github/synced-repos', (route) => {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github_token_expired',
          message: 'GitHub token expired or revoked. Please reconnect your GitHub integration.',
        }),
      });
    });

    await page.goto('/repositories');
    await expect(page.locator('h1:has-text("Repositories")')).toBeVisible({ timeout: 10_000 });

    // Should show the reconnect banner
    await expect(page.locator('text=GitHub connection expired')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button:has-text("Reconnect GitHub")')).toBeVisible({ timeout: 5_000 });
  });

  test('81.2 — reconnect button links to GitHub OAuth flow', async ({ authenticatedPage: page }) => {
    await page.route('**/api/integrations/*/github/synced-repos', (route) => {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'github_token_expired',
          message: 'GitHub token expired or revoked.',
        }),
      });
    });

    await page.goto('/repositories');
    await expect(page.locator('text=GitHub connection expired')).toBeVisible({ timeout: 10_000 });

    // The reconnect button should exist
    const reconnectButton = page.locator('button:has-text("Reconnect GitHub")');
    await expect(reconnectButton).toBeVisible({ timeout: 5_000 });
  });
});
