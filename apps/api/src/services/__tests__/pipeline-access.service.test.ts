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
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
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
    it('returns alreadyOwned=true without inserting when user already has access', async () => {
      selectResults = [[{ id: 'access-1' }]];

      const { activatePipeline } = await import('../pipeline-access.service.js');
      const result = await activatePipeline('user-1', 'pipeline-a', 'Test Pipeline');

      expect(result).toEqual({ alreadyOwned: true, creditsPaid: 0 });
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it('records access for free on first activation (no credit charge)', async () => {
      selectResults = [[]];

      const { activatePipeline } = await import('../pipeline-access.service.js');
      const result = await activatePipeline('user-1', 'pipeline-a', 'Test Pipeline');

      expect(result).toEqual({ alreadyOwned: false, creditsPaid: 0 });
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', pipelineId: 'pipeline-a', creditsPaid: 0 }),
      );
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
