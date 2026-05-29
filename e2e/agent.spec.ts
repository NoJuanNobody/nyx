import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Agent Integration', () => {
  test('32.1 — agent drawer opens with panel content', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Click the AI drawer tab
    await page.locator(SEL.drawer.aiTab).click();

    // Verify the drawer opened
    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });
  });

  test('32.2 — workflow list loads in agent panel', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open AI drawer
    await page.locator(SEL.drawer.aiTab).click();

    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });

    // Verify workflow selector is shown — the mock returns "Sync Spec" and "Auto Review"
    // The AgentPanel has a <select> for workflow selection, plus there may be other selects on the page
    // (e.g., stage selector in the editor toolbar). Wait for the panel to render fully.
    // The workflow select is inside the drawer panel and contains "Custom prompt..." as the first option.
    const workflowSelect = page.locator('select:has(option:text-is("Quick edit"))');
    await expect(workflowSelect).toBeVisible({ timeout: 5_000 });
    // Verify workflow options are populated
    await expect(workflowSelect.locator('option', { hasText: 'Sync Spec' })).toBeAttached({ timeout: 5_000 });
    await expect(workflowSelect.locator('option', { hasText: 'Auto Review' })).toBeAttached({ timeout: 5_000 });
  });

  test('32.3 — API key creation for agent use', async ({ authenticatedPage: page }) => {
    await page.goto('/app/settings');
    await page.locator(SEL.settings.apiKeysTab).click();

    // Fill in key name for agent usage
    await expect(page.locator(SEL.settings.keyNameInput)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.settings.keyNameInput).fill('Agent Integration Key');
    await page.locator(SEL.settings.createKeyButton).click();

    // Newly created key should display with a Copy button
    await expect(page.locator(SEL.settings.copyKeyButton)).toBeVisible({ timeout: 5_000 });
  });
});
