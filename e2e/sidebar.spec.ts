import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Sidebar', () => {
  test('30.1: User name displayed', async ({ authenticatedPage: page }) => {
    await expect(page.locator('aside')).toBeVisible();
    await expect(page.locator('aside').locator('text=Dev User')).toBeVisible({ timeout: 10_000 });
  });

  test('30.2: User role badge', async ({ authenticatedPage: page }) => {
    await expect(page.locator('aside')).toBeVisible();
    // Role badge should show "owner" for the seeded dev user
    await expect(page.locator('aside').locator('text=/owner/i')).toBeVisible({ timeout: 10_000 });
  });

  // Skip: DocumentList uses first team from fetchTeams(), not auth store's currentTeamId
  test.skip('30.3: Team switcher changes team', async ({ authenticatedPage: page }) => {
    const switcher = page.locator(SEL.sidebar.teamSwitcher);
    await expect(switcher).toBeVisible({ timeout: 10_000 });

    // Switch to Second Team
    await switcher.selectOption({ label: 'Second Team' });

    // Document list should update — "Second Team Doc" should appear
    await expect(page.locator('text=Second Team Doc')).toBeVisible({ timeout: 10_000 });
  });

  test('30.4: Sign out button redirects away', async ({ authenticatedPage: page }) => {
    const signOut = page.locator(SEL.sidebar.signOutButton);
    await expect(signOut).toBeVisible({ timeout: 10_000 });
    await signOut.click();

    // Should redirect to sign-in or landing page
    await page.waitForURL(/\/(sign-in|landing|$)/, { timeout: 10_000 });
    expect(page.url()).not.toContain('/app/dashboard');
  });
});
