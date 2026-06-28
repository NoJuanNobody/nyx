import { test, expect, SEED } from './fixtures/test-base';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Document Editor toolbar — text labels next to icons (#337)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('all six row-2 toolbar buttons show visible text labels at >= 640px', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(DOC_URL);

    // Wait for the toolbar to be interactive
    await page
      .locator('[data-testid="bulk-generate-tickets"]')
      .waitFor({ state: 'visible', timeout: 10_000 });

    // Each of the six buttons is identified by its `title` attribute —
    // title is load-bearing per AC, and the visible label must equal the
    // title string. Seed uses a dynamic title; we match it by prefix.
    const assertLabeled = async (titleExact: string, expectedText: string) => {
      const button = page.locator(`button[title="${titleExact}"]`).first();
      await expect(button).toBeVisible();
      await expect(button).toContainText(expectedText);
    };

    // The single-ticket "Create Ticket" button was removed in #384 (ticket
    // creation now lives in the Proposals drawer); Trace is a <Link> / <a>,
    // not a <button> — covered in the next test.
    await assertLabeled('Bulk Tickets', 'Bulk Tickets');
    await assertLabeled('Export', 'Export');
    await assertLabeled('Save Version', 'Save Version');
    await assertLabeled('Save as Template', 'Save as Template');

    // Seed button title is dynamic: `Seed ${nextStage}` — match by prefix
    const seedButton = page.locator('button[title^="Seed "]').first();
    if (await seedButton.count()) {
      await expect(seedButton).toBeVisible();
      const title = await seedButton.getAttribute('title');
      if (title && !title.startsWith('Seeding')) {
        await expect(seedButton).toContainText(title);
      }
    }
  });

  test('Trace link also shows its visible label', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    // Trace is rendered as a <Link>, not a <button>. Match the anchor by its
    // title attribute.
    const trace = page.locator('a[title="Trace"]').first();
    await expect(trace).toBeVisible();
    await expect(trace).toContainText('Trace');
  });

  test('data-testid attributes are preserved on labeled buttons', async ({
    authenticatedPage: page,
  }) => {
    await page.goto(DOC_URL);
    await expect(page.locator('[data-testid="bulk-generate-tickets"]')).toBeVisible();
    await expect(page.locator('[data-testid="export-menu-button"]')).toBeVisible();
  });
});
