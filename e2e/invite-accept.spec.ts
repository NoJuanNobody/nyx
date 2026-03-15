import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

test.describe('Invite Accept Flow', () => {
  test('108.1: Valid invitation shows team details', async ({ authenticatedPage: page }) => {
    // Mock the invitation token endpoint
    await page.route(`**/api/invitations/${SEED.PENDING_INVITE_TOKEN}`, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000700',
            teamId: SEED.DEFAULT_TEAM_ID,
            teamName: 'Default Team',
            email: SEED.PENDING_INVITE_EMAIL,
            role: 'developer',
            status: 'pending',
            invitedById: SEED.DEV_USER_ID,
            createdAt: '2025-01-01T00:00:00Z',
            expiresAt: '2030-01-08T00:00:00Z',
          }),
        });
      }
      return route.fallback();
    });

    await page.goto(`/invite/${SEED.PENDING_INVITE_TOKEN}`);

    // Should show team name and role
    await expect(page.locator(SEL.invite.teamName)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(SEL.invite.role)).toBeVisible();
  });

  test('108.2: Invalid token shows error', async ({ authenticatedPage: page }) => {
    // Mock the invitation token endpoint to return 404
    await page.route('**/api/invitations/invalid-token-12345', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Invitation not found' }),
        });
      }
      return route.fallback();
    });

    await page.goto('/invite/invalid-token-12345');

    // Should show error state
    await expect(page.locator(SEL.invite.error)).toBeVisible({ timeout: 10_000 });
  });
});
