import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

/** Helper to build a mock notification item. */
function mockNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    userId: SEED.DEV_USER_ID,
    teamId: SEED.DEFAULT_TEAM_ID,
    eventType: 'ticket.created',
    title: 'Ticket created: Fix auth bug',
    body: 'A new GitHub ticket was created.',
    metadata: { ticketId: 'tkt-1' },
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test.describe('Notifications', () => {
  test('T8.1: Bell shows unread count', async ({ authenticatedPage: page }) => {
    // Mock unread-count endpoint to return 3
    await page.route('**/api/notifications/unread-count', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 3 }),
      }),
    );

    // Re-navigate so the bell picks up the mock
    await page.goto('/dashboard');

    const badge = page.locator(SEL.notifications.badge);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText('3');
  });

  test('T8.2: Click bell opens panel', async ({ authenticatedPage: page }) => {
    await page.route('**/api/notifications/unread-count', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1 }),
      }),
    );

    await page.route('**/api/notifications?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [mockNotification()], nextCursor: null, unreadCount: 1 }),
      }),
    );

    await page.goto('/dashboard');

    const bell = page.locator(SEL.notifications.bell);
    await expect(bell).toBeVisible({ timeout: 10_000 });
    await bell.click();

    const panel = page.locator(SEL.notifications.panel);
    await expect(panel).toBeVisible({ timeout: 5_000 });
  });

  test('T8.3: Panel shows notification items', async ({ authenticatedPage: page }) => {
    const items = [
      mockNotification({ id: 'notif-1', title: 'Ticket created: Fix auth bug' }),
      mockNotification({ id: 'notif-2', title: 'Document updated: API Spec', eventType: 'document.updated' }),
    ];

    await page.route('**/api/notifications/unread-count', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 2 }),
      }),
    );

    await page.route('**/api/notifications?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, nextCursor: null, unreadCount: 2 }),
      }),
    );

    await page.goto('/dashboard');

    await page.locator(SEL.notifications.bell).click();
    await expect(page.locator(SEL.notifications.panel)).toBeVisible({ timeout: 5_000 });

    const notifItems = page.locator(SEL.notifications.item);
    await expect(notifItems).toHaveCount(2);
  });

  test('T8.4: Mark all as read clears badge', async ({ authenticatedPage: page }) => {
    let markedAllRead = false;

    await page.route('**/api/notifications/unread-count', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: markedAllRead ? 0 : 2 }),
      }),
    );

    await page.route('**/api/notifications?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            mockNotification({ id: 'notif-1', readAt: markedAllRead ? new Date().toISOString() : null }),
            mockNotification({ id: 'notif-2', readAt: markedAllRead ? new Date().toISOString() : null }),
          ],
          nextCursor: null,
          unreadCount: markedAllRead ? 0 : 2,
        }),
      }),
    );

    await page.route('**/api/notifications/read-all', (route) => {
      markedAllRead = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto('/dashboard');

    // Badge should show 2 initially
    const badge = page.locator(SEL.notifications.badge);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText('2');

    // Open panel and click mark all read
    await page.locator(SEL.notifications.bell).click();
    await expect(page.locator(SEL.notifications.panel)).toBeVisible({ timeout: 5_000 });

    await page.locator(SEL.notifications.markAllRead).click();

    // Badge should disappear (count is 0)
    await expect(badge).toBeHidden({ timeout: 10_000 });
  });

  test('T8.5: Filter tabs work', async ({ authenticatedPage: page }) => {
    const allItems = [
      mockNotification({ id: 'notif-1', title: 'Unread notification', readAt: null }),
      mockNotification({ id: 'notif-2', title: 'Read notification', readAt: '2025-06-01T00:00:00Z' }),
      mockNotification({ id: 'notif-3', title: 'Another unread', readAt: null }),
    ];

    await page.route('**/api/notifications/unread-count', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 2 }),
      }),
    );

    await page.route('**/api/notifications?**', (route) => {
      const url = new URL(route.request().url());
      const readFilter = url.searchParams.get('read');

      let items = allItems;
      if (readFilter === 'false') {
        items = allItems.filter((n) => n.readAt === null);
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, nextCursor: null, unreadCount: 2 }),
      });
    });

    await page.goto('/dashboard');

    // Open panel
    await page.locator(SEL.notifications.bell).click();
    await expect(page.locator(SEL.notifications.panel)).toBeVisible({ timeout: 5_000 });

    // By default, should show all 3 items
    await expect(page.locator(SEL.notifications.item)).toHaveCount(3);

    // Click "Unread" filter — should show only unread items
    await page.locator(SEL.notifications.filterUnread).click();
    await expect(page.locator(SEL.notifications.item)).toHaveCount(2);

    // Click "All" filter — should show all items again
    await page.locator(SEL.notifications.filterAll).click();
    await expect(page.locator(SEL.notifications.item)).toHaveCount(3);
  });
});
