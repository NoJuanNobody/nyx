/**
 * E2E tests for JSX Preview rendering fixes (Issue #61)
 *
 * Validates that:
 * 1. JSX with `export default` renders correctly (stripped before Babel)
 * 2. Plain `function App()` JSX renders correctly
 * 3. Syntax errors surface a visible transpilation error
 * 4. The iframe is sandboxed and uses blob: URLs
 */

import { test, expect } from './fixtures/test-base';
import { SEED } from './seed-ids';
import type { Page } from '@playwright/test';

// ── Sample JSX snippets ──────────────────────────────────────────

const JSX_WITH_EXPORT_DEFAULT = `export default function App() {
  return React.createElement('div', { className: "p-8 bg-white" },
    React.createElement('h1', { className: "text-2xl font-bold" }, "Hello from export default")
  );
}`;

const JSX_WITHOUT_EXPORT = `function App() {
  return React.createElement('div', { className: "p-8 bg-white" },
    React.createElement('h1', { className: "text-2xl font-bold" }, "Hello plain function")
  );
}`;

const JSX_WITH_SYNTAX_ERROR = `function App() { return (<div className={broken>; }`;

// ── Helpers ──────────────────────────────────────────────────────

function mockJSXPreviewAPI(page: Page, jsx: string) {
  return page.route('**/api/ai/jsx-preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsx }),
    }),
  );
}

async function navigateToDocument(page: Page) {
  await page.goto(`/documents/${SEED.DOC_API_SPEC_ID}`);
  await page.waitForSelector('input[type="text"]', { timeout: 10_000 });
}

async function openPreviewPanel(page: Page) {
  const previewBtn = page.locator('button[title="Preview"]');
  await previewBtn.click();
  await page.waitForSelector('textarea[placeholder*="Describe a UI"]', { timeout: 5_000 });
}

async function generatePreviewAndWait(page: Page) {
  const textarea = page.locator('textarea[placeholder*="Describe a UI"]');
  await textarea.fill('A simple card');

  // Set up response waiter BEFORE triggering the request
  const responsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/ai/jsx-preview') && resp.status() === 200,
  );
  await textarea.press('Enter');
  await responsePromise;
}

// ── Tests ────────────────────────────────────────────────────────

test.describe('JSX Preview Rendering — export default fix', () => {
  test('renders JSX that uses export default function App()', async ({ authenticatedPage: page }) => {
    await mockJSXPreviewAPI(page, JSX_WITH_EXPORT_DEFAULT);

    await navigateToDocument(page);
    await openPreviewPanel(page);
    await generatePreviewAndWait(page);

    const iframe = page.locator('iframe[title="JSX Preview"]');
    await expect(iframe).toBeVisible({ timeout: 10_000 });

    // No transpilation error should appear
    await expect(page.locator('text=Transpilation error')).not.toBeVisible({ timeout: 3_000 });
  });

  test('renders JSX that uses plain function App()', async ({ authenticatedPage: page }) => {
    await mockJSXPreviewAPI(page, JSX_WITHOUT_EXPORT);

    await navigateToDocument(page);
    await openPreviewPanel(page);
    await generatePreviewAndWait(page);

    const iframe = page.locator('iframe[title="JSX Preview"]');
    await expect(iframe).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Transpilation error')).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('JSX Preview Rendering — error handling', () => {
  test('shows transpilation error for invalid JSX syntax', async ({ authenticatedPage: page }) => {
    await mockJSXPreviewAPI(page, JSX_WITH_SYNTAX_ERROR);

    await navigateToDocument(page);
    await openPreviewPanel(page);
    await generatePreviewAndWait(page);

    await expect(page.locator('text=Preview failed')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('JSX Preview Rendering — iframe security', () => {
  test('iframe uses sandbox="allow-scripts" and blob: URL', async ({ authenticatedPage: page }) => {
    await mockJSXPreviewAPI(page, JSX_WITHOUT_EXPORT);

    await navigateToDocument(page);
    await openPreviewPanel(page);
    await generatePreviewAndWait(page);

    const iframe = page.locator('iframe[title="JSX Preview"]');
    await expect(iframe).toBeVisible({ timeout: 10_000 });

    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

    const src = await iframe.getAttribute('src');
    expect(src).toMatch(/^blob:/);
  });
});
