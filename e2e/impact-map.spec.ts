import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Impact Map', () => {
  test('25.1 — impact tab opens the Impact panel', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();

    // Panel header label should be visible
    await expect(
      page.locator('text=/IMPACT/i').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.2 — chain view renders a card for each seeded node', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();
    await expect(page.locator('text=/IMPACT/i').first()).toBeVisible({ timeout: 5_000 });

    // 3 seeded nodes: doc_edit, ticket_created, code_commit
    await expect(page.locator('text=Doc edit').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Ticket created').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Code commit').first()).toBeVisible({ timeout: 5_000 });
  });

  test('25.3 — drift badge is shown for the drifted node', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();
    await expect(page.locator('text=/IMPACT/i').first()).toBeVisible({ timeout: 5_000 });

    // The ticket_created node has driftFlag: true
    await expect(
      page.locator('text=⚠ drift').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.4 — intent annotation is displayed for each node', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();
    await expect(page.locator('text=/IMPACT/i').first()).toBeVisible({ timeout: 5_000 });

    // Intent strings from SEEDED_IMPACT_GRAPH
    await expect(
      page.locator('text=Edited fields: content').first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('text=Created ticket: Implement auth endpoints').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.5 — graph view toggle switches to SVG graph', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();
    await expect(page.locator('text=/IMPACT/i').first()).toBeVisible({ timeout: 5_000 });

    // Click the Graph toggle pill
    await page.locator('button:has-text("Graph")').click();

    // An SVG element should now be present in the panel
    await expect(
      page.locator('svg').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('25.6 — switching back to chain view hides the SVG', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.impactTab).click();
    await expect(page.locator('text=/IMPACT/i').first()).toBeVisible({ timeout: 5_000 });

    // Toggle to graph then back to chain
    await page.locator('button:has-text("Graph")').click();
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 5_000 });

    await page.locator('button:has-text("Chain")').click();

    // Card labels should be back
    await expect(page.locator('text=Doc edit').first()).toBeVisible({ timeout: 5_000 });
  });
});
