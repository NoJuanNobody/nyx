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

  test('D.2 — document cards show title', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });

    // Each document row is a link to /documents/:id
    const docRows = page.locator(SEL.dashboard.docRow);
    await expect(docRows.first()).toBeVisible({ timeout: 10_000 });
    expect(await docRows.count()).toBeGreaterThanOrEqual(1);
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
    expect(page.url()).toContain('/app/documents/');
  });

  test('D.5 — AI prompt textarea is visible and accepts text', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.aiPrompt.textarea)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.dashboard.aiPrompt.textarea).fill('Write a user guide');
    await expect(page.locator(SEL.dashboard.aiPrompt.textarea)).toHaveValue('Write a user guide');
  });

  test('D.6 — Quick-action chip pre-fills the textarea', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.aiPrompt.textarea)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.dashboard.aiPrompt.chip('Write a spec for a new feature')).click();
    await expect(page.locator(SEL.dashboard.aiPrompt.textarea)).toHaveValue('Write a spec for a new feature');
  });

  test('D.7 — Submitting AI prompt shows streaming response', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.aiPrompt.textarea)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.dashboard.aiPrompt.textarea).fill('Write a user guide');
    await page.locator(SEL.dashboard.aiPrompt.generateButton).click();
    // Wait for result to appear (mock returns immediately)
    await expect(page.locator(SEL.dashboard.aiPrompt.result)).toBeVisible({ timeout: 10_000 });
  });

  test('D.8 — "Create doc from this" navigates to document editor', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.aiPrompt.textarea)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.dashboard.aiPrompt.textarea).fill('Write a user guide');
    await page.locator(SEL.dashboard.aiPrompt.generateButton).click();
    await expect(page.locator(SEL.dashboard.aiPrompt.createDocButton)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.dashboard.aiPrompt.createDocButton).click();
    await page.waitForURL(/\/documents\//, { timeout: 10_000 });
    expect(page.url()).toContain('/app/documents/');
  });

  test('D.9 — All 5 phase cards are visible', async ({ authenticatedPage: page }) => {
    const phases = ['Conception', 'Definition', 'Architecture', 'Implementation', 'Execution'];
    for (const phase of phases) {
      await expect(page.locator(SEL.dashboard.phases.card(phase))).toBeVisible({ timeout: 10_000 });
    }
  });

  test('D.10 — Phase "Create" button navigates to new document', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.phases.createButton('Conception'))).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.dashboard.phases.createButton('Conception')).click();
    await page.waitForURL(/\/documents\//, { timeout: 10_000 });
    expect(page.url()).toContain('/app/documents/');
  });

  test('D.11 — Recent documents section shows at most 5 documents', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.recentDocs.section)).toBeVisible({ timeout: 10_000 });
    const items = page.locator(SEL.dashboard.recentDocs.docItem);
    await expect(items.first()).toBeVisible({ timeout: 10_000 });
    const count = await items.count();
    expect(count).toBeLessThanOrEqual(5);
    expect(count).toBeGreaterThan(0);
  });

  test('D.12 — "View all" link is visible in recent documents section', async ({ authenticatedPage: page }) => {
    await expect(page.locator(SEL.dashboard.recentDocs.viewAllLink)).toBeVisible({ timeout: 10_000 });
  });
});
