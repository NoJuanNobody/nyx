import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Authentication & Dev Bypass', () => {
  test('1.1 — landing page renders with Nyx branding', async ({ page }) => {
    await page.goto('/landing');
    await expect(page.locator('text=Nyx').first()).toBeVisible({ timeout: 10_000 });
  });

  test('1.2 — dev bypass grants access to /dashboard', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.sidebar.logo)).toBeVisible({ timeout: 15_000 });
  });

  test('1.3 — dev bypass shows "Dev User" in sidebar', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.sidebar.logo)).toBeVisible({ timeout: 15_000 });
    const aside = page.locator('aside');
    await expect(aside.locator('text=Dev User')).toBeVisible({ timeout: 10_000 });
  });

  test('1.4 — /sign-in redirects to / in dev bypass', async ({ page }) => {
    // Bypass Clerk so the app uses DevAuthGuard (no Clerk sign-in page)
    for (const mod of ['src/main.tsx', 'src/App.tsx', 'src/components/AuthGuard.tsx', 'src/pages/SignIn.tsx', 'src/pages/SignUp.tsx']) {
      await page.route(`**/${mod}*`, async (route) => {
        try {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            /import\.meta\.env\.VITE_CLERK_PUBLISHABLE_KEY/g, '""',
          );
          await route.fulfill({ response, body });
        } catch {
          await route.fallback();
        }
      });
    }
    await page.goto('/sign-in');
    // In dev bypass there are no Clerk components, so the app redirects away
    await page.waitForURL(/\/(dashboard|landing)?$/, { timeout: 10_000 });
    expect(page.url()).not.toContain('/sign-in');
  });

  test('1.5 — /sign-up redirects to / in dev bypass', async ({ page }) => {
    for (const mod of ['src/main.tsx', 'src/App.tsx', 'src/components/AuthGuard.tsx', 'src/pages/SignIn.tsx', 'src/pages/SignUp.tsx']) {
      await page.route(`**/${mod}*`, async (route) => {
        try {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            /import\.meta\.env\.VITE_CLERK_PUBLISHABLE_KEY/g, '""',
          );
          await route.fulfill({ response, body });
        } catch {
          await route.fallback();
        }
      });
    }
    await page.goto('/sign-up');
    await page.waitForURL(/\/(dashboard|landing)?$/, { timeout: 10_000 });
    expect(page.url()).not.toContain('/sign-up');
  });
});

test.describe('Team Context', () => {
  test('2.1 — team name visible in sidebar', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.sidebar.logo)).toBeVisible({ timeout: 15_000 });

    // Team name should appear in the team switcher select (renders when teams.length > 1).
    // The team switcher is inside the UserSection at the bottom of the sidebar.
    // Options inside a <select> are "attached" but not "visible", so use toBeAttached().
    // Find any select in aside that has a "Default Team" option.
    const teamOption = page.locator('aside select option', { hasText: 'Default Team' });
    await expect(teamOption).toBeAttached({ timeout: 10_000 });
  });

  test('2.2 — settings Team tab shows Dev User as owner', async ({ authenticatedPage: page }) => {
    await page.goto('/app/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // Click the Team tab
    await page.locator(SEL.settings.teamTab).click();

    // Verify "Dev User" appears in the member list (scope to main to avoid sidebar match)
    await expect(page.locator('main').locator('text=Dev User')).toBeVisible({ timeout: 10_000 });

    // Verify the "owner" role badge or text is present
    await expect(page.locator('main').locator('text=/owner/i')).toBeVisible();
  });
});

test.describe('Authenticated Actions', () => {
  test('29.1 — create a document to prove auth token works', async ({ authenticatedPage: page }) => {
    // Click "New Document" button on dashboard
    await page.locator(SEL.dashboard.newDocButton).click();

    // Should navigate to a new document page
    await page.waitForURL(/\/documents\//, { timeout: 10_000 });
    expect(page.url()).toContain('/app/documents/');
  });
});
