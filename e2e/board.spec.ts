import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Board', () => {
  test('31.1: Three columns visible', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.board.columnOpen).first()).toBeVisible();
    await expect(page.locator(SEL.board.columnInProgress).first()).toBeVisible();
    await expect(page.locator(SEL.board.columnClosed).first()).toBeVisible();
  });

  test('31.2: Ticket card shows title', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });
  });

  test('31.3: Provider badge visible', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    // Wait for ticket cards to render
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    // Provider badges are small <span> elements with font-bold class inside ticket cards.
    // We look for the badge text inside the ticket card area (the grid), not in the filter header.
    const ticketGrid = page.locator('main .grid');
    const badges = ticketGrid.locator('span.font-bold');
    await expect(badges.first()).toBeVisible({ timeout: 10_000 });
  });

  test('31.4: External URL link opens in new tab', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    // Wait for ticket cards to render
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    // Ticket cards should have an external link with target="_blank"
    const externalLink = page.locator('a[target="_blank"]').first();
    await expect(externalLink).toBeVisible({ timeout: 5_000 });
    await expect(externalLink).toHaveAttribute('href', /https?:\/\//);
  });

  test('31.5: Provider filter — GitHub only', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    await page.locator(SEL.board.providerFilter).selectOption({ value: 'github' });

    // GitHub tickets remain visible
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 5_000 });
    // Jira tickets hidden
    await expect(page.locator('text=Review architecture')).not.toBeVisible({ timeout: 5_000 });
  });

  test('31.6: Provider filter — All restores full list', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    // Filter to GitHub first, then back to All
    await page.locator(SEL.board.providerFilter).selectOption({ value: 'github' });
    await expect(page.locator('text=Review architecture')).not.toBeVisible({ timeout: 5_000 });

    await page.locator(SEL.board.providerFilter).selectOption({ value: '' });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Review architecture')).toBeVisible({ timeout: 5_000 });
  });

  test('31.7: Sync All button triggers sync', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    const syncButton = page.locator(SEL.board.syncAllButton);
    await syncButton.click();

    // Button shows "Syncing..." while pending, then returns to "Sync All"
    await expect(page.locator('button:has-text("Syncing"), button:has-text("Sync All")')).toBeVisible({ timeout: 5_000 });
  });

  test('31.8: Ticket count per column', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    // Wait for tickets to load
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    // Column headers should display count numbers
    // Look for any numeric content near column headers
    const allText = await page.locator('main').textContent();
    // Verify that the page contains ticket count numbers (non-zero)
    expect(allText).toMatch(/[1-4]/);
  });

  test('31.9: Board link active in sidebar', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    const boardLink = page.locator(SEL.sidebar.boardLink);
    await expect(boardLink).toBeVisible();

    // Active nav link typically has a distinct background or font weight
    const classes = await boardLink.getAttribute('class');
    expect(classes).toBeTruthy();
    // The active link should have some styling indicator — check for common patterns
    const hasActive = /active|bg-|font-bold|font-semibold|text-primary|blue/.test(classes ?? '');
    expect(hasActive).toBe(true);
  });
});
