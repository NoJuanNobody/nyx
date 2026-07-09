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
        })),
      })),
    })),
    insert: vi.fn().mockImplementation(() => {
      mockInsert();
      return {
        values: vi.fn().mockImplementation(() => ({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
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
  creditBalances: { userId: 'userId', balance: 'balance', updatedAt: 'updatedAt' },
  creditTransactions: {
    id: 'id',
    userId: 'userId',
    teamId: 'teamId',
    amount: 'amount',
    type: 'type',
    description: 'description',
    taskType: 'taskType',
    stripeSessionId: 'stripeSessionId',
    createdAt: 'createdAt',
  },
  teamCreditBalances: { teamId: 'teamId', balance: 'balance', updatedAt: 'updatedAt' },
}));

describe('team credits — credits.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    selectCallIdx = 0;
  });

  describe('MONTHLY_CREDITS', () => {
    it('exports correct per-plan allotments', async () => {
      const { MONTHLY_CREDITS } = await import('../credits.service.js');
      expect(MONTHLY_CREDITS.free).toBe(10);
      expect(MONTHLY_CREDITS.starter).toBe(100);
      expect(MONTHLY_CREDITS.pro).toBe(500);
      expect(MONTHLY_CREDITS.team).toBe(0);
      expect(MONTHLY_CREDITS.enterprise).toBe(0);
    });
  });

  describe('getTeamBalance', () => {
    it('returns 0 when no record exists', async () => {
      selectResults = [[]];
      const { getTeamBalance } = await import('../credits.service.js');
      expect(await getTeamBalance('team-1')).toBe(0);
    });

    it('returns the stored balance', async () => {
      selectResults = [[{ balance: 250 }]];
      const { getTeamBalance } = await import('../credits.service.js');
      expect(await getTeamBalance('team-1')).toBe(250);
    });
  });

  describe('addTeamCredits', () => {
    it('no-ops when amount is 0', async () => {
      selectResults = [[{ balance: 100 }]];
      const { addTeamCredits } = await import('../credits.service.js');
      const result = await addTeamCredits('team-1', 0, 'test');
      expect(result.added).toBe(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('upserts balance and writes a transaction', async () => {
      // idempotency check returns nothing (not seen), then getTeamBalance returns 500
      selectResults = [[], [{ balance: 500 }]];
      const { addTeamCredits } = await import('../credits.service.js');
      const result = await addTeamCredits('team-1', 500, 'Monthly allotment — pro plan');
      expect(result.added).toBe(500);
      expect(result.balance).toBe(500);
      expect(mockInsert).toHaveBeenCalledTimes(2); // balance upsert + transaction
    });

    it('is idempotent: skips when invoice already processed', async () => {
      // idempotency check finds an existing row
      selectResults = [[{ id: 'existing-txn' }], [{ balance: 500 }]];
      const { addTeamCredits } = await import('../credits.service.js');
      const result = await addTeamCredits('team-1', 500, 'Monthly allotment', 'in_test_123');
      expect(result.added).toBe(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('proceeds when a different invoice is provided', async () => {
      // idempotency check: nothing found for this invoice
      selectResults = [[], [{ balance: 1000 }]];
      const { addTeamCredits } = await import('../credits.service.js');
      const result = await addTeamCredits('team-1', 500, 'Monthly allotment', 'in_new_456');
      expect(result.added).toBe(500);
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('deductTeamCredits', () => {
    it('throws 400 on zero amount', async () => {
      const { deductTeamCredits } = await import('../credits.service.js');
      await expect(deductTeamCredits('team-1', 0, 'drift_detection', 'test')).rejects.toEqual({
        statusCode: 400,
        message: 'Amount must be positive',
      });
    });

    it('throws 402 when balance is insufficient', async () => {
      selectResults = [[{ balance: 3 }]];
      const { deductTeamCredits } = await import('../credits.service.js');
      await expect(deductTeamCredits('team-1', 5, 'drift_detection', 'test')).rejects.toEqual({
        statusCode: 402,
        message: 'Insufficient team credits. Balance: 3, required: 5',
      });
    });

    it('throws 402 when balance is zero (no record)', async () => {
      selectResults = [[]];
      const { deductTeamCredits } = await import('../credits.service.js');
      await expect(deductTeamCredits('team-1', 2, 'drift_detection', 'test')).rejects.toEqual({
        statusCode: 402,
        message: 'Insufficient team credits. Balance: 0, required: 2',
      });
    });

    it('deducts balance and records consumption transaction', async () => {
      // getTeamBalance (check): 10, getTeamBalance (return): 7
      selectResults = [[{ balance: 10 }], [{ balance: 7 }]];
      const { deductTeamCredits } = await import('../credits.service.js');
      const result = await deductTeamCredits('team-1', 3, 'drift_detection', 'Drift check');
      expect(result.balance).toBe(7);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });
});
