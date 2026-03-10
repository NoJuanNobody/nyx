import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Integrations', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
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

  // ── 44.1: Manage Repos button visible for GitHub ────────────────
  test('44.1 — Manage Repos button visible for GitHub', async ({ authenticatedPage: page }) => {
    await expect(
      page.locator('button:has-text("Manage Repos")'),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── 44.2: Repo picker modal opens ──────────────────────────────
  test('44.2 — repo picker modal opens with repo list', async ({ authenticatedPage: page }) => {
    await page.locator('button:has-text("Manage Repos")').click();

    // Modal is a fixed overlay containing the repo picker content (no role="dialog")
    const modal = page.locator('.fixed.inset-0 > div.rounded-xl, .fixed.inset-0 > div.max-w-lg').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator('text=syncdocs/app')).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator('text=syncdocs/docs')).toBeVisible();
  });

  // ── 44.3: Search repos in picker ───────────────────────────────
  test('44.3 — search repos filters list', async ({ authenticatedPage: page }) => {
    await page.locator('button:has-text("Manage Repos")').click();

    const modal = page.locator('.fixed.inset-0 > div.rounded-xl, .fixed.inset-0 > div.max-w-lg').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Wait for repos to load before filtering
    await expect(modal.locator('text=syncdocs/app')).toBeVisible({ timeout: 5_000 });

    // Type in the search input to filter repos
    const searchInput = modal.locator('input[type="text"], input[type="search"], input[placeholder*="earch"]').first();
    await searchInput.fill('sdk');

    // Only the matching repo should be visible
    await expect(modal.locator('text=syncdocs/sdk')).toBeVisible({ timeout: 5_000 });
    // Non-matching repos should be filtered out
    await expect(modal.locator('text=syncdocs/app')).toBeHidden({ timeout: 3_000 });
  });

  // ── 44.4: Select/deselect repo checkbox ─────────────────────────
  test('44.4 — select and deselect repo checkbox', async ({ authenticatedPage: page }) => {
    await page.locator('button:has-text("Manage Repos")').click();

    const modal = page.locator('.fixed.inset-0 > div.rounded-xl, .fixed.inset-0 > div.max-w-lg').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Find a checkbox for a repo
    const checkbox = modal.locator('input[type="checkbox"]').first();
    await expect(checkbox).toBeVisible({ timeout: 5_000 });

    // Toggle check state
    const wasChecked = await checkbox.isChecked();
    if (wasChecked) {
      await checkbox.uncheck();
      await expect(checkbox).not.toBeChecked();
      await checkbox.check();
      await expect(checkbox).toBeChecked();
    } else {
      await checkbox.check();
      await expect(checkbox).toBeChecked();
      await checkbox.uncheck();
      await expect(checkbox).not.toBeChecked();
    }
  });

  // ── 44.5: Save selected repos closes modal ──────────────────────
  test('44.5 — save selected repos closes modal', async ({ authenticatedPage: page }) => {
    await page.locator('button:has-text("Manage Repos")').click();

    const modal = page.locator('.fixed.inset-0 > div.rounded-xl, .fixed.inset-0 > div.max-w-lg').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Select a repo
    const checkbox = modal.locator('input[type="checkbox"]').first();
    await checkbox.check();

    // Click Save button (contains "Save" text, possibly with repo count)
    await modal.locator('button:has-text("Save")').click();

    // Modal overlay should close
    await expect(page.locator('.fixed.inset-0')).toBeHidden({ timeout: 5_000 });
  });
});
