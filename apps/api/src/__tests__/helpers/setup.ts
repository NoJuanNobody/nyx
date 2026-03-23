/**
 * Global test setup — mocks DB, Clerk, and external fetch calls.
 */
import { vi, beforeEach } from 'vitest';

// ── Chainable Drizzle mock ──────────────────────────────────────────

function chainable(resolvedValue: unknown = []): unknown {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'from', 'where', 'insert', 'values', 'returning',
    'update', 'set', 'delete', 'innerJoin', 'orderBy', 'limit',
    'leftJoin', 'groupBy', 'having', 'offset',
  ];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  // Make the chain thenable so `await db.select()...` resolves
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(resolvedValue).then(resolve);
  return chain;
}

export const mockDb = {
  select: vi.fn(() => chainable()),
  insert: vi.fn(() => chainable()),
  update: vi.fn(() => chainable()),
  delete: vi.fn(() => chainable()),
  execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  query: {},
};

vi.mock('../../db/index.js', () => ({
  db: mockDb,
}));

// ── Clerk mocks ─────────────────────────────────────────────────────

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn().mockResolvedValue({ sub: 'clerk_user_123' }),
  createClerkClient: vi.fn(() => ({
    users: {
      getUser: vi.fn().mockResolvedValue({
        id: 'clerk_user_123',
        emailAddresses: [{ id: 'email_1', emailAddress: 'test@example.com' }],
        primaryEmailAddressId: 'email_1',
        firstName: 'Test',
        lastName: 'User',
        imageUrl: 'https://example.com/avatar.png',
      }),
    },
  })),
}));

// ── Config mock ─────────────────────────────────────────────────────

vi.mock('../../lib/config.js', () => ({
  config: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    PORT: 3001,
    HOST: '0.0.0.0',
    NODE_ENV: 'test',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GITHUB_CLIENT_ID: 'test-gh-client',
    GITHUB_CLIENT_SECRET: 'test-gh-secret',
    GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
    CLERK_SECRET_KEY: 'test-clerk-secret',
    CLERK_PUBLISHABLE_KEY: 'test-clerk-pub',
    WEBHOOK_BASE_URL: 'https://test.example.com',
    HEALTH_PROBE_TIMEOUT_MS: 3000,
    HEALTH_LOG_FAILURES: false,
    BYOK_ENCRYPTION_SECRET: 'test-byok-encryption-secret-32chars!',
  },
}));

// ── Global fetch mock ───────────────────────────────────────────────

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue({}),
  text: vi.fn().mockResolvedValue(''),
  status: 200,
  statusText: 'OK',
});

vi.stubGlobal('fetch', mockFetch);

// ── Reset all mocks between tests ───────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

export { mockFetch };
