import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Theme toggle', () => {
  test('30b.1: Toggle to dark mode', async ({ authenticatedPage: page }) => {
    const toggle = page.locator(SEL.sidebar.themeToggle);
    await expect(toggle).toBeVisible();

    // Click until we land on dark mode (cycle: System -> Dark -> Light)
    // First click from System should go to Dark
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('30b.2: Toggle to light mode', async ({ authenticatedPage: page }) => {
    const toggle = page.locator(SEL.sidebar.themeToggle);

    // Click twice: System -> Dark -> Light
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await toggle.click();
    // Light mode — html should NOT have the "dark" class
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('30b.3: System mode respects prefers-color-scheme', async ({ authenticatedPage: page }) => {
    // Emulate dark color scheme at OS level
    await page.emulateMedia({ colorScheme: 'dark' });

    // Clear any stored theme to fall back to system
    await page.evaluate(() => localStorage.removeItem('theme'));
    await page.reload();
    await page.waitForSelector(SEL.sidebar.logo, { timeout: 15_000 });

    // With system preference set to dark, html should get the dark class
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('30b.4: Theme persists across reload', async ({ authenticatedPage: page }) => {
    const toggle = page.locator(SEL.sidebar.themeToggle);

    // Set dark mode
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Reload and verify dark mode is still active
    await page.reload();
    await page.waitForSelector(SEL.sidebar.logo, { timeout: 15_000 });
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
