import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Impact Map', () => {
  test('25.1 — impact tab opens the Impact panel', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Click the Impact drawer tab
    await page.locator(SEL.drawer.impactTab).click();

    // Panel heading should read "IMPACT"
    await expect(
      page.locator('text=/IMPACT/i').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.2 — impact chain view renders node cards for each event', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    // Wait for the chain view container
    await expect(
      page.locator('[data-testid="impact-chain-view"]'),
    ).toBeVisible({ timeout: 8_000 });

    // Three seeded nodes → three cards
    const cards = page.locator('[data-testid="impact-node-card"]');
    await expect(cards).toHaveCount(3, { timeout: 5_000 });
  });

  test('25.3 — impact chain view shows drift flag for flagged events', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    await expect(
      page.locator('[data-testid="impact-chain-view"]'),
    ).toBeVisible({ timeout: 8_000 });

    // The ticket_created node has driftFlag: true in mock data
    const driftBadge = page.locator('[data-testid="drift-flag"]').first();
    await expect(driftBadge).toBeVisible({ timeout: 5_000 });
  });

  test('25.4 — impact chain view shows intent annotation for each node', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    await expect(
      page.locator('[data-testid="impact-chain-view"]'),
    ).toBeVisible({ timeout: 8_000 });

    // At least one intent annotation should be visible
    const intent = page.locator('[data-testid="node-intent"]').first();
    await expect(intent).toBeVisible({ timeout: 5_000 });
    await expect(intent).toContainText('Intent:');
  });

  test('25.5 — graph view toggle switches to SVG graph', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    await expect(
      page.locator('[data-testid="impact-map"]'),
    ).toBeVisible({ timeout: 8_000 });

    // Switch to graph view
    await page.locator('[data-testid="view-graph-btn"]').click();

    await expect(
      page.locator('[data-testid="impact-graph-view"]'),
    ).toBeVisible({ timeout: 5_000 });

    // Chain view should be hidden
    await expect(
      page.locator('[data-testid="impact-chain-view"]'),
    ).not.toBeVisible();
  });

  test('25.6 — switching back to chain view hides graph view', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    await expect(
      page.locator('[data-testid="impact-map"]'),
    ).toBeVisible({ timeout: 8_000 });

    // Switch to graph then back to chain
    await page.locator('[data-testid="view-graph-btn"]').click();
    await expect(page.locator('[data-testid="impact-graph-view"]')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="view-chain-btn"]').click();

    await expect(
      page.locator('[data-testid="impact-chain-view"]'),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="impact-graph-view"]'),
    ).not.toBeVisible();
  });
});
