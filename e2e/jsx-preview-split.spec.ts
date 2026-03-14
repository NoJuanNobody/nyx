import { test, expect } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('JSX Preview Split View', () => {
  test('should show JSX Preview tab in document editor', async ({ authenticatedPage: page }) => {
    // Navigate to a document
    await page.goto('/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    // Click on first document
    const docLink = page.locator(SEL.dashboard.docRow).first();
    await docLink.click();
    await page.waitForSelector(SEL.editor.titleInput, { state: 'visible' });

    // JSX Preview tab should be visible
    await expect(page.locator(SEL.jsxPreview.tab)).toBeVisible();
  });

  test('should switch to JSX Preview layout', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    const docLink = page.locator(SEL.dashboard.docRow).first();
    await docLink.click();
    await page.waitForSelector(SEL.editor.titleInput, { state: 'visible' });

    // Click JSX Preview tab
    await page.click(SEL.jsxPreview.tab);

    // Tab should be active (violet color)
    await expect(page.locator(SEL.jsxPreview.tab)).toHaveClass(/border-violet-600/);

    // JSX preview panel prompt input should be visible
    await expect(page.locator('text=Generate a live UI preview')).toBeVisible();
  });

  test('should switch back to Split layout from JSX Preview', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    const docLink = page.locator(SEL.dashboard.docRow).first();
    await docLink.click();
    await page.waitForSelector(SEL.editor.titleInput, { state: 'visible' });

    // Switch to JSX Preview
    await page.click(SEL.jsxPreview.tab);
    await expect(page.locator(SEL.jsxPreview.tab)).toHaveClass(/border-violet-600/);

    // Switch back to Split
    await page.click(SEL.editor.splitTab);
    await expect(page.locator(SEL.editor.splitTab)).toHaveClass(/border-blue-600/);

    // Preview pane should show markdown preview again
    await expect(page.locator(SEL.editor.previewPane)).toBeVisible();
  });

  test('should open JSX Preview via query param', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    // Get first document link
    const docLink = page.locator(SEL.dashboard.docRow).first();
    const href = await docLink.getAttribute('href');

    // Navigate with layout query param
    await page.goto(`${href}?layout=jsx-preview`);
    await page.waitForSelector(SEL.editor.titleInput, { state: 'visible' });

    // JSX Preview tab should be active
    await expect(page.locator(SEL.jsxPreview.tab)).toHaveClass(/border-violet-600/);
  });
});
