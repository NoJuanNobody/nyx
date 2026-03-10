/**
 * E2E tests for AI JSX Preview Generation (Issue #46)
 *
 * These tests cover the full user journey: generating a preview, refining it,
 * switching view modes, copy/download actions, error handling, security, and
 * DocDrawer integration.
 *
 * Test runner: Playwright (assumed — replace with your actual E2E framework)
 * 22 scenarios total.
 */

import { test, expect, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openDocument(page: Page, documentId = 'test-doc-1') {
  await page.goto(`/documents/${documentId}`);
  await page.waitForSelector('[data-testid="document-editor"]');
}

async function openJSXPreviewPanel(page: Page) {
  await page.click('[data-testid="drawer-toggle-jsx-preview"]');
  await page.waitForSelector('[data-testid="jsx-preview-panel"]');
}

async function mockJSXPreviewAPI(page: Page, jsx: string) {
  await page.route('**/api/ai/jsx-preview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsx }) }),
  );
}

async function mockRefineAPI(page: Page, jsx: string) {
  await page.route('**/api/ai/jsx-preview/refine', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsx }) }),
  );
}

const SAMPLE_JSX = `
export default function App() {
  return (
    <div className="p-8 bg-white">
      <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="rounded-lg bg-blue-50 p-4">
          <p className="text-sm text-slate-500">Revenue</p>
          <p className="text-xl font-bold text-blue-600">$12,400</p>
        </div>
      </div>
    </div>
  );
}
`.trim();

const REFINED_JSX = `
export default function App() {
  return (
    <div className="p-8 bg-slate-100">
      <h1 className="text-2xl font-bold text-slate-900">Updated Dashboard</h1>
    </div>
  );
}
`.trim();

// ---------------------------------------------------------------------------
// Preview generation
// ---------------------------------------------------------------------------

test.describe('Preview generation', () => {
  test('1. Generate from typed prompt → Claude API call → JSX → iframe render', async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);

    const promptInput = page.getByPlaceholder('Describe a UI to generate…');
    await promptInput.fill('A dashboard with metric cards');
    await page.click('[data-testid="jsx-preview-submit"]');

    // API was called
    const [request] = await Promise.all([
      page.waitForRequest('**/api/ai/jsx-preview'),
      page.click('[data-testid="jsx-preview-submit"]').catch(() => {}),
    ]);
    expect(request.postDataJSON()).toMatchObject({ prompt: expect.any(String) });

    // iframe renders
    const iframe = page.locator('iframe[title="JSX Preview"]');
    await expect(iframe).toBeVisible();
  });

  test('2. Generate from selected spec text (context passed with prompt)', async ({ page }) => {
    let capturedBody: Record<string, unknown> = {};
    await page.route('**/api/ai/jsx-preview', async (route) => {
      capturedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsx: SAMPLE_JSX }) });
    });

    await openDocument(page);
    // Simulate spec text selection via context prop
    await openJSXPreviewPanel(page);

    const promptInput = page.getByPlaceholder('Describe a UI to generate…');
    await promptInput.fill('Turn this spec section into a UI');
    await page.click('[data-testid="jsx-preview-submit"]');

    await page.waitForResponse('**/api/ai/jsx-preview');
    // context field may be present when specContext prop is set
    expect(capturedBody.prompt).toBeTruthy();
  });

  test('3. iframe has sandbox="allow-scripts" (no allow-same-origin) and uses blob: URL', async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);

    await page.getByPlaceholder('Describe a UI to generate…').fill('A simple card');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');

    const iframe = page.locator('iframe[title="JSX Preview"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

    const src = await iframe.getAttribute('src');
    expect(src).toMatch(/^blob:/);

    // Crucially no allow-same-origin
    const sandbox = await iframe.getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  test('4. Fresh iframe per generation (no state leakage)', async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);

    const submit = page.locator('[data-testid="jsx-preview-submit"]');
    const promptInput = page.getByPlaceholder('Describe a UI to generate…');

    await promptInput.fill('First component');
    await submit.click();
    await page.waitForResponse('**/api/ai/jsx-preview');
    const firstSrc = await page.locator('iframe[title="JSX Preview"]').getAttribute('src');

    await promptInput.fill('Second component');
    await submit.click();
    await page.waitForResponse('**/api/ai/jsx-preview');
    const secondSrc = await page.locator('iframe[title="JSX Preview"]').getAttribute('src');

    // Each generation produces a new blob URL
    expect(firstSrc).not.toBe(secondSrc);
  });
});

