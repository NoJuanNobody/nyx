import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

// Seeded GitHub integration id used across mocks
const SEEDED_GITHUB_INTEGRATION_ID = 'integration-github-seed';

test.describe('Repositories', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    // #381: The Repositories page now fetches integrations first, then fetches
    // synced-repos per integration id (not via a github-specific path).

    // Mock the integrations list so the page discovers the GitHub integration
    await page.route('**/api/integrations', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: SEEDED_GITHUB_INTEGRATION_ID,
            type: 'github',
            config: { githubUsername: 'nyx-bot' },
            createdAt: '2025-01-01T00:00:00Z',
          },
        ]),
      });
    });

    // Mock synced-repos for the integration — path is now provider-agnostic
    await page.route(`**/api/integrations/${SEEDED_GITHUB_INTEGRATION_ID}/synced-repos`, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          webhookRegistrationEnabled: true,
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

    await page.goto('/app/repositories');
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

  test('237.1 — Manage Repos button is visible', async ({ authenticatedPage: page }) => {
    // #381: The button text is now provider-specific, e.g. "Manage GitHub Repos"
    const manageButton = page.locator(SEL.repositories.manageReposButton);
    await expect(manageButton).toBeVisible({ timeout: 5_000 });
    await expect(manageButton).toHaveText('Manage GitHub Repos');
  });

  test('237.2 — Manage Repos button opens repo picker modal', async ({ authenticatedPage: page }) => {
    // Mock the repos endpoint that the RepoPickerModal fetches
    await page.route(`**/api/integrations/${SEEDED_GITHUB_INTEGRATION_ID}/repos`, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repos: [
            { id: 1, full_name: 'nyx/app', private: false, default_branch: 'main' },
            { id: 2, full_name: 'nyx/docs', private: true, default_branch: 'main' },
          ],
        }),
      });
    });

    const manageButton = page.locator(SEL.repositories.manageReposButton);
    await manageButton.click();

    // The RepoPickerModal should be visible with its header
    const modal = page.locator('.fixed.inset-0');
    await expect(modal.locator('h2:has-text("Select Repositories")')).toBeVisible({ timeout: 5_000 });
    // Should list the repos inside the modal
    await expect(modal.locator('text=nyx/app')).toBeVisible({ timeout: 5_000 });
  });
});
