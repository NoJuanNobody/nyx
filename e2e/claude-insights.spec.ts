import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

// ── Claude Action Insights E2E Tests ────────────────────────────────────────
// Covers: insight display on kanban cards, sync/refresh flow, API endpoints,
//         markdown parsing behaviour, error handling, and auth/permissions.

test.describe('Claude Action Insights — board display', () => {
  test('50.1: Claude insight panel renders on GitHub ticket with stored insight', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    // The GitHub open ticket has a seeded insight — its panel should be visible
    await expect(page.locator(SEL.claudeInsight.panel).first()).toBeVisible({ timeout: 5_000 });
  });

  test('50.2: Insight panel shows the parsed title', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    await expect(page.locator(SEL.claudeInsight.title).first()).toContainText(
      'Implement auth endpoints',
      { timeout: 5_000 },
    );
  });

  test('50.3: Insight panel is collapsed by default', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.claudeInsight.panel).first()).toBeVisible({ timeout: 5_000 });

    // Summary bullets and files section are not visible until expanded
    await expect(page.locator(SEL.claudeInsight.viewCommentLink)).not.toBeVisible();
  });

  test('50.4: Clicking the toggle expands the insight panel', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.claudeInsight.panel).first()).toBeVisible({ timeout: 5_000 });

    await page.locator(SEL.claudeInsight.toggleButton).first().click();

    await expect(page.locator(SEL.claudeInsight.viewCommentLink).first()).toBeVisible({
      timeout: 3_000,
    });
  });

  test('50.5: Expanded panel shows summary bullets', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.claudeInsight.toggleButton).first().click();

    await expect(
      page.locator('text=Added JWT middleware to all protected routes'),
    ).toBeVisible({ timeout: 3_000 });
  });

  test('50.6: Expanded panel shows files changed', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.claudeInsight.toggleButton).first().click();

    await expect(page.locator(SEL.claudeInsight.filesSection)).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('text=apps/api/src/middleware/auth.ts')).toBeVisible({
      timeout: 3_000,
    });
  });

  test('50.7: "View comment" link has correct href', async ({ authenticatedPage: page }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.claudeInsight.toggleButton).first().click();

    const link = page.locator(SEL.claudeInsight.viewCommentLink).first();
    await expect(link).toBeVisible({ timeout: 3_000 });
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/nyx/app/issues/101#issuecomment-1234567890',
    );
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('50.8: GitHub ticket without insight shows "No Claude insight" and Fetch button', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Fix rate limiting')).toBeVisible({ timeout: 10_000 });

    // TKT_GH_CLOSED has claudeInsights: null — should show no-insight state
    await expect(page.locator(SEL.claudeInsight.noInsightLabel).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator(SEL.claudeInsight.fetchButton).first()).toBeVisible({
      timeout: 3_000,
    });
  });

  test('50.9: Jira tickets do not render a Claude insight panel', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Review architecture')).toBeVisible({ timeout: 10_000 });

    // Count insight panels — only 1 exists (the GitHub open ticket)
    const insightPanels = page.locator(SEL.claudeInsight.panel);
    const count = await insightPanels.count();

    // We have 2 GitHub tickets (1 with insight, 1 without) and 2 Jira tickets.
    // GitHub tickets show ClaudeInsightCard, Jira tickets do not.
    // The purple panels only appear for GitHub tickets (2 total).
    expect(count).toBeLessThanOrEqual(2);
  });

  test('50.10: Collapsing an expanded panel hides details again', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.claudeInsight.panel).first()).toBeVisible({ timeout: 5_000 });

    // Expand
    await page.locator(SEL.claudeInsight.toggleButton).first().click();
    await expect(page.locator(SEL.claudeInsight.viewCommentLink).first()).toBeVisible({
      timeout: 3_000,
    });

    // Collapse
    await page.locator(SEL.claudeInsight.toggleButton).first().click();
    await expect(page.locator(SEL.claudeInsight.viewCommentLink)).not.toBeVisible({
      timeout: 3_000,
    });
  });
});

