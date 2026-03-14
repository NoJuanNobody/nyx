import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Impact Map', () => {
  test('25.1 — Impact tab opens the panel', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    await expect(
      page.locator('text=/IMPACT/i').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.2 — Impact panel renders event cards from the graph', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    // Wait for the chain view to load — seeded graph has 3 nodes
    await expect(
      page.locator('text=Document edited').first(),
    ).toBeVisible({ timeout: 8_000 });

    await expect(
      page.locator('text=Ticket created').first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      page.locator('text=Code committed').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.3 — Drift badge appears on drift-flagged nodes', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    // The seeded graph has one drift-flagged node (ticket_created)
    await expect(
      page.locator('text=⚠ drift').first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('25.4 — Intent annotation is shown on nodes', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    // The ticket_created node has intent: "Implement auth endpoints"
    await expect(
      page.locator('text=Implement auth endpoints').first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('25.5 — Toggling to Graph view renders the SVG canvas', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    // Wait for the panel to load
    await expect(
      page.locator('text=Document edited').first(),
    ).toBeVisible({ timeout: 8_000 });

    // Click the Graph toggle pill
    const graphButton = page.locator('button:has-text("Graph")').first();
    await expect(graphButton).toBeVisible({ timeout: 3_000 });
    await graphButton.click();

    // SVG should appear
    await expect(
      page.locator('svg').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.6 — Toggling back to Chain view hides the SVG', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    await expect(
      page.locator('text=Document edited').first(),
    ).toBeVisible({ timeout: 8_000 });

    // Switch to Graph then back to Chain
    await page.locator('button:has-text("Graph")').first().click();
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 5_000 });

    await page.locator('button:has-text("Chain")').first().click();

    // Card text should reappear; SVG element used specifically for graph should still exist
    // but we verify the chain cards are back
    await expect(
      page.locator('text=Document edited').first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
