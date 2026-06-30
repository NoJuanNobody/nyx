import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ── Mocks ────────────────────────────────────────────

const mockCreateCreditPackCheckoutSession = vi.fn().mockResolvedValue(
  'https://checkout.stripe.com/mock?pack=growth&user=user-1',
);

vi.mock('../../services/stripe.service.js', () => ({
  createCreditPackCheckoutSession: mockCreateCreditPackCheckoutSession,
  CREDIT_PACK_PRICES: {
    starter: 'price_credit_starter_placeholder',
    growth: 'price_credit_growth_placeholder',
    pro: 'price_credit_pro_placeholder',
    enterprise: 'price_credit_enterprise_placeholder',
  },
}));

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
    mockCreateCreditPackCheckoutSession.mockResolvedValue(
      'https://checkout.stripe.com/mock?pack=growth&user=user-1',
    );
    mockGetBalance.mockResolvedValue(100);
    mockDeductCredits.mockResolvedValue({ balance: 97 });
    mockGetTransactionHistory.mockResolvedValue([]);
  });

  describe('POST /credits/purchase', () => {
    it('returns checkoutUrl for valid packId', async () => {
      const app = await buildApp('user-1');
      const res = await app.inject({
        method: 'POST',
        url: '/credits/purchase',
        headers: { origin: 'https://app.nyx.dev' },
        payload: { packId: 'growth' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('checkoutUrl');
      expect(body.checkoutUrl).toContain('checkout.stripe.com');
      expect(body).toHaveProperty('pack');
      expect(body.pack.id).toBe('growth');
      expect(mockCreateCreditPackCheckoutSession).toHaveBeenCalledOnce();
    });

    it('returns 400 for invalid packId', async () => {
      const app = await buildApp('user-1');
      const res = await app.inject({
        method: 'POST',
        url: '/credits/purchase',
        payload: { packId: 'nonexistent' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Invalid credit pack');
      expect(mockCreateCreditPackCheckoutSession).not.toHaveBeenCalled();
    });

    it('returns 400 when packId is missing', async () => {
      const app = await buildApp('user-1');
      const res = await app.inject({
        method: 'POST',
        url: '/credits/purchase',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('packId is required');
      expect(mockCreateCreditPackCheckoutSession).not.toHaveBeenCalled();
    });

    it('returns 401 when not authenticated', async () => {
      const app = await buildApp(); // no userId
      const res = await app.inject({
        method: 'POST',
        url: '/credits/purchase',
        payload: { packId: 'starter' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Authentication required');
    });

    it('passes correct args to createCreditPackCheckoutSession', async () => {
      const app = await buildApp('user-42');
      await app.inject({
        method: 'POST',
        url: '/credits/purchase',
        headers: { origin: 'https://app.nyx.dev' },
        payload: { packId: 'starter' },
      });

      expect(mockCreateCreditPackCheckoutSession).toHaveBeenCalledWith(
        'user-42',
        'starter',
        50,  // starter pack credits
        'price_credit_starter_placeholder',
        'https://app.nyx.dev/billing?checkout=success',
        'https://app.nyx.dev/billing?checkout=cancel',
      );
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
    it('returns available credit packs', async () => {
      const app = await buildApp('user-1');
      const res = await app.inject({ method: 'GET', url: '/credits/packs' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.packs).toHaveLength(4);
      expect(body.packs.map((p: { id: string }) => p.id)).toEqual([
        'starter', 'growth', 'pro', 'enterprise',
      ]);
    });
  });
});
