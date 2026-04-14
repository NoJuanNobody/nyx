import { test, expect } from './fixtures/test-base';

/**
 * Regression for #347: brand accent must render as PURPLE in light mode.
 *
 * Components throughout the app use Tailwind blue-* utilities under the
 * assumption that --color-blue-* is remapped to the brand purple. Before
 * #347 that remap lived only inside .dark, so light mode rendered actual
 * Tailwind blue. This test pins the contract: a known bg-blue-600 element
 * on /repositories must render as a purple in light mode (not blue).
 *
 * Hue check: parse the computed background-color and verify the red
 * channel is dominant over the blue channel. For brand purple
 * (≈ oklch 53% 0.23 287, ≈ #6c2cd9), red ≈ 108 and blue ≈ 217 — wait
 * that's BLUE-dominant in sRGB despite the OKLCH hue being 287°. So
 * the simple "blue not dominant" check doesn't work for any purple in
 * the violet-leaning end of the wheel. Instead we assert RED is greater
 * than GREEN (true for any purple/violet) AND that the color is NOT
 * close to pure Tailwind blue-600 (rgb(37, 99, 235)), which would imply
 * the remap silently regressed.
 */
test.describe('Light mode purple accent (#347)', () => {
  test('bg-blue-600 button on /repositories renders as purple in light mode', async ({
    authenticatedPage: page,
  }) => {
    // Mock the GitHub integration + synced repos so the Repositories
    // page enters its "with repos" branch where the "Manage Repos"
    // bg-blue-600 button renders.
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

    await page.goto('/repositories');

    // Force light mode: clear any persisted theme and ensure html
    // does not have the .dark class. The default seeded test env
    // starts in System mode; emulate light to be deterministic.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => {
      localStorage.setItem('theme', 'light');
      document.documentElement.classList.remove('dark');
    });
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    const button = page.locator('[data-testid="manage-repos-button"]').first();
    await expect(button).toBeVisible({ timeout: 10_000 });

    const bg = await button.evaluate((el) => window.getComputedStyle(el).backgroundColor);

    // Parse rgb / rgba string into channels.
    const match = bg.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/);
    expect(match, `unable to parse computed background-color: ${bg}`).not.toBeNull();
    const [r, g, b] = [Number(match![1]), Number(match![2]), Number(match![3])];

    // 1. Purple/violet always has red > green. Pure Tailwind blue-600
    //    (rgb 37, 99, 235) does NOT — green > red. This single check
    //    is enough to catch a regression to actual blue.
    expect(
      r,
      `bg-blue-600 should be PURPLE (r > g) in light mode but got rgb(${r}, ${g}, ${b}) — likely regressed to actual blue`,
    ).toBeGreaterThan(g);

    // 2. Belt-and-suspenders: not within 30 channel units of pure
    //    Tailwind blue-600 (37, 99, 235).
    const distanceToBlue600 = Math.sqrt(
      (r - 37) ** 2 + (g - 99) ** 2 + (b - 235) ** 2,
    );
    expect(
      distanceToBlue600,
      `bg-blue-600 too close to default Tailwind blue-600 in light mode: rgb(${r}, ${g}, ${b})`,
    ).toBeGreaterThan(30);

    // 3. WCAG AA contrast against white text. Compute relative luminance
    //    per https://www.w3.org/TR/WCAG21/#dfn-relative-luminance.
    const channelLum = (c: number) => {
      const cs = c / 255;
      return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
    };
    const L_bg = 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
    const L_white = 1.0;
    const contrast = (Math.max(L_bg, L_white) + 0.05) / (Math.min(L_bg, L_white) + 0.05);
    expect(
      contrast,
      `bg-blue-600 + text-white must meet WCAG AA (≥ 4.5:1), got ${contrast.toFixed(2)}:1 on rgb(${r}, ${g}, ${b})`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
