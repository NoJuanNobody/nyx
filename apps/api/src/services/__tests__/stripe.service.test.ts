import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────

const mockDbSelect = vi.fn().mockReturnThis();
const mockDbFrom = vi.fn().mockReturnThis();
const mockDbWhere = vi.fn().mockResolvedValue([]);
const mockDbLimit = vi.fn().mockResolvedValue([]);
const mockDbInsert = vi.fn().mockReturnThis();
const mockDbValues = vi.fn().mockReturnThis();
const mockDbOnConflictDoNothing = vi.fn().mockResolvedValue([]);
const mockDbUpdate = vi.fn().mockReturnThis();
const mockDbSet = vi.fn().mockReturnThis();

vi.doMock('../../db/index.js', () => ({
  db: {
    select: mockDbSelect,
    from: (...args: unknown[]) => {
      mockDbFrom(...args);
      return {
        where: (...wArgs: unknown[]) => {
          mockDbWhere(...wArgs);
          return {
            limit: mockDbLimit,
          };
        },
      };
    },
    insert: (...args: unknown[]) => {
      mockDbInsert(...args);
      return {
        values: (...vArgs: unknown[]) => {
          mockDbValues(...vArgs);
          return {
            onConflictDoNothing: mockDbOnConflictDoNothing,
            returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
          };
        },
      };
    },
    update: (...args: unknown[]) => {
      mockDbUpdate(...args);
      return {
        set: (...sArgs: unknown[]) => {
          mockDbSet(...sArgs);
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        },
      };
    },
  },
}));

vi.doMock('../../db/schema.js', () => ({
  subscriptions: { teamId: 'teamId', stripeCustomerId: 'stripeCustomerId' },
  stripeCustomers: { stripeCustomerId: 'stripeCustomerId' },
  teams: { id: 'id', name: 'name' },
}));

describe('stripe.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('getPriceId', () => {
    it('should return price ID for known plans', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { getPriceId } = await import('../stripe.service.js');

      expect(getPriceId('pro')).toBeDefined();
      expect(getPriceId('team')).toBeDefined();
    });

    it('should return undefined for unknown plans', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { getPriceId } = await import('../stripe.service.js');

      expect(getPriceId('nonexistent')).toBeUndefined();
      expect(getPriceId('free')).toBeUndefined();
    });
  });

  describe('createCheckoutSession (stub mode)', () => {
    it('should return mock URL when STRIPE_SECRET_KEY is not set', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { createCheckoutSession } = await import('../stripe.service.js');

      const url = await createCheckoutSession(
        'cus_test123',
        'price_pro_placeholder',
        'team-uuid',
        'https://app.nyx.dev/success',
        'https://app.nyx.dev/cancel',
      );

      expect(url).toContain('https://checkout.stripe.com/mock');
      expect(url).toContain('cus_test123');
      expect(url).toContain('price_pro_placeholder');
    });
  });

  describe('createPortalSession (stub mode)', () => {
    it('should return mock URL when STRIPE_SECRET_KEY is not set', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { createPortalSession } = await import('../stripe.service.js');

      const url = await createPortalSession(
        'cus_test123',
        'https://app.nyx.dev/settings',
      );

      expect(url).toContain('https://billing.stripe.com/mock/portal');
      expect(url).toContain('cus_test123');
    });
  });

  describe('getOrCreateCustomer (stub mode)', () => {
    it('should return existing customer ID if found', async () => {
      mockDbLimit.mockResolvedValueOnce([{ stripeCustomerId: 'cus_existing' }]);

      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { getOrCreateCustomer } = await import('../stripe.service.js');

      const result = await getOrCreateCustomer(
        'team-uuid-1234',
        'Test Team',
        'test@example.com',
      );

      expect(result).toBe('cus_existing');
    });

    it('should create mock customer ID when no existing record and no Stripe key', async () => {
      mockDbLimit.mockResolvedValueOnce([]);

      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { getOrCreateCustomer } = await import('../stripe.service.js');

      const result = await getOrCreateCustomer(
        'team-uuid-1234',
        'Test Team',
        'test@example.com',
      );

      expect(result).toMatch(/^cus_mock_/);
      expect(mockDbInsert).toHaveBeenCalled();
    });
  });

  describe('handleWebhookEvent', () => {
    it('should throw when STRIPE_WEBHOOK_SECRET is not configured', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { handleWebhookEvent } = await import('../stripe.service.js');

      await expect(
        handleWebhookEvent('{}', 'sig_test'),
      ).rejects.toThrow('STRIPE_WEBHOOK_SECRET is not configured');
    });

    it('should process checkout.session.completed event in stub mode', async () => {
      // First call: select existing subscription (none found)
      // Second call: select existing stripe customer (none found)
      mockDbLimit
        .mockResolvedValueOnce([])  // subscription lookup
        .mockResolvedValueOnce([]); // stripe customer lookup

      vi.doMock('../../lib/config.js', () => ({
        config: {
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { handleWebhookEvent } = await import('../stripe.service.js');

      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_test',
            subscription: 'sub_test',
            metadata: { teamId: 'team-uuid' },
            client_reference_id: 'user-123',
          },
        },
      };

      await handleWebhookEvent(JSON.stringify(event), 'sig_test');

      // Should have inserted a subscription record
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should process customer.subscription.deleted event in stub mode', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: {
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { handleWebhookEvent } = await import('../stripe.service.js');

      const event = {
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test',
            status: 'canceled',
            metadata: { teamId: 'team-uuid' },
            customer: 'cus_test',
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  price: { id: 'price_pro_placeholder' },
                  current_period_start: 1700000000,
                  current_period_end: 1702592000,
                },
              ],
            },
          },
        },
      };

      await handleWebhookEvent(JSON.stringify(event), 'sig_test');

      // Should have called update to set plan to 'free' and status to 'canceled'
      expect(mockDbUpdate).toHaveBeenCalled();
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: 'free',
          status: 'canceled',
        }),
      );
    });

    it('should process customer.subscription.updated event in stub mode', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: {
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { handleWebhookEvent } = await import('../stripe.service.js');

      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test',
            status: 'active',
            metadata: { teamId: 'team-uuid' },
            customer: 'cus_test',
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  price: { id: 'price_team_placeholder' },
                  current_period_start: 1700000000,
                  current_period_end: 1702592000,
                },
              ],
            },
          },
        },
      };

      await handleWebhookEvent(JSON.stringify(event), 'sig_test');

      expect(mockDbUpdate).toHaveBeenCalled();
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: 'team',
          status: 'active',
        }),
      );
    });

    it('should ignore unhandled event types', async () => {
      vi.doMock('../../lib/config.js', () => ({
        config: {
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        },
      }));
      vi.doMock('stripe', () => ({ default: vi.fn() }));

      const { handleWebhookEvent } = await import('../stripe.service.js');

      const event = {
        type: 'payment_intent.succeeded',
        data: { object: {} },
      };

      // Should not throw
      await handleWebhookEvent(JSON.stringify(event), 'sig_test');

      expect(mockDbUpdate).not.toHaveBeenCalled();
      expect(mockDbInsert).not.toHaveBeenCalled();
    });
  });
});
