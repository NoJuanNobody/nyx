import { test, expect } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';
import { SEED } from './seed-ids';

/**
 * Issue #346 — `/app/*` prefix routing.
 *
 * Asserts:
 *  - Legacy top-level routes (e.g. `/dashboard`, `/documents/:id`) redirect
 *    to their `/app/*` equivalents.
 *  - Query strings are preserved across those redirects.
 *  - Authenticated `/` lands on `/app/dashboard` (Landing is only for
 *    anonymous visitors — covered in landing.spec.ts).
 *  - `/app` (bare) redirects to `/app/dashboard`.
 */
test.describe('App prefix routing (#346)', () => {
  test('/dashboard redirects to /app/dashboard', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/app\/dashboard(\?.*)?$/, { timeout: 10_000 });
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });
  });

  test('/dashboard?foo=bar preserves query string on redirect', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/dashboard?foo=bar&baz=qux');
    await expect(page).toHaveURL(/\/app\/dashboard\?foo=bar&baz=qux$/, {
      timeout: 10_000,
    });
    // The URL should contain the preserved query params.
    const url = new URL(page.url());
    expect(url.pathname).toBe('/app/dashboard');
    expect(url.searchParams.get('foo')).toBe('bar');
    expect(url.searchParams.get('baz')).toBe('qux');
  });

  test('/settings redirects to /app/settings', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/app\/settings(\?.*)?$/, { timeout: 10_000 });
  });

  test('/board redirects to /app/tickets', async ({ authenticatedPage: page }) => {
    await page.goto('/board');
    await expect(page).toHaveURL(/\/app\/tickets(\?.*)?$/, { timeout: 10_000 });
  });

  test('/repositories redirects to /app/repositories', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/repositories');
    await expect(page).toHaveURL(/\/app\/repositories(\?.*)?$/, { timeout: 10_000 });
  });

  test('/intake redirects to /app/intake', async ({ authenticatedPage: page }) => {
    await page.goto('/intake');
    await expect(page).toHaveURL(/\/app\/intake(\?.*)?$/, { timeout: 10_000 });
  });

  test('/sprint redirects to /app/sprint', async ({ authenticatedPage: page }) => {
    await page.goto('/sprint');
    await expect(page).toHaveURL(/\/app\/sprint(\?.*)?$/, { timeout: 10_000 });
  });

  test('/operations redirects to /app/operations', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/operations');
    await expect(page).toHaveURL(/\/app\/operations(\?.*)?$/, { timeout: 10_000 });
  });

  test('/getting-started redirects to /app/dashboard', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/getting-started');
    await expect(page).toHaveURL(/\/app\/dashboard(\?.*)?$/, {
      timeout: 10_000,
    });
  });

  test('/documents/:id redirects to /app/documents/:id with params preserved', async ({
    authenticatedPage: page,
  }) => {
    const id = SEED.DOC_API_SPEC_ID;
    await page.goto(`/documents/${id}?highlight=section-1`);
    await expect(page).toHaveURL(new RegExp(`/app/documents/${id}\\?highlight=section-1$`), {
      timeout: 10_000,
    });
    const url = new URL(page.url());
    expect(url.pathname).toBe(`/app/documents/${id}`);
    expect(url.searchParams.get('highlight')).toBe('section-1');
  });

  test('/documents/:id/trace redirects to /app/documents/:id/trace', async ({
    authenticatedPage: page,
  }) => {
    const id = SEED.DOC_API_SPEC_ID;
    await page.goto(`/documents/${id}/trace`);
    await expect(page).toHaveURL(new RegExp(`/app/documents/${id}/trace$`), {
      timeout: 10_000,
    });
  });

  test('/app (bare) redirects to /app/dashboard', async ({ authenticatedPage: page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/app\/dashboard$/, { timeout: 10_000 });
  });

  test('authenticated / redirects to /app/dashboard', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/app\/dashboard$/, { timeout: 10_000 });
    await expect(page.locator(SEL.dashboard.title)).toBeVisible({ timeout: 10_000 });
  });

  test('/admin/documents redirects to /app/dashboard', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/admin/documents');
    await expect(page).toHaveURL(/\/app\/dashboard(\?.*)?$/, { timeout: 10_000 });
  });

  test('/observability redirects to /app/operations?tab=observability', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/observability');
    await expect(page).toHaveURL(/\/app\/operations\?tab=observability$/, {
      timeout: 10_000,
    });
  });

  test('/voice redirects to /app/operations?tab=voice', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/voice');
    await expect(page).toHaveURL(/\/app\/operations\?tab=voice$/, {
      timeout: 10_000,
    });
  });
});
