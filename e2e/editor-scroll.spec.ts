import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

/**
 * Regression tests for issue #338.
 *
 * Two related scroll-UX behaviors in the document editor:
 *
 *   1. Scroll position must be preserved when toggling between the
 *      Markdown / Split / Preview view modes. Previously each view
 *      switch unmounted and remounted the editor and preview panes,
 *      which created fresh scroll containers at scrollTop = 0.
 *
 *   2. In Split view, scrolling one pane should proportionally scroll
 *      the other pane using the fractional
 *      `scrollTop / (scrollHeight - clientHeight)` rule, so the line
 *      under the cursor stays visually aligned with its rendered
 *      counterpart in the preview.
 */

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

// Build a long markdown document so the scroll containers actually have
// somewhere to scroll. ~400 lines is enough to comfortably exceed any
// reasonable viewport at the default Playwright window size.
const LONG_DOC_LINES = Array.from({ length: 400 }, (_, i) => `Line ${i + 1} — lorem ipsum dolor sit amet.`);
const LONG_DOC_CONTENT = `# Long Document\n\n${LONG_DOC_LINES.join('\n\n')}\n`;

/**
 * Override the GET /api/documents/:id route for the API spec doc with a
 * long-form markdown body. Has to be installed before the page navigates
 * so the React Query first fetch hits this handler instead of the default
 * one in test-base.
 */
async function installLongDocRoute(page: import('@playwright/test').Page) {
  await page.route(`**/api/documents/${SEED.DOC_API_SPEC_ID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: SEED.DOC_API_SPEC_ID,
        title: 'Long Document',
        content: LONG_DOC_CONTENT,
        path: '/api',
        status: 'draft',
        teamId: SEED.DEFAULT_TEAM_ID,
        createdById: SEED.DEV_USER_ID,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      }),
    });
  });
}

test.describe('Document Editor — scroll preservation and split sync (issue #338)', () => {
  test('preserves editor scrollTop across view switches', async ({ authenticatedPage: page }) => {
    await installLongDocRoute(page);
    await page.goto(DOC_URL);

    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    // Wait for the initial save state to settle so the doc is fully seeded.
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });

    // Make sure we're starting from Markdown view so the textarea is the
    // visible scroll container.
    await page.locator(SEL.editor.markdownTab).click();

    // Programmatically scroll the textarea down. Doing this in a JS handle
    // dispatches a real scroll event (which the sync effect would observe
    // in split mode, though that effect is not active here).
    const targetScrollTop = await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const max = ta.scrollHeight - ta.clientHeight;
      // Scroll roughly to the middle of the document.
      const target = Math.floor(max / 2);
      ta.scrollTop = target;
      return target;
    });
    expect(targetScrollTop).toBeGreaterThan(0);

    // Hop out to Preview, then to Split, then back to Markdown.
    await page.locator(SEL.editor.previewTab).click();
    await page.locator(SEL.editor.splitTab).click();
    await page.locator(SEL.editor.markdownTab).click();

    // The textarea must be back at (approximately) the same scroll
    // position. Allow a tolerance of one line height (~22px) per the
    // acceptance criterion of "± 1 line".
    const restoredScrollTop = await textarea.evaluate((el) => (el as HTMLTextAreaElement).scrollTop);
    expect(Math.abs(restoredScrollTop - targetScrollTop)).toBeLessThanOrEqual(24);
  });

  test('split view — scrolling editor proportionally scrolls preview', async ({
    authenticatedPage: page,
  }) => {
    await installLongDocRoute(page);
    await page.goto(DOC_URL);

    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });

    // Enter split view.
    await page.locator(SEL.editor.splitTab).click();

    // The preview pane's scroll container is the wrapper div with
    // overflow-y-auto. It is the parent of the .prose root rendered by
    // <MarkdownPreview>.
    const previewScroll = page.locator(`${SEL.editor.previewPane}`).locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]').first();
    await previewScroll.waitFor({ state: 'visible', timeout: 10_000 });

    // Scroll the editor pane to ~50% of its scrollable range.
    const editorRatio = await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const max = ta.scrollHeight - ta.clientHeight;
      if (max <= 0) return 0;
      const target = Math.floor(max * 0.5);
      ta.scrollTop = target;
      ta.dispatchEvent(new Event('scroll'));
      return target / max;
    });
    expect(editorRatio).toBeGreaterThan(0);

    // Allow time for the rAF-wrapped follower update to land.
    await page.waitForTimeout(150);

    const previewRatio = await previewScroll.evaluate((el) => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return 0;
      return el.scrollTop / max;
    });

    expect(Math.abs(previewRatio - editorRatio)).toBeLessThanOrEqual(0.02);
  });

  test('split view — scrolling preview proportionally scrolls editor (reverse)', async ({
    authenticatedPage: page,
  }) => {
    await installLongDocRoute(page);
    await page.goto(DOC_URL);

    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });

    await page.locator(SEL.editor.splitTab).click();

    const previewScroll = page.locator(`${SEL.editor.previewPane}`).locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]').first();
    await previewScroll.waitFor({ state: 'visible', timeout: 10_000 });

    // Scroll the preview pane to ~40% of its range.
    const previewRatio = await previewScroll.evaluate((el) => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return 0;
      const target = Math.floor(max * 0.4);
      el.scrollTop = target;
      el.dispatchEvent(new Event('scroll'));
      return target / max;
    });
    expect(previewRatio).toBeGreaterThan(0);

    await page.waitForTimeout(150);

    const editorRatio = await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const max = ta.scrollHeight - ta.clientHeight;
      if (max <= 0) return 0;
      return ta.scrollTop / max;
    });

    expect(Math.abs(editorRatio - previewRatio)).toBeLessThanOrEqual(0.02);
  });
});
