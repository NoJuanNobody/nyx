import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ── Mocks ────────────────────────────────────────────

const mockGetBalance = vi.fn().mockResolvedValue(100);
const mockDeductCredits = vi.fn().mockResolvedValue({ balance: 97 });
const mockGetTransactionHistory = vi.fn().mockResolvedValue([]);

vi.mock('../../services/credits.service.js', () => ({
  getBalance: mockGetBalance,
  deductCredits: mockDeductCredits,
  getTransactionHistory: mockGetTransactionHistory,
  CREDIT_COSTS: {
    spec_analysis: 1,
    document_generation: 3,
  },
}));

// ── App builder ───────────────────────────────────────

async function buildApp(userId?: string) {
  const { creditRoutes } = await import('../../routes/credits.js');
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as never);
  app.addHook('preHandler', async (request) => {
    request.user = userId
      ? { id: userId, clerkId: 'clerk_1', email: 'test@test.com', name: 'Test User', avatarUrl: null, role: 'admin' } as never
      : null as never;
  });
  app.register(creditRoutes, { prefix: '/credits' });
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────

describe('Credits Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBalance.mockResolvedValue(100);
    mockDeductCredits.mockResolvedValue({ balance: 97 });
    mockGetTransactionHistory.mockResolvedValue([]);
  });

  describe('POST /credits/purchase', () => {
    it('is no longer exposed (credits are not sold)', async () => {
      const app = await buildApp('user-1');
      const res = await app.inject({ method: 'POST', url: '/credits/purchase', payload: { packId: 'growth' } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /credits/balance', () => {
    it('returns balance for authenticated user', async () => {
      mockGetBalance.mockResolvedValue(42);
      const app = await buildApp('user-1');
      const res = await app.inject({ method: 'GET', url: '/credits/balance' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ balance: 42 });
    });
  });

  describe('GET /credits/packs', () => {
    it('is no longer exposed (credits are not sold)', async () => {
      const app = await buildApp('user-1');
      const res = await app.inject({ method: 'GET', url: '/credits/packs' });
      expect(res.statusCode).toBe(404);
    });
  });
});
