import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state ─────────────────────────────────

let selectResults: unknown[][] = [];
let selectCallIdx = 0;

function nextSelectResult() {
  const result = selectResults[selectCallIdx] ?? [];
  selectCallIdx++;
  return result;
}

const mockInsertValues = vi.fn();

vi.doMock('../../db/index.js', () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          const result = nextSelectResult();
          // Thenable object: when awaited directly (listOwnedPipelines) resolves
          // to result; when .limit() is chained (hasPipelineAccess) returns result.
          return {
            then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
              Promise.resolve(result).then(resolve, reject),
            limit: vi.fn().mockImplementation(() => result),
          };
        }),
      })),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((...args: unknown[]) => {
        mockInsertValues(...args);
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
          returning: vi.fn().mockResolvedValue([{ id: 'new-id' }]),
        };
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));

vi.doMock('../../db/schema.js', () => ({
  userPipelineAccess: {
    id: 'id',
    userId: 'userId',
    pipelineId: 'pipelineId',
    teamId: 'teamId',
    activatedAt: 'activatedAt',
    creditsPaid: 'creditsPaid',
  },
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
    createdAt: 'createdAt',
  },
}));

describe('pipeline-access.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    selectCallIdx = 0;
  });

  describe('hasPipelineAccess', () => {
    it('should return false when no access record exists', async () => {
      selectResults = [[]];

      const { hasPipelineAccess } = await import('../pipeline-access.service.js');
      const result = await hasPipelineAccess('user-1', 'pipeline-a');

      expect(result).toBe(false);
    });

    it('should return true when access record exists', async () => {
      selectResults = [[{ id: 'access-1' }]];

      const { hasPipelineAccess } = await import('../pipeline-access.service.js');
      const result = await hasPipelineAccess('user-1', 'pipeline-a');

      expect(result).toBe(true);
    });
  });

  describe('activatePipeline', () => {
    it('should return alreadyOwned=true without charging when user already has access', async () => {
      // hasPipelineAccess check returns existing row
      selectResults = [[{ id: 'access-1' }]];

      const { activatePipeline } = await import('../pipeline-access.service.js');
      const result = await activatePipeline('user-1', 'pipeline-a', 'Test Pipeline', 10);

      expect(result.alreadyOwned).toBe(true);
      expect(result.creditsPaid).toBe(0);
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it('should deduct credits and record access for first-time activation', async () => {
      // hasPipelineAccess check returns no row, then getBalance returns 50, then getBalance after deduct returns 40
      selectResults = [[], [{ balance: 50 }], [{ balance: 40 }]];

      const { activatePipeline } = await import('../pipeline-access.service.js');
      const result = await activatePipeline('user-1', 'pipeline-a', 'Test Pipeline', 10);

      expect(result.alreadyOwned).toBe(false);
      expect(result.creditsPaid).toBe(10);
      expect(result.balance).toBe(40);
    });

    it('should record access without deducting when creditCost is 0', async () => {
      // hasPipelineAccess check returns no row
      selectResults = [[]];

      const { activatePipeline } = await import('../pipeline-access.service.js');
      const result = await activatePipeline('user-1', 'free-pipeline', 'Free Pipeline', 0);

      expect(result.alreadyOwned).toBe(false);
      expect(result.creditsPaid).toBe(0);
      expect(result.balance).toBe(0);
    });
  });

  describe('listOwnedPipelines', () => {
    it('should return empty array when user owns no pipelines', async () => {
      selectResults = [[]];

      const { listOwnedPipelines } = await import('../pipeline-access.service.js');
      const result = await listOwnedPipelines('user-1');

      expect(result).toEqual([]);
    });

    it('should return owned pipeline records', async () => {
      const mockPipelines = [
        {
          id: 'access-1',
          pipelineId: 'pipeline-a',
          teamId: null,
          activatedAt: new Date('2026-03-20'),
          creditsPaid: 10,
        },
        {
          id: 'access-2',
          pipelineId: 'pipeline-b',
          teamId: 'team-1',
          activatedAt: new Date('2026-03-21'),
          creditsPaid: 15,
        },
      ];
      selectResults = [mockPipelines];

      const { listOwnedPipelines } = await import('../pipeline-access.service.js');
      const result = await listOwnedPipelines('user-1');

      expect(result).toHaveLength(2);
      expect(result[0].pipelineId).toBe('pipeline-a');
      expect(result[1].pipelineId).toBe('pipeline-b');
      expect(result[1].teamId).toBe('team-1');
    });
  });
});
