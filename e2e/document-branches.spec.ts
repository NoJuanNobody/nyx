import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe.serial('Document Branches', () => {
  // Branch creation/merge UI is not yet implemented — skip until the feature is built
  test.skip('16.1 — create branch from version', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=History').first()).toBeVisible({ timeout: 5_000 });

    const branchButton = page.locator(
      'button:has-text("Branch"), button:has-text("Create Branch"), button[title*="Branch"]',
    ).first();
    await branchButton.waitFor({ state: 'visible', timeout: 5_000 });
    await branchButton.click();

    const branchNameInput = page.locator(
      'input[placeholder*="ranch"], input[placeholder*="name"], div[role="dialog"] input[type="text"]',
    ).first();
    const hasInput = await branchNameInput.isVisible().catch(() => false);
    if (hasInput) {
      await branchNameInput.fill('e2e-test-branch');
      const confirmButton = page.locator(
        'div[role="dialog"] button:has-text("Create"), button:has-text("Confirm"), button:has-text("Save")',
      ).first();
      await confirmButton.click();
    }

    await expect(
      page.locator('text=/[Bb]ranch created|e2e-test-branch|[Bb]ranch/').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test.skip('16.2 — edit branch content', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=History').first()).toBeVisible({ timeout: 5_000 });

    const branchEntry = page.locator(
      'button:has-text("e2e-test-branch"), [role="button"]:has-text("e2e-test-branch"), text=e2e-test-branch',
    ).first();
    const branchVisible = await branchEntry.isVisible().catch(() => false);
    if (branchVisible) {
      await branchEntry.click();
    }

    const textarea = page.locator(SEL.editor.textarea).first();
    await textarea.waitFor({ state: 'visible' });
    const originalValue = await textarea.inputValue();
    await textarea.fill(originalValue + '\n\n## Branch Edit\n\nAdded from e2e branch test.');

    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });
  });

  test.skip('16.3 — view branch diff', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=History').first()).toBeVisible({ timeout: 5_000 });

    const diffButton = page.locator('button:has-text("Diff"), button:has-text("Compare")').first();
    await diffButton.waitFor({ state: 'visible', timeout: 5_000 });
    await diffButton.click();

    await expect(
      page.locator('.diff, [class*="diff"], ins, del, [class*="added"], [class*="removed"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test.skip('16.4 — merge branch', async ({ authenticatedPage: page }) => {
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.historyTab).click();
    await expect(page.locator('text=History').first()).toBeVisible({ timeout: 5_000 });

    const mergeButton = page.locator(
      'button:has-text("Merge"), button:has-text("Approve"), button[title*="Merge"]',
    ).first();
    await mergeButton.waitFor({ state: 'visible', timeout: 5_000 });
    await mergeButton.click();

    const confirmMerge = page.locator(
      'div[role="dialog"] button:has-text("Merge"), div[role="dialog"] button:has-text("Confirm")',
    ).first();
    const hasConfirm = await confirmMerge.isVisible().catch(() => false);
    if (hasConfirm) {
      await confirmMerge.click();
    }

    await expect(
      page.locator('text=/[Mm]erged|[Ss]uccess|[Bb]ranch merged/').first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
