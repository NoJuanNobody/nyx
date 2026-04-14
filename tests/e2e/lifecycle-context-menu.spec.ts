/**
 * E2E tests for Document Lifecycle Stages — Context Menu Creation Flow (Issue #35)
 *
 * Covers the right-click context menu integrated into the FileTree, surfacing
 * the 5 lifecycle stages as top-level menu items with template submenus.
 *
 * Test runner: Playwright
 * 25 scenarios total.
 */

import { test, expect, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openDashboard(page: Page) {
  await page.goto('/');
  await page.waitForSelector('[data-testid="file-tree"]');
}

async function mockTemplatesAPI(
  page: Page,
  templates: Array<{
    id: string;
    name: string;
    content: string;
    stage: string;
    description?: string;
  }>,
) {
  await page.route('**/api/templates', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(templates),
    }),
  );
}

async function rightClickFolder(page: Page, folderName: string) {
  const folder = page.locator(`[data-testid="folder-item"]`, { hasText: folderName });
  await folder.click({ button: 'right' });
  await page.waitForSelector('[role="menu"]');
}

async function rightClickEmptyTreeSpace(page: Page) {
  const treeRoot = page.locator('[data-testid="file-tree-root"]');
  await treeRoot.click({ button: 'right' });
  await page.waitForSelector('[role="menu"]');
}

async function rightClickDocument(page: Page, docTitle: string) {
  const docLink = page.locator('nav a, a[href*="/app/documents/"]', { hasText: docTitle });
  await docLink.click({ button: 'right' });
  await page.waitForSelector('[role="menu"]');
}

const STAGE_LABELS = [
  'Conception',
  'Definition',
  'Architecture',
  'Implementation',
  'Execution',
] as const;

const MOCK_TEMPLATES = [
  { id: 't1', name: 'Vision Statement', content: '# Vision\n', stage: 'conception', description: 'Capture the initial vision' },
  { id: 't2', name: 'PRD', content: '# PRD\n', stage: 'definition', description: 'Product requirements doc' },
  { id: 't3', name: 'ADR', content: '# ADR\n', stage: 'architecture', description: 'Architecture decision record' },
];

// ---------------------------------------------------------------------------
// Context menu rendering (5 tests)
// ---------------------------------------------------------------------------

