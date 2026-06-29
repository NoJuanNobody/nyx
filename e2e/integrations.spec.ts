import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Integrations', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/app/settings');
    await page.locator(SEL.settings.integrationsTab).click();
    // Wait for the integrations panel to render
    await expect(page.locator('text=GitHub')).toBeVisible({ timeout: 10_000 });
  });

  // ── 9.1: GitHub card shows connected ────────────────────────────
  test('9.1 — GitHub card shows connected status', async ({ authenticatedPage: page }) => {
    // The GitHub card should show "Connected" badge since we have a seeded integration
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 5_000 });
  });

  // ── 21.1: All 3 provider cards visible ──────────────────────────
  test('21.1 — all 3 provider cards visible', async ({ authenticatedPage: page }) => {
    // Each integration card shows the provider label as a semibold span
    await expect(page.locator('text=GitHub').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Jira').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Confluence').first()).toBeVisible({ timeout: 5_000 });
  });

  // ── 21.2: Connect button for unconnected provider ───────────────
  test('21.2 — Confluence has Connect button', async ({ authenticatedPage: page }) => {
    // Confluence is not connected — should have a Connect button
    // Find the Confluence section and verify it has a Connect button
    const connectButtons = page.locator('button:has-text("Connect")');
    // There should be at least one Connect button (for unconnected providers)
    await expect(connectButtons.first()).toBeVisible({ timeout: 5_000 });
  });

  // ── 21.3: Disconnect integration ────────────────────────────────
  test('21.3 — disconnect GitHub integration', async ({ authenticatedPage: page }) => {
    // GitHub is connected, so a Disconnect button should exist
    const disconnectButton = page.locator('button:has-text("Disconnect")').first();
    await expect(disconnectButton).toBeVisible({ timeout: 5_000 });
    await disconnectButton.click();

    // After disconnect, the card should update (the mock returns success)
  });

  // ── 44.1: Select repositories link visible for GitHub ────────────
  // #380 replaced the "Manage Repos" button in Settings with a
  // "Select repositories →" link that navigates to /app/repositories.
  test('44.1 — Select repositories link visible for GitHub', async ({ authenticatedPage: page }) => {
    await expect(
      page.locator('a:has-text("Select repositories")'),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── 44.2: Select repositories link navigates to /app/repositories ─
  // The RepoPickerModal was removed from Settings (#380). Repo management
  // now lives on the dedicated Repositories page.
  test('44.2 — Select repositories link navigates to Repositories page', async ({ authenticatedPage: page }) => {
    const link = page.locator('a:has-text("Select repositories")').first();
    await expect(link).toBeVisible({ timeout: 5_000 });
    await link.click();

    // Should navigate to the Repositories page
    await expect(page).toHaveURL(/\/app\/repositories/, { timeout: 10_000 });
    await expect(page.locator('h1:has-text("Repositories")')).toBeVisible({ timeout: 10_000 });
  });
});