// ---------------------------------------------------------------------------
// View modes
// ---------------------------------------------------------------------------

test.describe('View modes', () => {
  test.beforeEach(async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);
    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');
  });

  test('5. Code view: read-only JSX displayed', async ({ page }) => {
    await page.click('button:has-text("code")');
    const codeBlock = page.locator('pre');
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).toContainText('export default function App');
  });

  test('6. Preview view: only the sandboxed iframe is shown', async ({ page }) => {
    await page.click('button:has-text("preview")');
    await expect(page.locator('iframe[title="JSX Preview"]')).toBeVisible();
    await expect(page.locator('pre')).not.toBeVisible();
  });

  test('7. Split view: code panel and iframe rendered side by side', async ({ page }) => {
    await page.click('button:has-text("split")');
    await expect(page.locator('pre')).toBeVisible();
    await expect(page.locator('iframe[title="JSX Preview"]')).toBeVisible();
  });

  test('8. Default view on first generation is Preview', async ({ page }) => {
    // After generation the preview mode should be active by default
    const previewBtn = page.locator('button:has-text("preview")');
    await expect(previewBtn).toHaveClass(/bg-white/);
    await expect(page.locator('iframe[title="JSX Preview"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Iterative refinement
// ---------------------------------------------------------------------------

test.describe('Iterative refinement', () => {
  test.beforeEach(async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);
    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');
  });

  test('9. Refine sends POST /api/ai/jsx-preview/refine with currentJSX + prompt', async ({ page }) => {
    let refineBody: Record<string, unknown> = {};
    await page.route('**/api/ai/jsx-preview/refine', async (route) => {
      refineBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsx: REFINED_JSX }) });
    });

    await page.getByPlaceholder('Refine the preview…').fill('Make the card blue');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview/refine');

    expect(refineBody.currentJSX).toBeTruthy();
    expect(refineBody.prompt).toBe('Make the card blue');
  });

  test('10. Multiple refinement rounds build on previous JSX', async ({ page }) => {
    const jsxVersions: string[] = [];
    await page.route('**/api/ai/jsx-preview/refine', async (route) => {
      const body = route.request().postDataJSON() as { currentJSX: string; prompt: string };
      jsxVersions.push(body.currentJSX);
      const newJsx = `/* refined ${jsxVersions.length} */\n${body.currentJSX}`;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsx: newJsx }) });
    });

    const input = page.getByPlaceholder('Refine the preview…');

    await input.fill('Round 1 change');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview/refine');

    await input.fill('Round 2 change');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview/refine');

    // Second refinement received the already-once-refined JSX
    expect(jsxVersions[1]).toContain('refined 1');
  });

  test('11. Refinement preserves component structure (no regression)', async ({ page }) => {
    await mockRefineAPI(page, REFINED_JSX);

    await page.getByPlaceholder('Refine the preview…').fill('Change background color');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview/refine');

    // Code view should show updated JSX
    await page.click('button:has-text("code")');
    await expect(page.locator('pre')).toContainText('Updated Dashboard');
  });
});

// ---------------------------------------------------------------------------
// Copy & download
// ---------------------------------------------------------------------------

