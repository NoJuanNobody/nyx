import { test, expect } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

/**
 * Regression for #333: dark-mode buttons must not render
 * white text on a white background.
 *
 * The historical bug: bg-slate-900 + text-white primary buttons
 * (e.g. "+ New Repository" on /repositories) inherited the slate
 * variable swap in dark mode, which remapped --color-slate-900 to
 * a near-white surface. Combined with the .dark .text-white rule,
 * the button rendered as white-on-white and was effectively invisible.
 */
test.describe('Dark mode button contrast (#333)', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    // Mock the GitHub integration + synced repos so the Repositories
    // page enters its "with repos" branch where the "+ New Repository"
    // primary button renders.
    await page.route('**/api/integrations/*/github/synced-repos', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repos: [
            {
              owner: 'nyx',
              name: 'app',
              fullName: 'nyx/app',
              syncStatus: 'active',
              webhookId: 12345,
              lastPushAt: '2025-01-15T10:30:00Z',
              linkedDocCount: 2,
            },
          ],
          webhookRegistrationEnabled: true,
        }),
      }),
    );

    // Switch to dark mode by clicking the theme toggle until the
    // <html> element has the `dark` class. The toggle cycles
    // System -> Dark -> Light, so a single click from System lands
    // on Dark in the seeded test environment.
    await page.goto('/repositories');
    const toggle = page.locator(SEL.sidebar.themeToggle);
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('+ New Repository button has visible text in dark mode', async ({
    authenticatedPage: page,
  }) => {
    const button = page.locator('[data-testid="create-repo-button"]').first();
    await expect(button).toBeVisible({ timeout: 10_000 });

    const styles = await button.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        color: cs.color,
      };
    });

    // Background and text must not both be white.
    const isWhite = (rgb: string) => {
      const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return r > 240 && g > 240 && b > 240;
    };

    expect(
      isWhite(styles.backgroundColor) && isWhite(styles.color),
      `button rendered white-on-white in dark mode (#333). bg=${styles.backgroundColor} fg=${styles.color}`,
    ).toBe(false);

    // And the two colors must be distinct enough to be perceivable —
    // a strict guard against any future regression that lands them at
    // the same value via a different code path.
    expect(styles.backgroundColor).not.toBe(styles.color);
  });
});
