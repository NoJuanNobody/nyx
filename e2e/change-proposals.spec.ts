import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Change Proposals', () => {
  // ── 13.1: Generate proposal ─────────────────────────────────────
  test('13.1 — generate proposal shows card with title', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open Proposals drawer
    await page.locator(SEL.drawer.proposalsTab).click();
    await expect(
      page.locator('text=/PROPOSALS/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Click Generate
    await page.locator('button:has-text("Generate")').click();

    // Verify the proposal card appears with the mocked title
    await expect(
      page.locator('text=Add authentication section'),
    ).toBeVisible({ timeout: 10_000 });

    // Verify the description is also present
    await expect(
      page.locator('text=/missing authentication details/i'),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── 13.2: Approve proposal ──────────────────────────────────────
  test('13.2 — approve proposal', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.proposalsTab).click();
    await expect(
      page.locator('text=/PROPOSALS/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.locator('button:has-text("Generate")').click();
    await expect(page.locator('text=Add authentication section')).toBeVisible({ timeout: 10_000 });

    // Click the proposal card to expand it (reveals Approve/Reject buttons)
    await page.locator('text=Add authentication section').click();

    // Click Approve on the proposal card
    const approveButton = page.locator('button:has-text("Approve")').first();
    await expect(approveButton).toBeVisible({ timeout: 5_000 });
    await approveButton.click();

    // Verify the proposal status changes — approved state indicator
    await expect(
      page.locator('text=/[Aa]pproved/').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── 13.3: Reject proposal ──────────────────────────────────────
  test('13.3 — reject proposal', async ({ authenticatedPage: page, mockAI }) => {
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.proposalsTab).click();
    await expect(
      page.locator('text=/PROPOSALS/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    await page.locator('button:has-text("Generate")').click();
    await expect(page.locator('text=Add authentication section')).toBeVisible({ timeout: 10_000 });

    // Click the proposal card to expand it
    await page.locator('text=Add authentication section').click();

    // Click Reject on the proposal card
    const rejectButton = page.locator('button:has-text("Reject")').first();
    await expect(rejectButton).toBeVisible({ timeout: 5_000 });
    await rejectButton.click();

    // Verify the proposal status changes — rejected state indicator
    await expect(
      page.locator('text=/[Rr]ejected/').first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ── 13.4: Push approved proposals as tickets ────────────────────
  test('13.4 — push approved proposals as tickets', async ({ authenticatedPage: page, mockAI, mockGitHub }) => {
    await mockAI(page);
    await mockGitHub(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(SEL.drawer.proposalsTab).click();
    await expect(
      page.locator('text=/PROPOSALS/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Generate and expand the proposal
    await page.locator('button:has-text("Generate")').click();
    await expect(page.locator('text=Add authentication section')).toBeVisible({ timeout: 10_000 });
    await page.locator('text=Add authentication section').click();

    // Approve
    await page.locator('button:has-text("Approve")').first().click();
    await expect(page.locator('text=/[Aa]pproved/').first()).toBeVisible({ timeout: 5_000 });

    // Push as tickets
    await page.locator('button:has-text("Push as Tickets")').click();

    // Verify success feedback — the proposal status badge flips to "pushed"
    // after the tickets are created. Avoid matching "Create Ticket" on the
    // toolbar (hidden below 1400px) or "Push as Tickets" on the button.
    await expect(
      page.locator('text=/\\bpushed\\b|\\bsuccess\\b|github\\.com/i').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
