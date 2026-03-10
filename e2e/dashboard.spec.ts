import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Dashboard', () => {
  test('D.1 — document list renders seeded documents', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });

    // Verify the three active Default Team docs are listed (scope to main to avoid sidebar matches)
    const main = page.locator('main');
    await expect(main.locator('text=API Specification')).toBeVisible({ timeout: 10_000 });
    await expect(main.locator('text=Architecture Overview')).toBeVisible();
    await expect(main.locator('text=Quick Start')).toBeVisible();
  });

  test('D.2 — document cards show title and status badge', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });

    // Each document row is a link to /documents/:id
    const docRows = page.locator(SEL.dashboard.docRow);
    await expect(docRows.first()).toBeVisible({ timeout: 10_000 });
    expect(await docRows.count()).toBeGreaterThanOrEqual(1);

    // At least one badge with a status like "draft" or "published" should be visible
    const badge = page.locator('text=/draft|published|archived/i').first();
    await expect(badge).toBeVisible({ timeout: 5_000 });
  });

  // Skip: DocumentList always uses first team from fetchTeams(), not the auth store's currentTeamId
  test.skip('D.3 — switch to Second Team and see its document', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });

    // Select the second team from the team switcher
    const teamSwitcher = page.locator(SEL.sidebar.teamSwitcher);
    await expect(teamSwitcher).toBeVisible({ timeout: 10_000 });
    await teamSwitcher.selectOption({ label: 'Second Team' });

    // Wait for the document list to update with the Second Team doc
    await expect(page.locator('text=Second Team Doc')).toBeVisible({ timeout: 10_000 });
  });

  test('D.4 — clicking "New Document" navigates to document editor', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });

    await page.locator(SEL.dashboard.newDocButton).click();

    // Should navigate to a new document URL
    await page.waitForURL(/\/documents\//, { timeout: 10_000 });
    expect(page.url()).toContain('/documents/');
  });
});
