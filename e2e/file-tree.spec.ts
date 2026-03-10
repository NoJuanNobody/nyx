import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('File Tree', () => {
  // ── 26.1: File tree shows seeded documents ──────────────────────
  test('26.1 — file tree shows seeded documents', async ({ authenticatedPage: page }) => {
    // authenticatedPage starts on /dashboard — sidebar should have file tree
    // "Architecture Overview" and "Quick Start" are at root level (path="/"), visible immediately
    // "API Specification" is inside the collapsed /api folder, so it won't be visible without expanding
    await expect(page.locator('aside').locator('text=Architecture Overview')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('aside').locator('text=Quick Start')).toBeVisible({ timeout: 10_000 });
  });

  // ── 26.2: Create folder via context menu ────────────────────────
  test('26.2 — create folder via context menu', async ({ authenticatedPage: page }) => {
    // Use the New folder button in the sidebar header
    await page.locator(SEL.sidebar.newFolderButton).click();

    // An input should appear for the folder name (no type attribute on the inline input)
    const folderInput = page.locator('aside input').first();
    await expect(folderInput).toBeVisible({ timeout: 5_000 });
    await folderInput.fill('Test Folder');
    await folderInput.press('Enter');

    // Verify the new folder appears in the tree
    await expect(page.locator('aside').locator('text=Test Folder')).toBeVisible({ timeout: 5_000 });
  });

  // ── 26.3: Create document ─────────────────────────────────────
  test('26.3 — create new document', async ({ authenticatedPage: page }) => {
    // Use the New document button in the sidebar
    await page.locator(SEL.sidebar.newDocButton).click();

    // Should navigate to a new document editor
    await expect(page).toHaveURL(/\/documents\//, { timeout: 5_000 });

    // The editor should be ready
    const titleInput = page.locator(SEL.editor.titleInput).first();
    await titleInput.waitFor({ state: 'visible', timeout: 10_000 });

    await titleInput.fill('Document in Folder');
    await expect(titleInput).toHaveValue('Document in Folder');
  });

  // ── 26.4: Expand and collapse folders ───────────────────────────
  test('26.4 — expand and collapse folders', async ({ authenticatedPage: page }) => {
    // Wait for file tree to load — root-level docs should be visible
    await expect(page.locator('aside').locator('text=Architecture Overview')).toBeVisible({ timeout: 10_000 });

    // The /api folder is rendered as a clickable <div> (not a button), find it by its name text
    const folderRow = page.locator('aside div.cursor-pointer').filter({ hasText: /^api$/ }).first();
    await expect(folderRow).toBeVisible({ timeout: 5_000 });

    // "API Specification" should NOT be visible yet (folder is collapsed by default)
    await expect(page.locator('aside').locator('text=API Specification')).toBeHidden();

    // Click to expand the /api folder
    await folderRow.click();
    // Now "API Specification" should be visible
    await expect(page.locator('aside').locator('text=API Specification')).toBeVisible({ timeout: 5_000 });

    // Click again to collapse
    await folderRow.click();
    // "API Specification" should be hidden again
    await expect(page.locator('aside').locator('text=API Specification')).toBeHidden({ timeout: 5_000 });
  });

  // ── 26.4b: Delete a document moves it to Trash ──────────────────
  test('26.4b — delete document moves it to Trash', async ({ authenticatedPage: page }) => {
    // Wait for file tree to load
    await expect(page.locator('aside').locator('text=Architecture Overview')).toBeVisible({ timeout: 10_000 });

    // Hover over a document to reveal the delete button
    const docRow = page.locator('aside').locator('text=Architecture Overview');
    await docRow.hover();

    const deleteButton = page.locator('aside button[title="Delete"]').first();
    await expect(deleteButton).toBeVisible({ timeout: 3_000 });
    await deleteButton.click();

    // The document should disappear from the active file tree
    await expect(page.locator('aside').locator('text=Architecture Overview')).toBeHidden({ timeout: 5_000 });

    // Open Trash and verify it moved there
    const trashToggle = page.locator(SEL.fileTree.trashToggle);
    await trashToggle.click();
    await expect(page.locator('aside').locator('text=Architecture Overview')).toBeVisible({ timeout: 5_000 });
  });

  // ── 26.5: Archived doc visible in Trash section ─────────────────
  test('26.5 — archived doc visible in Trash section', async ({ authenticatedPage: page }) => {
    // Click the Trash toggle to expand the trash section
    const trashToggle = page.locator(SEL.fileTree.trashToggle);
    await expect(trashToggle).toBeVisible({ timeout: 5_000 });
    await trashToggle.click();

    // Verify the seeded archived document appears
    await expect(
      page.locator('aside').locator('text=Deprecated Guide'),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── 26.6: Restore document from Trash ───────────────────────────
  test('26.6 — restore document from Trash', async ({ authenticatedPage: page }) => {
    // Open the Trash section
    const trashToggle = page.locator(SEL.fileTree.trashToggle);
    await expect(trashToggle).toBeVisible({ timeout: 5_000 });
    await trashToggle.click();

    // Find the deprecated doc trash row — it's a <div> containing the doc title with line-through
    const trashRow = page.locator('aside div').filter({ hasText: 'Deprecated Guide' }).last();
    await expect(trashRow).toBeVisible({ timeout: 5_000 });

    // Hover the row to reveal the Restore button (React state toggles on mouseEnter)
    await trashRow.hover();
    const restoreButton = trashRow.locator('button[title="Restore"]');
    await expect(restoreButton).toBeVisible({ timeout: 3_000 });
    await restoreButton.click();

    // After restoring, the document should no longer be in trash
    await expect(page.locator('aside').locator('text=Deprecated Guide')).toBeHidden({ timeout: 5_000 });
  });
});