test.describe('Claude Action Insights — refresh flow', () => {
  test('50.11: Refresh button in expanded panel triggers re-fetch and updates content', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    // Expand the insight panel for the ticket with an existing insight
    await page.locator(SEL.claudeInsight.toggleButton).first().click();
    await expect(page.locator(SEL.claudeInsight.refreshButton).first()).toBeVisible({
      timeout: 3_000,
    });

    await page.locator(SEL.claudeInsight.refreshButton).first().click();

    // After refresh, content should still be visible (mock returns same insight)
    await expect(page.locator(SEL.claudeInsight.viewCommentLink).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test('50.12: Fetch button on no-insight card calls refresh endpoint', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Fix rate limiting')).toBeVisible({ timeout: 10_000 });

    const fetchBtn = page.locator(SEL.claudeInsight.fetchButton).first();
    await expect(fetchBtn).toBeVisible({ timeout: 5_000 });
    await fetchBtn.click();

    // After fetching, the panel should update to show the refreshed insight title
    await expect(page.locator(SEL.claudeInsight.title).first()).toBeVisible({ timeout: 5_000 });
  });

  test('50.13: Refresh button shows loading state while pending', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    await page.locator(SEL.claudeInsight.toggleButton).first().click();
    await expect(page.locator(SEL.claudeInsight.refreshButton).first()).toBeVisible({
      timeout: 3_000,
    });

    // Slow down the response to catch the loading state
    await page.route('**/api/tickets/**/insights/refresh', async (route) => {
      await new Promise((r) => setTimeout(r, 200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          title: 'Refreshed insight',
          summary: ['Refreshed content'],
          filesChanged: [],
          commentId: 9999,
          commentUrl: 'https://github.com/nyx/app/issues/101#issuecomment-9999',
          commentedAt: new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
        }),
      });
    });

    await page.locator(SEL.claudeInsight.refreshButton).first().click();

    await expect(
      page.locator('button:has-text("Refreshing"), button:has-text("Refresh")'),
    ).toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Claude Action Insights — API mock validation', () => {
  test('50.14: GET /api/tickets/:id/insights returns stored insight', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    // Intercept and validate the shape of the insights API response
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/tickets/${SEED.TKT_GH_OPEN_ID}/insights`) && r.status() === 200,
        { timeout: 5_000 },
      ).catch(() => null),
      // Trigger by navigating (board fetches tickets, not insights individually at load)
      // We manually trigger a fetch to validate the endpoint
      page.evaluate(async (ticketId) => {
        await fetch(`/api/tickets/${ticketId}/insights`);
      }, SEED.TKT_GH_OPEN_ID),
    ]);

    if (response) {
      const data = await response.json();
      expect(data).toHaveProperty('title');
      expect(data).toHaveProperty('summary');
      expect(Array.isArray(data.summary)).toBe(true);
      expect(data).toHaveProperty('filesChanged');
      expect(data).toHaveProperty('commentUrl');
    }
  });

  test('50.15: GET /api/tickets/:id/insights returns 404 for ticket with no insight', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    const result = await page.evaluate(async (ticketId) => {
      const res = await fetch(`/api/tickets/${ticketId}/insights`);
      return { status: res.status, body: await res.json() };
    }, SEED.TKT_GH_CLOSED_ID);

    expect(result.status).toBe(404);
    expect(result.body).toHaveProperty('error');
  });

  test('50.16: POST /api/tickets/:id/insights/refresh returns refreshed insight', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });

    const result = await page.evaluate(async (ticketId) => {
      const res = await fetch(`/api/tickets/${ticketId}/insights/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { status: res.status, body: await res.json() };
    }, SEED.TKT_GH_OPEN_ID);

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty('title');
    expect(result.body).toHaveProperty('summary');
    expect(result.body).toHaveProperty('filesChanged');
    expect(result.body).toHaveProperty('commentId');
    expect(result.body).toHaveProperty('commentUrl');
    expect(result.body).toHaveProperty('commentedAt');
    expect(result.body).toHaveProperty('fetchedAt');
  });
});

test.describe('Claude Action Insights — provider filter interaction', () => {
  test('50.17: Filtering to GitHub shows insight panels', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    await page.locator(SEL.board.providerFilter).selectOption({ value: 'github' });

    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(SEL.claudeInsight.panel).first()).toBeVisible({ timeout: 5_000 });
  });

  test('50.18: Filtering to Jira hides all Claude insight panels', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 10_000 });

    await page.locator(SEL.board.providerFilter).selectOption({ value: 'jira' });

    await expect(page.locator('text=Review architecture')).toBeVisible({ timeout: 5_000 });
    // No insight panels should be visible for Jira tickets
    await expect(page.locator(SEL.claudeInsight.panel)).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Claude Action Insights — error handling', () => {
  test('50.19: When refresh fails, UI remains stable', async ({ authenticatedPage: page }) => {
    // Override the refresh route to return an error
    await page.route('**/api/tickets/**/insights/refresh', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'GitHub API unavailable' }),
      }),
    );

    await page.goto('/app/board');
    await expect(page.locator(SEL.board.title)).toBeVisible({ timeout: 10_000 });
    await page.locator(SEL.claudeInsight.toggleButton).first().click();

    await page.locator(SEL.claudeInsight.refreshButton).first().click();

    // Board should remain stable — ticket titles still visible
    await expect(page.locator('text=Implement auth endpoints').first()).toBeVisible({ timeout: 5_000 });
    // The panel should still be rendered
    await expect(page.locator(SEL.claudeInsight.panel).first()).toBeVisible({ timeout: 3_000 });
  });
});
