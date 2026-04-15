import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Audit Trail', () => {
  test('17.1 — audit tab shows doc_edit events', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open Audit drawer tab
    await page.locator(SEL.drawer.auditTab).click();

    // Wait for the Audit panel heading
    await expect(
      page.locator('text=/AUDIT/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Verify "Document edited" event is present (label for doc_edit)
    await expect(
      page.locator('text=Document edited').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('17.2 — audit tab shows ticket_created events', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open Audit drawer tab
    await page.locator(SEL.drawer.auditTab).click();

    await expect(
      page.locator('text=/AUDIT/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Verify "Ticket created" event is present (label for ticket_created)
    await expect(
      page.locator('text=Ticket created').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('17.3 — trace view shows parent event chain', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open Audit drawer tab
    await page.locator(SEL.drawer.auditTab).click();

    await expect(
      page.locator('text=/AUDIT/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    // The third seeded audit event has parentEventId, so it shows "Show trace chain" button
    const traceButton = page.locator('button:has-text("Show trace chain")').first();
    await expect(traceButton).toBeVisible({ timeout: 5_000 });
    await traceButton.click();

    // After clicking, the trace chain should show linked events
    // Our mock returns chain with 2 events: doc_edit and ticket_created
    await expect(
      page.locator('text=(current)').first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