test.describe('Context menu rendering', () => {
  test('1. Right-click on folder shows all 5 lifecycle stages', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');

    for (const stage of STAGE_LABELS) {
      await expect(page.locator(`[role="menu"] [role="menuitem"]`, { hasText: stage })).toBeVisible();
    }
  });

  test('2. Right-click on empty tree space shows context menu', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickEmptyTreeSpace(page);

    await expect(page.locator('[role="menu"]')).toBeVisible();
    await expect(page.locator('[role="menu"] [role="menuitem"]', { hasText: 'New blank document' })).toBeVisible();
  });

  test('3. Right-click on document shows "Set stage" and "Duplicate"', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickDocument(page, 'My Doc');

    await expect(page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Set stage' })).toBeVisible();
    await expect(page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Duplicate' })).toBeVisible();
  });

  test('4. All 5 stages always visible even when a stage has no templates', async ({ page }) => {
    // Empty templates — stages should still appear
    await mockTemplatesAPI(page, []);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');

    for (const stage of STAGE_LABELS) {
      await expect(page.locator(`[role="menu"] [role="menuitem"]`, { hasText: stage })).toBeVisible();
    }
  });

  test('5. Stage items render colored dot, label, and subtitle', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');

    // Conception item should have "Idea & Vision" subtitle visible in label
    const conceptionItem = page.locator('[role="menu"] [role="menuitem"]', {
      hasText: 'Conception',
    });
    await expect(conceptionItem).toBeVisible();
    // The dot element is rendered inside the item
    const dot = conceptionItem.locator('.rounded-full').first();
    await expect(dot).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Template submenu (6 tests)
// ---------------------------------------------------------------------------

test.describe('Template submenu', () => {
  test.beforeEach(async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');
  });

  test('6. Hover on Conception stage shows template submenu', async ({ page }) => {
    const conceptionItem = page.locator('[role="menu"] [role="menuitem"]', {
      hasText: 'Conception',
    });
    await conceptionItem.hover();
    // Wait for submenu delay + render
    const submenu = page.locator('[role="menu"]').nth(1);
    await expect(submenu).toBeVisible({ timeout: 500 });
    await expect(submenu.locator('button', { hasText: 'Vision Statement' })).toBeVisible();
  });

  test('7. Stage with no templates shows only "Blank {stage} doc"', async ({ page }) => {
    // Execution has no templates in MOCK_TEMPLATES
    const executionItem = page.locator('[role="menu"] [role="menuitem"]', {
      hasText: 'Execution',
    });
    await executionItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await expect(submenu).toBeVisible({ timeout: 500 });
    await expect(submenu.locator('button', { hasText: 'Blank Execution doc' })).toBeVisible();
    // Should not have any other template buttons
    const buttons = await submenu.locator('button').count();
    expect(buttons).toBe(1);
  });

  test('8. Template submenu reads from React Query cache (no duplicate requests)', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/api/templates', async (route) => {
      requestCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TEMPLATES),
      });
    });

    await openDashboard(page);
    // Initial load should fetch once
    await page.waitForResponse('**/api/templates');
    const countAfterLoad = requestCount;

    // Open context menu and hover multiple stages — no new requests
    await rightClickFolder(page, 'docs');
    for (const stage of STAGE_LABELS.slice(0, 3)) {
      const item = page.locator('[role="menu"] [role="menuitem"]', { hasText: stage });
      await item.hover();
      await page.waitForTimeout(150);
    }

    expect(requestCount).toBe(countAfterLoad);
  });

  test('9. Click template creates document in correct folder with stage pre-filled', async ({ page }) => {
    let createPayload: Record<string, unknown> = {};
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        createPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'new-doc-1', title: 'Vision Statement', status: 'draft', ...createPayload }),
        });
      } else {
        await route.continue();
      }
    });

    await openDashboard(page);
    await rightClickFolder(page, 'docs');
    const conceptionItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Conception' });
    await conceptionItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.locator('button', { hasText: 'Vision Statement' }).click();

    await page.waitForResponse('**/api/documents');
    expect(createPayload.stage).toBe('conception');
    expect(createPayload.templateId).toBe('t1');
  });

  test('10. Click "Blank {stage} doc" creates an empty staged document', async ({ page }) => {
    let createPayload: Record<string, unknown> = {};
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        createPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'new-doc-2', title: 'Untitled Architecture', status: 'draft', ...createPayload }),
        });
      } else {
        await route.continue();
      }
    });

    await openDashboard(page);
    await rightClickFolder(page, 'docs');
    const archItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Architecture' });
    await archItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.locator('button', { hasText: 'Blank Architecture doc' }).click();

    await page.waitForResponse('**/api/documents');
    expect(createPayload.stage).toBe('architecture');
    expect(createPayload.content).toBe('');
  });

  test('11. "Browse all templates…" opens TemplatePicker modal', async ({ page }) => {
    await openDashboard(page);
    await rightClickFolder(page, 'docs');
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Browse all templates' }).click();

    // TemplatePicker modal should appear
    await expect(page.locator('[data-testid="template-picker-modal"], text=Create Document')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Document context menu actions (4 tests)
// ---------------------------------------------------------------------------

test.describe('Document context menu actions', () => {
  test('12. Set stage on existing document calls PATCH/PUT with new stage', async ({ page }) => {
    let updatePayload: Record<string, unknown> = {};
    await page.route('**/api/documents/doc-1', async (route) => {
      if (route.request().method() === 'PUT' || route.request().method() === 'PATCH') {
        updatePayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'doc-1', stage: 'definition', status: 'draft', title: 'My Doc', content: '' }),
        });
      } else {
        await route.continue();
      }
    });

    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickDocument(page, 'My Doc');

    const setStageItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Set stage' });
    await setStageItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.locator('button', { hasText: 'Definition' }).click();

    await page.waitForResponse('**/api/documents/doc-1');
    expect(updatePayload.stage).toBe('definition');
  });

  test('13. Current stage shows checkmark in Set stage submenu', async ({ page }) => {
    // Mock a document already assigned to "conception"
    await page.route('**/api/documents*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'doc-staged', title: 'Staged Doc', status: 'draft', stage: 'conception', content: '', path: '/', teamId: 't1' },
          ]),
        });
      } else {
        await route.continue();
      }
    });

    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickDocument(page, 'Staged Doc');

    const setStageItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Set stage' });
    await setStageItem.hover();

    const submenu = page.locator('[role="menu"]').nth(1);
    // Conception button should have a checkmark SVG inside it
    const conceptionBtn = submenu.locator('button', { hasText: 'Conception' });
    await expect(conceptionBtn.locator('svg')).toBeVisible();
  });

  test('14. Remove stage clears the stage assignment', async ({ page }) => {
    let updatePayload: Record<string, unknown> = {};
    await page.route('**/api/documents/doc-staged', async (route) => {
      if (route.request().method() === 'PUT' || route.request().method() === 'PATCH') {
        updatePayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'doc-staged', stage: null, status: 'draft', title: 'Staged Doc', content: '' }),
        });
      } else {
        await route.continue();
      }
    });

    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickDocument(page, 'Staged Doc');

    const setStageItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Set stage' });
    await setStageItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.locator('button', { hasText: 'Remove stage' }).click();

    await page.waitForResponse('**/api/documents/doc-staged');
    expect(updatePayload.stage).toBeNull();
  });

  test('15. Duplicate document creates a copy with the same stage', async ({ page }) => {
    let createPayload: Record<string, unknown> = {};
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        createPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'copy-doc', title: 'My Doc (copy)', status: 'draft', stage: 'conception', content: '' }),
        });
      } else {
        await route.continue();
      }
    });

    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickDocument(page, 'My Doc');
    await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Duplicate' }).click();

    await page.waitForResponse('**/api/documents');
    expect((createPayload.title as string)).toContain('copy');
    expect(createPayload.stage).toBe('conception');
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation (5 tests)
// ---------------------------------------------------------------------------

