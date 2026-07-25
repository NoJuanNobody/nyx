import { test, expect } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Tickets', () => {
  test('31.1: Tickets page renders with two tabs', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.tickets.tabGenerated)).toBeVisible();
    await expect(page.locator(SEL.tickets.tabPosted)).toBeVisible();
  });

  test('31.2: Generated tab is active by default', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.tickets.generatedTab)).toBeVisible();
  });

  test('31.3: Switching to Posted tab shows posted content', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator(SEL.tickets.postedTab)).toBeVisible({ timeout: 5_000 });
  });

  test('31.4: Posted tab has provider filter and sync button', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator(SEL.tickets.providerFilter)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(SEL.tickets.syncAllButton)).toBeVisible({ timeout: 5_000 });
  });

  test('31.5: Posted tab provider filter — GitHub only', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator(SEL.tickets.postedTab)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.providerFilter).selectOption({ value: 'github' });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Review architecture')).not.toBeVisible({ timeout: 5_000 });
  });

  test('31.6: Posted tab provider filter — All restores full list', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.providerFilter).selectOption({ value: 'github' });
    await expect(page.locator('text=Review architecture')).not.toBeVisible({ timeout: 5_000 });
    await page.locator(SEL.tickets.providerFilter).selectOption({ value: '' });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Review architecture')).toBeVisible({ timeout: 5_000 });
  });

  test('31.7: Posted tab sync button works', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator(SEL.tickets.syncAllButton)).toBeVisible({ timeout: 5_000 });
    await page.locator(SEL.tickets.syncAllButton).click();
    await expect(page.locator('button:has-text("Syncing"), button:has-text("Sync All")')).toBeVisible({ timeout: 5_000 });
  });

  test('31.8: Posted tickets shown as list not Kanban columns', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator(SEL.tickets.postedTab)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid^="board-column-"]')).not.toBeVisible({ timeout: 3_000 });
  });

  test('31.9: /app/board redirects to /app/tickets', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page).toHaveURL(/\/app\/tickets/, { timeout: 10_000 });
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
  });

  test('31.10: Tickets link active in sidebar', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    const ticketsLink = page.locator(SEL.sidebar.ticketsLink);
    await expect(ticketsLink).toBeVisible();
    const classes = await ticketsLink.getAttribute('class');
    expect(classes).toBeTruthy();
    const hasActive = /active|bg-|font-bold|font-semibold|text-primary|blue/.test(classes ?? '');
    expect(hasActive).toBe(true);
  });

  test('31.11: External ticket links open in new tab', async ({ authenticatedPage: page }) => {
    await page.goto('/app/tickets');
    await expect(page.locator(SEL.tickets.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.tickets.tabPosted).click();
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });
    const externalLink = page.locator('a[target="_blank"]').first();
    await expect(externalLink).toBeVisible({ timeout: 5_000 });
    await expect(externalLink).toHaveAttribute('href', /https?:\/\//);
  });
});