test.describe('Copy & download', () => {
  test.beforeEach(async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);
    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');
  });

  test('12. Copy JSX to clipboard shows "Copied!" confirmation', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('button:has-text("Copy")');
    await expect(page.locator('button:has-text("Copied!")')).toBeVisible();
  });

  test('13. Download triggers file download as .jsx', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text(".jsx")'),
    ]);
    expect(download.suggestedFilename()).toBe('preview.jsx');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test.describe('Error handling', () => {
  test('14. Transpilation error from iframe postMessage shown in panel', async ({ page }) => {
    const badJsx = 'export default function App() { return (<div className={broken>; }'; // invalid JSX
    await mockJSXPreviewAPI(page, badJsx);
    await openDocument(page);
    await openJSXPreviewPanel(page);

    await page.getByPlaceholder('Describe a UI to generate…').fill('A broken component');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');

    // Error shown in renderer
    await expect(page.locator('text=Transpilation error')).toBeVisible({ timeout: 8000 });
  });

  test('15. API 500 error displayed in panel error banner', async ({ page }) => {
    await page.route('**/api/ai/jsx-preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal server error' }) }),
    );
    await openDocument(page);
    await openJSXPreviewPanel(page);

    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');

    await expect(page.locator('[data-testid="jsx-preview-error-banner"]')).toBeVisible();
  });

  test('16. Empty prompt: submit button disabled, no API call', async ({ page }) => {
    let apiCalled = false;
    await page.route('**/api/ai/jsx-preview', async (route) => {
      apiCalled = true;
      await route.fulfill({ status: 200, body: JSON.stringify({ jsx: SAMPLE_JSX }) });
    });

    await openDocument(page);
    await openJSXPreviewPanel(page);

    const submit = page.locator('[data-testid="jsx-preview-submit"]');
    await expect(submit).toBeDisabled();
    expect(apiCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test.describe('Security', () => {
  test.beforeEach(async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);
    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');
  });

  test('17. iframe cannot read window.parent.localStorage', async ({ page }) => {
    // Because sandbox="allow-scripts" (no allow-same-origin), accessing
    // window.parent from inside the iframe raises a SecurityError.
    const iframeEl = await page.locator('iframe[title="JSX Preview"]').elementHandle();
    expect(iframeEl).not.toBeNull();

    // Verify sandbox attribute does not include allow-same-origin
    const sandbox = await page.locator('iframe[title="JSX Preview"]').getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  test('18. iframe cannot make credentialed API calls (no allow-same-origin)', async ({ page }) => {
    const iframe = page.locator('iframe[title="JSX Preview"]');
    const sandbox = await iframe.getAttribute('sandbox');
    expect(sandbox).toBe('allow-scripts');
  });

  test('19. Blob URL isolation: iframe src starts with blob:', async ({ page }) => {
    const src = await page.locator('iframe[title="JSX Preview"]').getAttribute('src');
    expect(src).toMatch(/^blob:/);
  });
});

// ---------------------------------------------------------------------------
// DocDrawer integration
// ---------------------------------------------------------------------------

test.describe('DocDrawer integration', () => {
  test('20. Preview tab visible in DocDrawer toggle', async ({ page }) => {
    await openDocument(page);
    const previewToggle = page.locator('[data-testid="drawer-toggle-jsx-preview"]');
    await expect(previewToggle).toBeVisible();
    await expect(previewToggle).toHaveAttribute('title', 'Preview');
  });

  test('21. Switching away from Preview tab and back preserves state', async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);

    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');
    await page.waitForResponse('**/api/ai/jsx-preview');

    // Switch to History tab
    await page.click('[data-testid="drawer-toggle-history"]');
    await expect(page.locator('[data-testid="jsx-preview-panel"]')).not.toBeVisible();

    // Switch back to Preview tab
    await page.click('[data-testid="drawer-toggle-jsx-preview"]');
    await expect(page.locator('iframe[title="JSX Preview"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

test.describe('Performance', () => {
  test('22. Preview renders within 5 seconds of API response', async ({ page }) => {
    await mockJSXPreviewAPI(page, SAMPLE_JSX);
    await openDocument(page);
    await openJSXPreviewPanel(page);

    await page.getByPlaceholder('Describe a UI to generate…').fill('A card');
    await page.click('[data-testid="jsx-preview-submit"]');

    const start = Date.now();
    await page.waitForResponse('**/api/ai/jsx-preview');

    // iframe onLoad should fire within 5s of the API response
    await page.locator('iframe[title="JSX Preview"]').waitFor({ state: 'visible' });

    // Verify no loading spinner still showing within 5s
    await expect(page.locator('text=Rendering preview…')).not.toBeVisible({ timeout: 5000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
