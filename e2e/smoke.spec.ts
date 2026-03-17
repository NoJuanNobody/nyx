import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Smoke Tests', () => {
  // 1. App boots and renders dashboard
  test('app boots and renders dashboard', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.title)).toBeVisible();
    await expect(page.locator(SEL.sidebar.logo)).toBeVisible();
  });

  // 2. Auth endpoint responds (user info visible in sidebar)
  test('auth resolves and shows user info', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.sidebar.userName)).toHaveText('Dev User');
  });

  // 3. Document list loads
  test('document list loads in sidebar', async ({ authenticatedPage: page }) => {
    // The file tree should show seeded documents
    await expect(page.locator(SEL.fileTree.docLink(SEED.DOC_API_SPEC_ID))).toBeVisible();
  });

  // 4. Can navigate to a document
  test('can navigate to a document', async ({ authenticatedPage: page }) => {
    await page.click(SEL.fileTree.docLink(SEED.DOC_API_SPEC_ID));
    await expect(page.locator('h1:has-text("API Specification")')).toBeVisible({ timeout: 10_000 });
  });

  // 5. Navigation between main routes works
  test('navigation to board page works', async ({ authenticatedPage: page }) => {
    await page.click(SEL.sidebar.boardLink);
    await expect(page).toHaveURL(/\/board/);
  });

  // 6. Navigation to settings works
  test('navigation to settings page works', async ({ authenticatedPage: page }) => {
    await page.click(SEL.sidebar.settingsLink);
    await expect(page).toHaveURL(/\/settings/);
  });

  // 7. Theme toggle works (no crash)
  test('theme toggle does not crash', async ({ authenticatedPage: page }) => {
    await page.click(SEL.sidebar.themeToggle);
    // Just verify the page is still functional after toggle
    await expect(page.locator(SEL.sidebar.logo)).toBeVisible();
  });

  // 8. Team switcher loads teams
  test('team switcher loads teams', async ({ authenticatedPage: page }) => {
    const teamSelect = page.locator(SEL.sidebar.teamSwitcher);
    await expect(teamSelect).toBeVisible();
    // Should have at least 2 options (Default Team, Second Team)
    const options = teamSelect.locator('option');
    await expect(options).toHaveCount(2);
  });
});
