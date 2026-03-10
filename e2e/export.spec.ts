import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Document Export', () => {
  // Export UI is not yet implemented — skip until the feature is built
  test.skip('28.1 — export PDF triggers download', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    const exportButton = page.locator(
      'button:has-text("Export"), button:has-text("Download"), button[title*="Export"], button[title*="Download"]',
    ).first();
    await exportButton.waitFor({ state: 'visible', timeout: 5_000 });
    await exportButton.click();

    const pdfOption = page.locator(
      'button:has-text("PDF"), a:has-text("PDF"), [role="menuitem"]:has-text("PDF")',
    ).first();
    await pdfOption.waitFor({ state: 'visible', timeout: 5_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      pdfOption.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  });

  test.skip('28.2 — export Markdown triggers download', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    const exportButton = page.locator(
      'button:has-text("Export"), button:has-text("Download"), button[title*="Export"], button[title*="Download"]',
    ).first();
    await exportButton.waitFor({ state: 'visible', timeout: 5_000 });
    await exportButton.click();

    const mdOption = page.locator(
      'button:has-text("Markdown"), a:has-text("Markdown"), [role="menuitem"]:has-text("Markdown")',
    ).first();
    await mdOption.waitFor({ state: 'visible', timeout: 5_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      mdOption.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.md$/i);
  });
});
