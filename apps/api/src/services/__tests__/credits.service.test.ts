import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state ─────────────────────────────────

let selectResults: unknown[][] = [];
let selectCallIdx = 0;

function nextSelectResult() {
  const result = selectResults[selectCallIdx] ?? [];
  selectCallIdx++;
  return result;
}

const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.doMock('../../db/index.js', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => nextSelectResult()),
          orderBy: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation((n: number) => {
              // Store the limit for assertion
              (globalThis as Record<string, unknown>).__lastLimit = n;
              return nextSelectResult();
            }),
          })),
        })),
      })),
    })),
    insert: vi.fn().mockImplementation(() => {
      mockInsert();
      return {
        values: vi.fn().mockImplementation(() => ({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          returning: vi.fn().mockResolvedValue([{ id: 'txn-id' }]),
        })),
      };
    }),
    update: vi.fn().mockImplementation(() => {
      mockUpdate();
      return {
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      };
    }),
  },
}));

vi.doMock('../../db/schema.js', () => ({
  creditBalances: {
    userId: 'userId',
    balance: 'balance',
    updatedAt: 'updatedAt',
  },
  creditTransactions: {
    id: 'id',
    userId: 'userId',
    amount: 'amount',
    type: 'type',
    description: 'description',
    taskType: 'taskType',
    stripeSessionId: 'stripeSessionId',
    createdAt: 'createdAt',
  },
}));

