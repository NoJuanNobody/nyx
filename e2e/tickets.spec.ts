import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

const DOC_URL = `/documents/${SEED.DOC_API_SPEC_ID}`;

test.describe('Tickets', () => {
  // ── 11.1: Create ticket from document ───────────────────────────
  test('11.1 — create ticket from document via Proposals drawer', async ({ authenticatedPage: page, mockAI, mockGitHub }) => {
    await mockAI(page);
    await mockGitHub(page);
    await page.goto(DOC_URL);
    await page.locator(SEL.editor.textarea).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open Proposals drawer
    await page.locator(SEL.drawer.proposalsTab).click();
    await expect(
      page.locator('text=/PROPOSALS/i').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Generate proposals
    await page.locator('button:has-text("Generate")').click();
    await expect(page.locator('text=Add authentication section')).toBeVisible({ timeout: 10_000 });

    // Click to expand the proposal card
    await page.locator('text=Add authentication section').click();

    // Approve the proposal first
    await page.locator('button:has-text("Approve")').first().click();
    await expect(page.locator('text=/[Aa]pproved/').first()).toBeVisible({ timeout: 5_000 });

    // Push as tickets
    await page.locator('button:has-text("Push as Tickets")').click();

    // Verify success feedback
    await expect(
      page.locator('text=/[Tt]icket|[Cc]reated|[Pp]ushed|[Ss]uccess/i').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── 11.2: Ticket appears on board ──────────────────────────────
  test('11.2 — seeded ticket visible on board', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    // Verify the seeded ticket is visible on the board
    await expect(
      page.locator('text=Implement auth endpoints').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
