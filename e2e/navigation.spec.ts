import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Navigation', () => {
  test('N.1 — clicking logo navigates to /dashboard', async ({ authenticatedPage: page }) => {
    // Start on a non-dashboard page first
    await page.locator(SEL.sidebar.settingsLink).click();
    await page.waitForURL(/\/settings/, { timeout: 10_000 });

    // Click the logo
    await page.locator(SEL.sidebar.logo).click();

    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    expect(page.url()).toContain('/app/dashboard');
  });

  test('N.2 — clicking Tickets link navigates to /tickets', async ({ authenticatedPage: page }) => {
    await page.locator(SEL.sidebar.ticketsLink).click();

    await page.waitForURL(/\/tickets/, { timeout: 10_000 });
    expect(page.url()).toContain('/app/tickets');
  });

  test('N.3 — clicking Settings link navigates to /settings', async ({ authenticatedPage: page }) => {
    await page.locator(SEL.sidebar.settingsLink).click();

    await page.waitForURL(/\/settings/, { timeout: 10_000 });
    expect(page.url()).toContain('/app/settings');
  });

  test('N.4 — hamburger menu visible at 640px viewport width', async ({ authenticatedPage: page }) => {
    // Resize to mobile breakpoint
    await page.setViewportSize({ width: 640, height: 800 });

    // The mobile toggle button should become visible
    const hamburger = page.locator(SEL.sidebar.mobileToggle);
    await expect(hamburger).toBeVisible({ timeout: 5_000 });
  });

  test('N.5 — clicking a document in file tree navigates to it', async ({ authenticatedPage: page }) => {
    // Wait for file tree to load documents
    await expect(page.locator('text=API Specification')).toBeVisible({ timeout: 10_000 });

    // Use the file tree link for the API Specification doc
    const docLink = page.locator(SEL.fileTree.docLink(SEED.DOC_API_SPEC_ID));
    await expect(docLink).toBeVisible({ timeout: 10_000 });
    await docLink.click();

    await page.waitForURL(/\/documents\//, { timeout: 10_000 });
    expect(page.url()).toContain(`/app/documents/${SEED.DOC_API_SPEC_ID}`);
  });
});
