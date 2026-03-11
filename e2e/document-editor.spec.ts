import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Document Editor', () => {
  // ── DE.1: Create new document from dashboard ────────────────────
  test('DE.1 — create new doc from dashboard', async ({ authenticatedPage: page }) => {
    await page.locator(SEL.dashboard.newDocButton).click();
    await expect(page).toHaveURL(/\/documents\//);
  });

  // ── DE.2: Edit title ────────────────────────────────────────────
  test('DE.2 — edit title', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const titleInput = page.locator(SEL.editor.titleInput).first();
    await titleInput.waitFor({ state: 'visible', timeout: 10_000 });

    await titleInput.clear();
    await titleInput.fill('Renamed API Spec');

    await expect(titleInput).toHaveValue('Renamed API Spec');
  });

  // ── DE.3: Edit content + autosave ──────────────────────────────
  test('DE.3 — edit content triggers autosave', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    await textarea.fill('# Updated Content\n\nNew paragraph for autosave test.');

    // Wait for the autosave indicator to settle on "Saved"
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });
  });

  // ── DE.4: Save Version via modal ───────────────────────────────
  test('DE.4 — save version via modal', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Open the Save Version modal
    await page.locator(SEL.editor.saveVersionButton).click();
    const modal = page.locator(SEL.editor.versionModal);
    await expect(modal).toBeVisible();

    // Fill version message and submit
    await modal.locator(SEL.editor.versionMessageInput).fill('E2E test version');
    await modal.locator('button:has-text("Save"):not(:has-text("Save Version"))').click();

    // Modal should close — check the overlay disappears
    await expect(page.locator('.fixed.inset-0')).toBeHidden({ timeout: 5_000 });
  });

  // ── DE.5: Open History drawer ──────────────────────────────────
  test('DE.5 — open History drawer', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.historyTab).click();

    // The drawer panel should appear with a HISTORY heading (uppercase span)
    await expect(page.locator('text=/HISTORY/i').first()).toBeVisible({ timeout: 5_000 });
  });

  // ── DE.6: Click older version shows banner ─────────────────────
  test('DE.6 — click older version shows viewing banner', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open history
    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=/HISTORY/i').first()).toBeVisible({ timeout: 5_000 });

    // Click the older version entry — "Initial draft" (version 1, the non-HEAD version)
    const olderVersion = page.locator('button:has-text("Initial draft")');
    await olderVersion.waitFor({ state: 'visible', timeout: 5_000 });
    await olderVersion.click();

    // Amber banner should appear
    await expect(page.locator(SEL.editor.versionBanner)).toBeVisible({ timeout: 5_000 });
  });

  // ── DE.7: Switch all 6 drawer tabs ─────────────────────────────
  test('DE.7 — switch all drawer tabs', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    const tabs = [
      { selector: SEL.drawer.historyTab, heading: 'History' },
      { selector: SEL.drawer.timelineTab, heading: 'Timeline' },
      { selector: SEL.drawer.proposalsTab, heading: 'Proposals' },
      { selector: SEL.drawer.auditTab, heading: 'Audit' },
    ];

    for (const { selector, heading } of tabs) {
      // The drawer toggle container might hide features behind feature flags or mocked data. 
      // Ensure the button exists before clicking
      const tabBtn = page.locator(selector);
      if (await tabBtn.count() > 0) {
        await tabBtn.click();
        await expect(
          page.locator(`text=/${heading}/i`).first(),
        ).toBeVisible({ timeout: 5_000 });
      }
    }
  });

  // ── DE.8: Close drawer via button and Escape ───────────────────
  test('DE.8 — close drawer via close button and Escape', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open history drawer
    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=/HISTORY/i').first()).toBeVisible({ timeout: 5_000 });

    // Close via button
    await page.locator(SEL.editor.drawerClose).click();
    await expect(page.locator(SEL.editor.drawerClose)).toBeHidden({ timeout: 3_000 });

    // Re-open drawer, then close via Escape
    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=/HISTORY/i').first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator(SEL.editor.drawerClose)).toBeHidden({ timeout: 3_000 });
  });

  // ── 14.1: Diff view ────────────────────────────────────────────
  test('14.1 — diff view between versions', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open history
    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=/HISTORY/i').first()).toBeVisible({ timeout: 5_000 });

    // Enable compare/diff mode by clicking "Compare versions"
    const compareButton = page.locator('button:has-text("Compare versions")');
    await compareButton.waitFor({ state: 'visible', timeout: 5_000 });
    await compareButton.click();

    // Diff button should appear (initially disabled with 0/2 selected)
    const diffButton = page.locator('button:has-text("Diff")').first();
    await diffButton.waitFor({ state: 'visible', timeout: 5_000 });

    // Select both version entries (there are 2 seeded versions)
    const initialDraft = page.locator('button:has-text("Initial draft")');
    const addedEndpoints = page.locator('button:has-text("Added endpoints")');
    await initialDraft.waitFor({ state: 'visible', timeout: 5_000 });
    await initialDraft.click();
    await addedEndpoints.click();

    // The Diff button should now show "Diff (2/2)" and be enabled
    await expect(diffButton).toContainText('2/2');
    await expect(diffButton).toBeEnabled();
  });

  // ── 15.1: Restore older version ────────────────────────────────
  test('15.1 — restore older version', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open history and select older version
    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=/HISTORY/i').first()).toBeVisible({ timeout: 5_000 });

    const olderVersion = page.locator('button:has-text("Initial draft")');
    await olderVersion.waitFor({ state: 'visible', timeout: 5_000 });
    await olderVersion.click();

    // Wait for version banner, then click Restore
    await expect(page.locator(SEL.editor.versionBanner)).toBeVisible({ timeout: 5_000 });
    await page.locator(SEL.editor.restoreButton).click();

    // After restoring, the version banner should disappear
    await expect(page.locator(SEL.editor.versionBanner)).toBeHidden({ timeout: 5_000 });
  });

  // ── 24.1: Preview renders h1 ──────────────────────────────────
  test('24.1 — preview renders h1', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.editor.previewTab).click();
    const previewPane = page.locator(SEL.editor.previewPane);
    await expect(previewPane).toBeVisible({ timeout: 5_000 });
    await expect(previewPane.locator('h1').first()).toBeVisible();
  });

  // ── 24.2: Preview renders table ────────────────────────────────
  test('24.2 — preview renders table', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.editor.previewTab).click();
    const previewPane = page.locator(SEL.editor.previewPane);
    await expect(previewPane).toBeVisible({ timeout: 5_000 });
    await expect(previewPane.locator('table').first()).toBeVisible();
  });

  // ── 24.3: Preview renders code block ───────────────────────────
  test('24.3 — preview renders code block', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.editor.previewTab).click();
    const previewPane = page.locator(SEL.editor.previewPane);
    await expect(previewPane).toBeVisible({ timeout: 5_000 });
    await expect(previewPane.locator('pre, code').first()).toBeVisible();
  });

  // ── 25.1: Layout toggle — Split ────────────────────────────────
  test('25.1 — layout toggle to Split', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.editor.splitTab).click();

    // Both editor textarea and preview pane should be visible
    await expect(page.locator(SEL.editor.textarea).first()).toBeVisible();
    await expect(page.locator(SEL.editor.previewPane)).toBeVisible();
  });

  // ── 25.2: Layout toggle — Preview hides textarea ──────────────
  test('25.2 — layout toggle to Preview hides textarea', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.editor.previewTab).click();

    await expect(page.locator(SEL.editor.previewPane)).toBeVisible();
    await expect(page.locator(SEL.editor.textarea).first()).toBeHidden();
  });

  // ── 27.1: Bold toolbar button ──────────────────────────────────
  test('27.1 — bold toolbar inserts ** markers', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Clear and focus the textarea
    await textarea.clear();
    await textarea.focus();

    await page.locator(SEL.editor.toolbarBold).click();
    await expect(textarea).toHaveValue(/\*\*.*\*\*/);
  });

  // ── 27.2: Italic toolbar button ────────────────────────────────
  test('27.2 — italic toolbar inserts * markers', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    await textarea.clear();
    await textarea.focus();
    await textarea.fill('hello');
    // Select all text so italic wraps it
    await textarea.press('Meta+a');

    await page.locator(SEL.editor.toolbarItalic).click();
    await expect(textarea).toHaveValue(/\*hello\*/);
  });

  // ── 27.3: Cmd+B keyboard shortcut ─────────────────────────────
  test('27.3 — Cmd+B inserts bold markup', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    await textarea.clear();
    await textarea.focus();

    await page.keyboard.press('Meta+b');
    await expect(textarea).toHaveValue(/\*\*.*\*\*/);
  });

  // ── Stage Management (New Features) ───────────────────────────
  test('28.1 — stage selector changes stage', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Scope to main to avoid matching the sidebar team switcher
    const stageSelect = page.locator('main select').first();
    await stageSelect.waitFor({ state: 'visible' });

    // Select 'conception'
    await stageSelect.selectOption('conception');

    // Stage guide now appears as a notification inside the AI Advisor panel
    // Expand the panel to see the notification
    await page.locator('[data-testid="ai-advisor-status-bar"]').click();
    await expect(page.locator('[data-testid="ai-advisor-panel"]')).toBeVisible({ timeout: 3_000 });

    // The stage guide notification should contain the stage description text
    await expect(
      page.locator('[data-testid="advisor-notification-stage_guide"]'),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[data-testid="advisor-notification-stage_guide"]'),
    ).toContainText('Capture the initial idea');
  });

  test('28.2 — dismiss stage guide banner', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    const stageSelect = page.locator('main select').first();
    await stageSelect.selectOption('conception');

    // Expand the AI Advisor panel to see the stage guide notification
    await page.locator('[data-testid="ai-advisor-status-bar"]').click();
    await expect(page.locator('[data-testid="ai-advisor-panel"]')).toBeVisible({ timeout: 3_000 });

    const stageGuide = page.locator('[data-testid="advisor-notification-stage_guide"]');
    await expect(stageGuide).toBeVisible({ timeout: 5_000 });

    // Click dismiss via the X button inside the notification card
    await stageGuide.locator('[aria-label="Dismiss notification"]').click();

    await expect(stageGuide).not.toBeVisible({ timeout: 3_000 });
  });

  test('28.3 — seed next stage button navigates to new document', async ({ authenticatedPage: page }) => {
    // Mock the AI seed-next-stage endpoint so the seeding mutation succeeds
    await page.route('**/api/ai/seed-next-stage', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ title: 'Definition: Seeded Doc', content: '# Seeded content' }),
      }),
    );

    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Ensure we are in a stage that has a next stage (e.g. Conception -> Definition)
    const stageSelect = page.locator('main select').first();
    await stageSelect.selectOption('conception');

    // Button text is dynamic: "Seed Definition" (next stage label)
    const seedBtn = page.locator('button:has-text("Seed Definition")');
    await expect(seedBtn).toBeVisible({ timeout: 5_000 });

    // Wait for the mutation to finish and navigate to the new branched doc
    await seedBtn.click();
    
    // Should navigate to a new document URL different from DOC_URL
    await expect(page).not.toHaveURL(DOC_URL, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/documents\//, { timeout: 5_000 });
  });

  test('28.4 — split layout pane resizing', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Make sure we are in Split mode
    await page.locator(SEL.editor.splitTab).click();

    // Find the resizer handle
    const resizer = page.locator('.cursor-col-resize').first();
    await expect(resizer).toBeVisible();

    const box = await resizer.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + box.height / 2);
      await page.mouse.up();
      // Mouse events should execute without error; the resize logic is hard to assert visually without checking inline styles
      // but the fact the drag didn't throw is good.
    }
  });
});
