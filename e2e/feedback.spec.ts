import { test, expect } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Feedback submission', () => {
  test('should open feedback modal from sidebar', async ({ authenticatedPage: page }) => {
    await page.goto('/app/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    // Click Send Feedback button
    await page.click(SEL.feedback.sidebarButton);

    // Modal should appear
    await expect(page.locator('h2:has-text("Send Feedback")')).toBeVisible();
    await expect(page.locator(SEL.feedback.input)).toBeVisible();
    await expect(page.locator(SEL.feedback.formatButton)).toBeVisible();
  });

  test('should disable format button when input is empty', async ({ authenticatedPage: page }) => {
    await page.goto('/app/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    await page.click(SEL.feedback.sidebarButton);

    // Format button should be disabled when empty
    await expect(page.locator(SEL.feedback.formatButton)).toBeDisabled();

    // Type feedback
    await page.fill(SEL.feedback.input, 'The diff view is hard to read on mobile');

    // Format button should be enabled
    await expect(page.locator(SEL.feedback.formatButton)).toBeEnabled();
  });

  test('should close feedback modal with cancel', async ({ authenticatedPage: page }) => {
    await page.goto('/app/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    await page.click(SEL.feedback.sidebarButton);
    await expect(page.locator('h2:has-text("Send Feedback")')).toBeVisible();

    // Click Cancel
    await page.click('button:has-text("Cancel")');

    // Modal should close
    await expect(page.locator('h2:has-text("Send Feedback")')).not.toBeVisible();
  });

  test('should close feedback modal with Escape', async ({ authenticatedPage: page }) => {
    await page.goto('/app/dashboard');
    await page.waitForSelector(SEL.sidebar.logo, { state: 'visible' });

    await page.click(SEL.feedback.sidebarButton);
    await expect(page.locator('h2:has-text("Send Feedback")')).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should close
    await expect(page.locator('h2:has-text("Send Feedback")')).not.toBeVisible();
  });
});
