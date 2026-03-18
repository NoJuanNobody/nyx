import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock (chainable) ──────────────────────────────────

let selectResult: unknown[] = [];

function chainable(resolvedValue?: unknown): unknown {
  const resolved = resolvedValue ?? selectResult;
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'from', 'where', 'insert', 'values', 'returning',
    'update', 'set', 'delete', 'innerJoin', 'orderBy', 'limit',
    'leftJoin', 'groupBy', 'having', 'offset',
  ];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(resolved).then(resolve);
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable()),
  insert: vi.fn(() => chainable()),
  update: vi.fn(() => chainable()),
  delete: vi.fn(() => chainable()),
  query: {},
};

vi.doMock('../../db/index.js', () => ({
  db: mockDb,
}));

vi.doMock('../../db/schema.js', () => ({
  stripeCustomers: {
    plan: 'plan',
    userId: 'user_id',
  },
  documents: {
    createdById: 'created_by_id',
  },
  users: {
    id: 'id',
  },
  teamMembers: {
    userId: 'user_id',
  },
}));

// Must import after doMock
const { getPlanLimits, getUserPlan, checkLimit, getUsageSummary } = await import(
  '../plan-limits.service.js'
);

describe('plan-limits.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResult = [];
    // Restore default chainable implementation after clearAllMocks resets it
    mockDb.select.mockImplementation(() => chainable());
    mockDb.insert.mockImplementation(() => chainable());
    mockDb.update.mockImplementation(() => chainable());
    mockDb.delete.mockImplementation(() => chainable());
  });

  // ── getPlanLimits ─────────────────────────────────────

  describe('getPlanLimits', () => {
    it('returns free plan limits', () => {
      const limits = getPlanLimits('free');
      expect(limits).toEqual({
        maxDocuments: 5,
        aiEnabled: false,
        voiceEnabled: false,
        maxPipelines: 1,
      });
    });

    it('returns pro plan limits with unlimited docs and AI', () => {
      const limits = getPlanLimits('pro');
      expect(limits.maxDocuments).toBe(-1);
      expect(limits.aiEnabled).toBe(true);
      expect(limits.voiceEnabled).toBe(false);
      expect(limits.maxPipelines).toBe(-1);
    });

    it('returns team plan limits with voice enabled', () => {
      const limits = getPlanLimits('team');
      expect(limits.maxDocuments).toBe(-1);
      expect(limits.aiEnabled).toBe(true);
      expect(limits.voiceEnabled).toBe(true);
      expect(limits.maxPipelines).toBe(-1);
    });

    it('returns enterprise plan limits matching team', () => {
      const limits = getPlanLimits('enterprise');
      expect(limits.aiEnabled).toBe(true);
      expect(limits.voiceEnabled).toBe(true);
      expect(limits.maxDocuments).toBe(-1);
    });

    it('defaults to free plan for unknown plan names', () => {
      const limits = getPlanLimits('nonexistent');
      expect(limits).toEqual(getPlanLimits('free'));
    });
  });

  // ── getUserPlan ───────────────────────────────────────

  describe('getUserPlan', () => {
    it('returns the plan from stripe_customers if found', async () => {
      selectResult = [{ plan: 'pro' }];
      const plan = await getUserPlan('user-123');
      expect(plan).toBe('pro');
    });

    it('defaults to free when no stripe customer record exists', async () => {
      selectResult = [];
      const plan = await getUserPlan('user-no-stripe');
      expect(plan).toBe('free');
    });
  });

  // ── checkLimit ────────────────────────────────────────

  describe('checkLimit', () => {
    describe('create_document', () => {
      it('allows document creation when under the free plan limit', async () => {
        // First call: getUserPlan query
        // Second call: getDocumentCount query
        let callCount = 0;
        mockDb.select.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return chainable([{ plan: 'free' }]);
          }
          return chainable([{ count: 3 }]);
        });

        const result = await checkLimit('user-123', 'create_document');
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(5);
        expect(result.current).toBe(3);
        expect(result.plan).toBe('free');
      });

      it('blocks document creation when at the free plan limit', async () => {
        let callCount = 0;
        mockDb.select.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return chainable([{ plan: 'free' }]);
          }
          return chainable([{ count: 5 }]);
        });

        const result = await checkLimit('user-123', 'create_document');
        expect(result.allowed).toBe(false);
        expect(result.limit).toBe(5);
        expect(result.current).toBe(5);
      });

      it('blocks document creation when over the free plan limit', async () => {
        let callCount = 0;
        mockDb.select.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return chainable([{ plan: 'free' }]);
          }
          return chainable([{ count: 7 }]);
        });

        const result = await checkLimit('user-123', 'create_document');
        expect(result.allowed).toBe(false);
      });

      it('always allows document creation on pro plan', async () => {
        selectResult = [{ plan: 'pro' }];
        const result = await checkLimit('user-123', 'create_document');
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(-1);
      });

      it('always allows document creation on team plan', async () => {
        selectResult = [{ plan: 'team' }];
        const result = await checkLimit('user-123', 'create_document');
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(-1);
      });
    });

    describe('use_ai', () => {
      it('blocks AI usage on free plan', async () => {
        selectResult = [{ plan: 'free' }];
        const result = await checkLimit('user-123', 'use_ai');
        expect(result.allowed).toBe(false);
        expect(result.plan).toBe('free');
      });

      it('allows AI usage on pro plan', async () => {
        selectResult = [{ plan: 'pro' }];
        const result = await checkLimit('user-123', 'use_ai');
        expect(result.allowed).toBe(true);
        expect(result.plan).toBe('pro');
      });

      it('allows AI usage on team plan', async () => {
        selectResult = [{ plan: 'team' }];
        const result = await checkLimit('user-123', 'use_ai');
        expect(result.allowed).toBe(true);
      });
    });

    describe('use_voice', () => {
      it('blocks voice on free plan', async () => {
        selectResult = [{ plan: 'free' }];
        const result = await checkLimit('user-123', 'use_voice');
        expect(result.allowed).toBe(false);
      });

      it('blocks voice on pro plan', async () => {
        selectResult = [{ plan: 'pro' }];
        const result = await checkLimit('user-123', 'use_voice');
        expect(result.allowed).toBe(false);
      });

      it('allows voice on team plan', async () => {
        selectResult = [{ plan: 'team' }];
        const result = await checkLimit('user-123', 'use_voice');
        expect(result.allowed).toBe(true);
      });

      it('allows voice on enterprise plan', async () => {
        selectResult = [{ plan: 'enterprise' }];
        const result = await checkLimit('user-123', 'use_voice');
        expect(result.allowed).toBe(true);
      });
    });
  });

  // ── getUsageSummary ───────────────────────────────────

  describe('getUsageSummary', () => {
    it('returns a complete usage summary for a free plan user', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return chainable([{ plan: 'free' }]);
        }
        return chainable([{ count: 2 }]);
      });

      const summary = await getUsageSummary('user-123');
      expect(summary).toEqual({
        plan: 'free',
        documents: { current: 2, limit: 5 },
        ai: { enabled: false },
        voice: { enabled: false },
        pipelines: { limit: 1 },
      });
    });

    it('returns a complete usage summary for a pro plan user', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return chainable([{ plan: 'pro' }]);
        }
        return chainable([{ count: 42 }]);
      });

      const summary = await getUsageSummary('user-123');
      expect(summary).toEqual({
        plan: 'pro',
        documents: { current: 42, limit: -1 },
        ai: { enabled: true },
        voice: { enabled: false },
        pipelines: { limit: -1 },
      });
    });

    it('returns a complete usage summary for a team plan user', async () => {
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return chainable([{ plan: 'team' }]);
        }
        return chainable([{ count: 10 }]);
      });

      const summary = await getUsageSummary('user-123');
      expect(summary).toEqual({
        plan: 'team',
        documents: { current: 10, limit: -1 },
        ai: { enabled: true },
        voice: { enabled: true },
        pipelines: { limit: -1 },
      });
    });
  });
});