describe('credits.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    selectCallIdx = 0;
  });

  describe('CREDIT_COSTS', () => {
    it('should export credit cost configuration with correct values', async () => {
      const { CREDIT_COSTS } = await import('../credits.service.js');

      expect(CREDIT_COSTS).toEqual({
        spec_analysis: 1,
        document_generation: 3,
        drift_detection: 2,
        ticket_generation: 2,
        voice_agent_minute: 5,
        agent_full_spec_review: 5,
        agent_change_impact_analysis: 4,
        agent_codebase_sync_check: 4,
        agent_doc_generation: 5,
        agent_meeting_review: 3,
        agent_custom: 3,
      });
    });
  });

  describe('getAgentCost', () => {
    it('should return the cost for a known workflow', async () => {
      const { getAgentCost } = await import('../credits.service.js');
      expect(getAgentCost('full_spec_review')).toBe(5);
      expect(getAgentCost('meeting_review')).toBe(3);
    });

    it('should return agent_custom cost for unknown workflow', async () => {
      const { getAgentCost } = await import('../credits.service.js');
      expect(getAgentCost('nonexistent_workflow')).toBe(3);
    });

    it('should return agent_custom cost when no workflow specified', async () => {
      const { getAgentCost } = await import('../credits.service.js');
      expect(getAgentCost()).toBe(3);
      expect(getAgentCost(undefined)).toBe(3);
    });
  });

  describe('checkCredits', () => {
    it('should return allowed=true when balance is sufficient', async () => {
      selectResults = [[{ balance: 10 }]];

      const { checkCredits } = await import('../credits.service.js');
      const result = await checkCredits('user-1', 5);

      expect(result).toEqual({ allowed: true, balance: 10, required: 5 });
    });

    it('should return allowed=false when balance is insufficient', async () => {
      selectResults = [[{ balance: 2 }]];

      const { checkCredits } = await import('../credits.service.js');
      const result = await checkCredits('user-1', 5);

      expect(result).toEqual({ allowed: false, balance: 2, required: 5 });
    });

    it('should return allowed=false when no balance exists', async () => {
      selectResults = [[]];

      const { checkCredits } = await import('../credits.service.js');
      const result = await checkCredits('user-1', 3);

      expect(result).toEqual({ allowed: false, balance: 0, required: 3 });
    });

    it('should return allowed=true when balance exactly meets requirement', async () => {
      selectResults = [[{ balance: 5 }]];

      const { checkCredits } = await import('../credits.service.js');
      const result = await checkCredits('user-1', 5);

      expect(result).toEqual({ allowed: true, balance: 5, required: 5 });
    });
  });

  describe('getBalance', () => {
    it('should return 0 when no balance record exists', async () => {
      selectResults = [[]];

      const { getBalance } = await import('../credits.service.js');
      const balance = await getBalance('user-1');

      expect(balance).toBe(0);
    });

    it('should return the stored balance', async () => {
      selectResults = [[{ balance: 42 }]];

      const { getBalance } = await import('../credits.service.js');
      const balance = await getBalance('user-1');

      expect(balance).toBe(42);
    });
  });

  describe('addCredits', () => {
    it('should reject zero amount', async () => {
      const { addCredits } = await import('../credits.service.js');

      await expect(addCredits('user-1', 0, 'test')).rejects.toEqual({
        statusCode: 400,
        message: 'Amount must be positive',
      });
    });

    it('should reject negative amount', async () => {
      const { addCredits } = await import('../credits.service.js');

      await expect(addCredits('user-1', -5, 'test')).rejects.toEqual({
        statusCode: 400,
        message: 'Amount must be positive',
      });
    });

    it('should upsert balance and create purchase transaction', async () => {
      // getBalance after add returns 10
      selectResults = [[{ balance: 10 }]];

      const { addCredits } = await import('../credits.service.js');
      const result = await addCredits('user-1', 10, 'Purchased 10 credits');

      expect(result.balance).toBe(10);
      expect(result.added).toBe(10);
      // insert called twice: once for upsert balance, once for transaction
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it('should accept optional stripeSessionId and include it in transaction', async () => {
      selectResults = [[{ balance: 50 }]];

      const { addCredits } = await import('../credits.service.js');
      const result = await addCredits('user-1', 50, 'Purchased credit pack: growth (50 credits)', 'cs_test_session_123');

      expect(result.balance).toBe(50);
      expect(result.added).toBe(50);
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it('should work without stripeSessionId (null stored)', async () => {
      selectResults = [[{ balance: 200 }]];

      const { addCredits } = await import('../credits.service.js');
      const result = await addCredits('user-2', 200, 'Manual credit grant');

      expect(result.balance).toBe(200);
      expect(result.added).toBe(200);
    });
  });

  describe('deductCredits', () => {
    it('should reject zero amount', async () => {
      const { deductCredits } = await import('../credits.service.js');

      await expect(deductCredits('user-1', 0, 'spec_analysis', 'test')).rejects.toEqual({
        statusCode: 400,
        message: 'Amount must be positive',
      });
    });

    it('should reject negative amount', async () => {
      const { deductCredits } = await import('../credits.service.js');

      await expect(deductCredits('user-1', -3, 'spec_analysis', 'test')).rejects.toEqual({
        statusCode: 400,
        message: 'Amount must be positive',
      });
    });

    it('should throw 402 when balance is insufficient', async () => {
      // getBalance returns 3
      selectResults = [[{ balance: 3 }]];

      const { deductCredits } = await import('../credits.service.js');

      await expect(deductCredits('user-1', 5, 'spec_analysis', 'test')).rejects.toEqual({
        statusCode: 402,
        message: 'Insufficient credits. Current balance: 3, required: 5',
      });
    });

    it('should throw 402 when balance is zero', async () => {
      selectResults = [[]]; // no row = 0 balance

      const { deductCredits } = await import('../credits.service.js');

      await expect(deductCredits('user-1', 1, 'spec_analysis', 'test')).rejects.toEqual({
        statusCode: 402,
        message: 'Insufficient credits. Current balance: 0, required: 1',
      });
    });

    it('should deduct credits and create consumption transaction', async () => {
      // First getBalance check: 10 credits
      // Second getBalance after deduction: 7 credits
      selectResults = [[{ balance: 10 }], [{ balance: 7 }]];

      const { deductCredits } = await import('../credits.service.js');
      const result = await deductCredits('user-1', 3, 'drift_detection', 'Drift check');

      expect(result.balance).toBe(7);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it('should allow exact balance deduction', async () => {
      selectResults = [[{ balance: 5 }], [{ balance: 0 }]];

      const { deductCredits } = await import('../credits.service.js');
      const result = await deductCredits('user-1', 5, 'document_generation', 'Generate doc');

      expect(result.balance).toBe(0);
    });
  });

  describe('getTransactionHistory', () => {
    it('should return empty array when no transactions exist', async () => {
      selectResults = [[]];

      const { getTransactionHistory } = await import('../credits.service.js');
      const result = await getTransactionHistory('user-1');

      expect(result).toEqual([]);
    });

    it('should return transaction records', async () => {
      const mockTxns = [
        {
          id: 'txn-1',
          amount: -2,
          type: 'consumption',
          description: 'Drift detection',
          taskType: 'drift_detection',
          createdAt: new Date('2026-03-18'),
        },
        {
          id: 'txn-2',
          amount: 10,
          type: 'purchase',
          description: 'Purchased credits',
          taskType: null,
          createdAt: new Date('2026-03-17'),
        },
      ];
      selectResults = [mockTxns];

      const { getTransactionHistory } = await import('../credits.service.js');
      const result = await getTransactionHistory('user-1', 10);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('consumption');
      expect(result[0].amount).toBe(-2);
      expect(result[0].taskType).toBe('drift_detection');
      expect(result[1].type).toBe('purchase');
      expect(result[1].amount).toBe(10);
      expect(result[1].taskType).toBeNull();
    });

    it('should respect limit parameter', async () => {
      selectResults = [[]];

      const { getTransactionHistory } = await import('../credits.service.js');
      await getTransactionHistory('user-1', 5);

      expect((globalThis as Record<string, unknown>).__lastLimit).toBe(5);
    });

    it('should default to 50 when no limit is provided', async () => {
      selectResults = [[]];

      const { getTransactionHistory } = await import('../credits.service.js');
      await getTransactionHistory('user-1');

      expect((globalThis as Record<string, unknown>).__lastLimit).toBe(50);
    });
  });
});
