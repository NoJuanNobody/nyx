import { test, expect } from './fixtures/test-base';

/**
 * Regression tests for issue #340: Template picker modal trapped inside sidebar.
 *
 * The TemplatePicker uses `position: fixed` with `inset-0` to span the viewport,
 * but the Sidebar applies `md:translate-x-0` to support a mobile slide-in
 * animation. Any non-none `transform` on an ancestor creates a containing block
 * for `position: fixed` descendants — so without a portal, the modal's
 * `inset-0` resolves to the Sidebar's ~250px-wide bounding box instead of the
 * full viewport.
 *
 * The fix is to render TemplatePicker through `createPortal(document.body)` via
 * a shared <Portal /> wrapper. These tests pin the regression: the modal must
 * cover the whole viewport, the card must be `max-w-2xl` (672px), and template
 * names must render in full.
 */
test.describe('Template Picker (issue #340)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('340 — template picker is portaled and centered over the full viewport', async ({
    authenticatedPage: page,
  }) => {
    // Wait for the file tree to be ready inside the sidebar.
    await expect(page.locator('aside').locator('text=Architecture Overview')).toBeVisible({
      timeout: 10_000,
    });

    // Open the picker via the Explorer header "New from template" button.
    const newFromTemplate = page.locator('aside button[title="New from template"]');
    await expect(newFromTemplate).toBeVisible({ timeout: 5_000 });
    await newFromTemplate.click();

    // The backdrop and card should mount via the portal under <body>, not
    // inside <aside>.
    const backdrop = page.locator('[data-testid="template-picker-backdrop"]');
    const card = page.locator('[data-testid="template-picker-card"]');
    await expect(backdrop).toBeVisible({ timeout: 5_000 });
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Portal sanity check — neither node should be a descendant of <aside>.
    const backdropInAside = await backdrop.evaluate((el) => !!el.closest('aside'));
    expect(backdropInAside).toBe(false);
    const cardInAside = await card.evaluate((el) => !!el.closest('aside'));
    expect(cardInAside).toBe(false);

    // Backdrop covers the full viewport: 1280x800 (set via test.use above).
    const backdropBox = await backdrop.boundingBox();
    expect(backdropBox).not.toBeNull();
    expect(Math.round(backdropBox!.width)).toBe(1280);
    expect(Math.round(backdropBox!.height)).toBe(800);
    expect(Math.round(backdropBox!.x)).toBe(0);
    expect(Math.round(backdropBox!.y)).toBe(0);

    // Card width is max-w-2xl (672px), within ±4px tolerance for sub-pixel
    // rounding / borders.
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.width).toBeGreaterThanOrEqual(668);
    expect(cardBox!.width).toBeLessThanOrEqual(676);

    // Card is horizontally centered in the viewport (within ±2px).
    const cardCenterX = cardBox!.x + cardBox!.width / 2;
    expect(Math.abs(cardCenterX - 1280 / 2)).toBeLessThanOrEqual(2);

    // At least one template card renders its full seeded name (not truncated
    // to ~8 characters as it was when scoped to the sidebar's ~250px box).
    // "Product Requirements Document (PRD)" is wide enough that, in the
    // broken state, the visible text would be "Product…" or similar.
    await expect(
      card.locator('text=Product Requirements Document (PRD)'),
    ).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('text=Problem Statement')).toBeVisible();

    // Clicking inside the card does NOT close the modal (stopPropagation).
    await card.click({ position: { x: 10, y: 10 } });
    await expect(card).toBeVisible();

    // Backdrop click closes the modal.
    await backdrop.click({ position: { x: 5, y: 5 } });
    await expect(card).toBeHidden({ timeout: 5_000 });
  });
});