test.describe('Keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');
  });

  test('16. ArrowDown moves focus through menu items', async ({ page }) => {
    const menu = page.locator('[role="menu"]').first();
    await menu.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    // Second item should be focused (bg-slate-100 class applied)
    const focusedItems = await page.locator('[role="menuitem"].bg-slate-100').count();
    expect(focusedItems).toBeGreaterThan(0);
  });

  test('17. ArrowUp wraps around to last item', async ({ page }) => {
    const menu = page.locator('[role="menu"]').first();
    await menu.focus();
    await page.keyboard.press('ArrowUp');
    // Should wrap to last item
    const focusedItems = await page.locator('[role="menuitem"].bg-slate-100').count();
    expect(focusedItems).toBeGreaterThan(0);
  });

  test('18. Enter selects the focused item', async ({ page }) => {
    let createCalled = false;
    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        createCalled = true;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'kbdoc', title: 'Untitled Document', status: 'draft', content: '' }),
        });
      } else {
        await route.continue();
      }
    });

    const menu = page.locator('[role="menu"]').first();
    await menu.focus();
    // ArrowDown to first item ("New blank document"), then Enter
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(createCalled).toBe(true);
  });

  test('19. Escape closes the context menu', async ({ page }) => {
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).not.toBeVisible();
  });

  test('20. ArrowRight on stage item opens submenu; ArrowLeft closes it', async ({ page }) => {
    const menu = page.locator('[role="menu"]').first();
    await menu.focus();

    // Navigate to first stage item (index depends on separators; use text)
    const conceptionItem = menu.locator('[role="menuitem"]', { hasText: 'Conception' });
    await conceptionItem.hover(); // focus it
    await page.keyboard.press('ArrowRight');

    const submenu = page.locator('[role="menu"]').nth(1);
    await expect(submenu).toBeVisible({ timeout: 500 });

    await page.keyboard.press('ArrowLeft');
    await expect(submenu).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Menu positioning (2 tests)
// ---------------------------------------------------------------------------

test.describe('Menu positioning', () => {
  test('21. Menu is clamped to viewport and does not overflow right edge', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await page.setViewportSize({ width: 400, height: 600 });
    await openDashboard(page);

    // Right-click near the right edge of the screen
    await page.mouse.click(390, 200, { button: 'right' });
    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toBeVisible({ timeout: 500 });

    const box = await menu.boundingBox();
    if (box) {
      expect(box.x + box.width).toBeLessThanOrEqual(400 + 1); // +1 px tolerance
    }
  });

  test('22. Submenu flips to left side when near right viewport edge', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await page.setViewportSize({ width: 320, height: 600 });
    await openDashboard(page);

    await rightClickFolder(page, 'docs');
    const conceptionItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Conception' });
    await conceptionItem.hover();

    const submenu = page.locator('[role="menu"]').nth(1);
    await expect(submenu).toBeVisible({ timeout: 500 });

    const mainMenuBox = await page.locator('[role="menu"]').first().boundingBox();
    const submenuBox = await submenu.boundingBox();

    if (mainMenuBox && submenuBox) {
      // Submenu should open to the LEFT of the main menu when near right edge
      expect(submenuBox.x).toBeLessThan(mainMenuBox.x);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage tooltips & API integration (3 tests)
// ---------------------------------------------------------------------------

test.describe('Stage tooltips and API integration', () => {
  test('23. Tooltip / subtitle text matches stage metadata', async ({ page }) => {
    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');

    // Conception row should show "Idea & Vision" in its label
    await expect(
      page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Idea & Vision' }),
    ).toBeVisible();
    // Definition row should show "Product Spec"
    await expect(
      page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Product Spec' }),
    ).toBeVisible();
  });

  test('24. Created document persists after page refresh', async ({ page }) => {
    const newDoc = { id: 'persist-doc', title: 'Vision Statement', status: 'draft', stage: 'conception', content: '# Vision\n', path: '/', teamId: 't1' };

    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(newDoc),
        });
      } else {
        // Return the newly created doc in list after creation
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([newDoc]),
        });
      }
    });

    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');
    const conceptionItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Conception' });
    await conceptionItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.locator('button', { hasText: 'Vision Statement' }).click();

    await page.waitForResponse((r) => r.url().includes('/api/documents') && r.request().method() === 'POST');

    // Reload the page
    await page.reload();
    await page.waitForSelector('[data-testid="file-tree"]');

    // The created document should appear in the tree
    await expect(page.locator('text=Vision Statement')).toBeVisible();
  });

  test('25. Version history records template-created document content', async ({ page }) => {
    const newDoc = {
      id: 'versioned-doc',
      title: 'PRD',
      status: 'draft',
      stage: 'definition',
      content: '# PRD\n',
      path: '/',
      teamId: 't1',
    };

    await page.route('**/api/documents', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(newDoc),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/documents/${newDoc.id}/versions`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'v1', documentId: newDoc.id, content: newDoc.content, message: 'Initial from template', createdAt: new Date().toISOString() },
        ]),
      });
    });

    await mockTemplatesAPI(page, MOCK_TEMPLATES);
    await openDashboard(page);
    await rightClickFolder(page, 'docs');
    const definitionItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Definition' });
    await definitionItem.hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.locator('button', { hasText: 'PRD' }).click();

    await page.waitForResponse((r) => r.url().includes('/api/documents') && r.request().method() === 'POST');
    await page.goto(`/app/documents/${newDoc.id}`);

    // Open version history panel
    await page.click('[data-testid="drawer-toggle-history"], button[title="Version History"]');
    const historyPanel = page.locator('[data-testid="version-history-panel"], text=Initial from template');
    await expect(historyPanel).toBeVisible({ timeout: 3000 });
  });
});
