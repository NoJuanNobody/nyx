import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('AI Chat Panel', () => {
  // ── 27b.1: AI Edit drawer opens ─────────────────────────────────
  test('27b.1 — AI Edit drawer opens with chat panel', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.aiTab).click();

    // Verify the drawer opened
    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });

    // The chat textarea should be visible inside the drawer
    // The AIChatPanel has a textarea with placeholder "Ask AI to edit..."
    const chatInput = page.locator('textarea[placeholder*="Ask AI"], textarea[placeholder*="Describe"]').first();
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
  });

  // ── 27b.2: Send message and receive AI response ─────────────────
  test('27b.2 — send message and receive AI response', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.aiTab).click();
    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });

    // Type a message in the chat textarea
    const chatInput = page.locator('textarea[placeholder*="Ask AI"], textarea[placeholder*="Describe"]').first();
    await chatInput.fill('Improve the error handling section');

    // Click the Send button (has title="Send", not text)
    const sendButton = page.locator('button[title="Send"]').first();
    await sendButton.click();

    // Verify AI response appears — the mock returns content and the panel shows "Changes ready for review"
    await expect(
      page.locator('text=/Changes ready|Updated Document|edited by AI|Improved/i').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── 27b.3: Click suggestion chip ────────────────────────────────
  test('27b.3 — click suggestion chip fills or sends message', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.aiTab).click();
    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });

    // Suggestion chips are buttons like "Add a section about error handling", "Rewrite the intro"
    const chips = page.locator('button').filter({ hasText: /error handling|Rewrite|code examples/i });
    const firstChip = chips.first();
    await expect(firstChip).toBeVisible({ timeout: 5_000 });

    await firstChip.click();

    // After clicking a chip, the textarea should be populated with the chip text
    const chatInput = page.locator('textarea[placeholder*="Ask AI"], textarea[placeholder*="Describe"]').first();
    const inputValue = await chatInput.inputValue();
    expect(inputValue.length).toBeGreaterThan(0);
  });

  // ── 27b.4: Clear history ────────────────────────────────────────
  test('27b.4 — clear chat history', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.aiTab).click();
    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });

    // Send a message first so there is history to clear
    const chatInput = page.locator('textarea[placeholder*="Ask AI"], textarea[placeholder*="Describe"]').first();
    await chatInput.fill('Add an overview section');

    const sendButton = page.locator('button[title="Send"]').first();
    await sendButton.click();

    // Wait for a response to appear
    await expect(
      page.locator('text=/Changes ready|Updated Document|edited by AI/i').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Click Clear button (has title="Clear chat")
    const clearButton = page.locator('button[title="Clear chat"]').first();
    await expect(clearButton).toBeVisible({ timeout: 5_000 });
    await clearButton.click();

    // Verify messages are gone — suggestion chips should reappear (empty state)
    await expect(
      page.locator('text=Add an overview section'),
    ).toBeHidden({ timeout: 5_000 });
  });

  // ── 27b.5: Escape closes drawer ────────────────────────────────
  test('27b.5 — Escape closes AI Edit drawer', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.aiTab).click();
    await expect(page.locator(SEL.editor.drawerClose)).toBeVisible({ timeout: 5_000 });

    // Press Escape to close the drawer
    await page.keyboard.press('Escape');

    // The drawer close button should no longer be visible
    await expect(page.locator(SEL.editor.drawerClose)).toBeHidden({ timeout: 3_000 });
  });
});
