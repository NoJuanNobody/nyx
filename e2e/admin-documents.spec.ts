import { test, expect, SEED } from './fixtures/test-base';

const ADMIN_DOCS_RESPONSE = {
  documents: [
    {
      id: SEED.DOC_API_SPEC_ID,
      title: 'API Specification',
      status: 'draft',
      stage: null,
      path: '/api',
      teamId: SEED.DEFAULT_TEAM_ID,
      teamName: 'Default Team',
      createdById: SEED.DEV_USER_ID,
      createdByName: 'Dev User',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: SEED.DOC_SECOND_TEAM_ID,
      title: 'Second Team Doc',
      status: 'published',
      stage: null,
      path: '/',
      teamId: SEED.SECOND_TEAM_ID,
      teamName: 'Second Team',
      createdById: SEED.DEV_USER_ID,
      createdByName: 'Dev User',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ],
  teams: [
    { teamId: SEED.DEFAULT_TEAM_ID, role: 'owner', teamName: 'Default Team' },
    { teamId: SEED.SECOND_TEAM_ID, role: 'owner', teamName: 'Second Team' },
  ],
};

test.describe('Admin Documents', () => {
  test('admin sees "All Documents" link in sidebar', async ({ authenticatedPage: page }) => {
    // Default seeded user has owner role on both teams — link should be visible
    const adminLink = page.locator('[data-testid="admin-documents-link"]');
    await expect(adminLink).toBeVisible({ timeout: 10_000 });
  });

  test('admin can navigate to /admin/documents and see cross-team docs', async ({ authenticatedPage: page }) => {
    // Mock the admin documents endpoint
    await page.route('**/api/admin/documents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ADMIN_DOCS_RESPONSE),
      }),
    );

    await page.goto('/admin/documents');

    // Page heading should be visible
    await expect(page.locator('h1:has-text("All Documents")')).toBeVisible({ timeout: 10_000 });

    // Both documents should appear in the table
    await expect(page.locator('[data-testid="admin-docs-table"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=API Specification')).toBeVisible();
    await expect(page.locator('text=Second Team Doc')).toBeVisible();

    // Team badges should show both teams (scoped to table to avoid hidden <option> matches)
    const table = page.locator('[data-testid="admin-docs-table"]');
    await expect(table.locator('text=Default Team').first()).toBeVisible();
    await expect(table.locator('text=Second Team').first()).toBeVisible();
  });

  test('admin can filter documents by team', async ({ authenticatedPage: page }) => {
    await page.route('**/api/admin/documents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ADMIN_DOCS_RESPONSE),
      }),
    );

    await page.goto('/admin/documents');
    await expect(page.locator('[data-testid="admin-docs-table"]')).toBeVisible({ timeout: 10_000 });

    // Filter to Second Team only
    await page.selectOption('select[aria-label="Filter by team"]', SEED.SECOND_TEAM_ID);

    // Only Second Team Doc should remain
    await expect(page.locator('text=Second Team Doc')).toBeVisible();
    await expect(page.locator('text=API Specification')).toBeHidden();
  });

  test('admin can search documents by title', async ({ authenticatedPage: page }) => {
    await page.route('**/api/admin/documents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ADMIN_DOCS_RESPONSE),
      }),
    );

    await page.goto('/admin/documents');
    await expect(page.locator('[data-testid="admin-docs-table"]')).toBeVisible({ timeout: 10_000 });

    // Search for "Second"
    await page.fill('[data-testid="admin-docs-search"]', 'Second');

    await expect(page.locator('text=Second Team Doc')).toBeVisible();
    await expect(page.locator('text=API Specification')).toBeHidden();
  });

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
