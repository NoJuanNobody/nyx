import { test, expect, SEED } from './fixtures/test-base';

test.describe('Admin Documents', () => {
  // The "All Documents" admin page and sidebar link were removed in #241
  // (consolidated into the Operations page). These tests verified the
  // removed feature and are no longer applicable.

  test('non-admin user does not see "All Documents" link', async ({ authenticatedPage: page }) => {
    // Override to viewer role (no admin teams)
    await page.route('**/api/teams**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (/\/teams$/.test(pathname)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: SEED.DEFAULT_TEAM_ID, name: 'Default Team', slug: 'default', role: 'viewer' },
          ]),
        });
      }
      return route.fallback();
    });

    await page.reload();
    await page.locator('a:has-text("Nyx")').waitFor({ state: 'visible', timeout: 15_000 });

    const adminLink = page.locator('[data-testid="admin-documents-link"]');
    await expect(adminLink).toBeHidden();
  });
});
