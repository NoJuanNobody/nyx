import { test, expect, SEED } from './fixtures/test-base';

const DOC_URL = `/app/documents/${SEED.DOC_API_SPEC_ID}`;

/**
 * E2E tests for #336 — DiffView responsive layout.
 *
 * On mobile (< md, 768px) the approve-changes diff must collapse to a
 * single unified column. On desktop (>= md) the existing two-column
 * side-by-side layout must be preserved.
 *
 * The diff is reached via the AI Advisor "Fix these" CTA, which runs an
 * AI edit through the mockAI fixture and renders <AIEditReview>.
 */
test.describe('DiffView responsive layout (#336)', () => {
  test('mobile (375x812) renders unified single-column diff', async ({
    authenticatedPage: page,
    mockAI,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });

    // Expand the AI advisor panel and wait for the quality notification
    await page.locator('[data-testid="ai-advisor-status-bar"]').click();
    await expect(
      page.locator('[data-testid="advisor-notification-quality"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Trigger the AI edit so AIEditReview / DiffView mount
    await page
      .locator('[data-testid="advisor-notification-quality"] button:has-text("Fix these")')
      .click();

    // Wait for the AI edit review toolbar
    await expect(page.locator('text=AI suggested changes')).toBeVisible({
      timeout: 10_000,
    });

    // Mobile unified container must be visible; side-by-side container hidden
    const unifiedView = page.locator('[data-testid="diff-view-unified"]');
    const sideView = page.locator('[data-testid="diff-view-side"]');
    await expect(unifiedView).toBeVisible();
    await expect(sideView).toBeHidden();

    // Mobile compact pill header visible, desktop two-column header hidden
    await expect(page.locator('[data-testid="diff-header-unified"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-header-side"]')).toBeHidden();

    // There should be at least one unified row, and zero side-by-side rows visible
    const unifiedRows = page.locator('[data-testid="diff-row-unified"]');
    const sideRows = page.locator('[data-testid="diff-row-side"]');
    expect(await unifiedRows.count()).toBeGreaterThan(0);

    // Side-by-side rows may exist in DOM (hidden md:block) but must not be visible
    const visibleSideRows = await sideRows.evaluateAll((nodes) =>
      nodes.filter((n) => {
        const r = (n as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length,
    );
    expect(visibleSideRows).toBe(0);

    // Each unified row should report a single "column" — no second flex-1 child
    const firstRow = unifiedRows.first();
    await expect(firstRow).toBeVisible();
    const flex1ChildCount = await firstRow.evaluate(
      (el) => el.querySelectorAll(':scope > .flex-1').length,
    );
    expect(flex1ChildCount).toBe(1);

    // No horizontal page overflow at 375px
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(docWidth).toBeLessThanOrEqual(375);

    // The toolbar buttons (Diff / Edit toggle, Reject, Approve) are all visible
    // and tappable without horizontal scroll
    await expect(page.locator('button:has-text("Reject")')).toBeVisible();
    const approveBtn = page.locator('button', { hasText: /Approve/ });
    await expect(approveBtn).toBeVisible();
    await expect(page.locator('button:has-text("Diff")')).toBeVisible();
    await expect(page.locator('button:has-text("Edit")')).toBeVisible();
  });

  test('desktop (1280x800) renders side-by-side two-column diff', async ({
    authenticatedPage: page,
    mockAI,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockAI(page);
    await page.goto(DOC_URL);
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });

    // Expand panel and wait for quality notification
    await page.locator('[data-testid="ai-advisor-status-bar"]').click();
    await expect(
      page.locator('[data-testid="advisor-notification-quality"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Trigger the AI edit
    await page
      .locator('[data-testid="advisor-notification-quality"] button:has-text("Fix these")')
      .click();

    await expect(page.locator('text=AI suggested changes')).toBeVisible({
      timeout: 10_000,
    });

    // Desktop side-by-side container visible, mobile unified hidden
    const sideView = page.locator('[data-testid="diff-view-side"]');
    const unifiedView = page.locator('[data-testid="diff-view-unified"]');
    await expect(sideView).toBeVisible();
    await expect(unifiedView).toBeHidden();

    // Two-column header visible, mobile pill header hidden
    await expect(page.locator('[data-testid="diff-header-side"]')).toBeVisible();
    await expect(page.locator('[data-testid="diff-header-unified"]')).toBeHidden();

    // At least one side-by-side row, and each row has TWO flex-1 children
    const sideRows = page.locator('[data-testid="diff-row-side"]');
    expect(await sideRows.count()).toBeGreaterThan(0);

    const firstRow = sideRows.first();
    await expect(firstRow).toBeVisible();
    const flex1ChildCount = await firstRow.evaluate(
      (el) => el.querySelectorAll(':scope > .flex-1').length,
    );
    expect(flex1ChildCount).toBe(2);

    // The two columns of the first row should be horizontally adjacent
    // (i.e. not stacked) — assert their x positions differ
    const childRects = await firstRow.evaluate((el) => {
      const children = Array.from(el.children) as HTMLElement[];
      return children.map((c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width };
      });
    });
    expect(childRects.length).toBe(2);
    expect(childRects[1].x).toBeGreaterThan(childRects[0].x);
    expect(Math.abs(childRects[1].y - childRects[0].y)).toBeLessThan(2);
  });
});
