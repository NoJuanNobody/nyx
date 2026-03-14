import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeVersion, makeDocument } from '../helpers/factories.js';
import { branchService } from '../../services/branch.service.js';

vi.mock('../../services/version.service.js', () => ({
  versionService: {
    getById: vi.fn(),
    create: vi.fn(),
  },
}));

import { versionService } from '../../services/version.service.js';

function makeBranch(overrides?: Record<string, unknown>) {
  return {
    id: 'branch-1',
    documentId: 'doc-1',
    name: 'feature-branch',
    baseVersionId: 'version-1',
    content: '# Branch content',
    status: 'draft',
    createdById: 'user-1',
    reviewedById: null,
    mergedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('Branch Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('creates branch from base version content', async () => {
      const version = makeVersion({ id: 'version-1', content: '# Version content' });
      const branch = makeBranch({ content: version.content });

      (versionService.getById as any).mockResolvedValue(version);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      const result = await branchService.create({
        documentId: 'doc-1',
        name: 'feature-branch',
        baseVersionId: 'version-1',
        createdById: 'user-1',
      });

      expect(result).toEqual(branch);
      expect(versionService.getById).toHaveBeenCalledWith('version-1');
    });

    it('throws when base version not found', async () => {
      (versionService.getById as any).mockResolvedValue(null);

      await expect(
        branchService.create({
          documentId: 'doc-1',
          name: 'feature',
          baseVersionId: 'missing-version',
          createdById: 'user-1',
        }),
      ).rejects.toThrow('Base version not found');
    });

    it('sets status to draft on create', async () => {
      const version = makeVersion({ id: 'version-1' });
      const branch = makeBranch({ status: 'draft' });

      (versionService.getById as any).mockResolvedValue(version);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      const result = await branchService.create({
        documentId: 'doc-1',
        name: 'feature',
        baseVersionId: 'version-1',
        createdById: 'user-1',
      });

      expect(result.status).toBe('draft');
    });
  });

  describe('listByDocument', () => {
    it('returns all branches for document', async () => {
      const branches = [makeBranch(), makeBranch({ id: 'branch-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(branches),
        }),
      } as any);

      const result = await branchService.listByDocument('doc-1');

      expect(result).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns branch by id', async () => {
      const branch = makeBranch();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      const result = await branchService.getById('branch-1');

      expect(result).toEqual(branch);
    });

    it('returns null when branch not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await branchService.getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('updateContent', () => {
    it('updates branch content and returns updated branch', async () => {
      const branch = makeBranch({ content: 'Updated content' });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([branch]),
          }),
        }),
      } as any);

      const result = await branchService.updateContent('branch-1', 'Updated content');

      expect(result.content).toBe('Updated content');
    });
  });

  describe('diff', () => {
    it('returns diff between branch and base version', async () => {
      const branch = makeBranch({ content: '# Branch', baseVersionId: 'version-1', name: 'feature' });
      const version = makeVersion({ id: 'version-1', content: '# Base', version: 2 });

      // getById call
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      (versionService.getById as any).mockResolvedValue(version);

      const result = await branchService.diff('branch-1');

      expect(result.branchContent).toBe('# Branch');
      expect(result.baseContent).toBe('# Base');
      expect(result.branchName).toBe('feature');
      expect(result.baseVersion).toBe(2);
    });

    it('throws when branch not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(branchService.diff('nonexistent')).rejects.toThrow('Branch not found');
    });
  });

  describe('approve', () => {
    it('sets status to approved and records reviewer', async () => {
      const branch = makeBranch({ status: 'draft', mergedAt: null });
      const approved = makeBranch({ status: 'approved', reviewedById: 'reviewer-1' });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([approved]),
          }),
        }),
      } as any);

      const result = await branchService.approve('branch-1', 'reviewer-1');

      expect(result.status).toBe('approved');
      expect(result.reviewedById).toBe('reviewer-1');
    });

    it('throws when branch not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(branchService.approve('nonexistent', 'user-1')).rejects.toThrow('Branch not found');
    });

    it('throws when branch already merged', async () => {
      const branch = makeBranch({ mergedAt: new Date() });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      await expect(branchService.approve('branch-1', 'user-1')).rejects.toThrow('Branch already merged');
    });
  });

  describe('merge', () => {
    it('merges approved branch and creates version', async () => {
      const branch = makeBranch({ status: 'approved', mergedAt: null, name: 'feature' });
      const merged = makeBranch({ mergedAt: new Date() });

      // getById
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      // update document
      mockDb.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        } as any)
        // update branch mergedAt
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([merged]),
            }),
          }),
        } as any);

      (versionService.create as any).mockResolvedValue(makeVersion());

      const result = await branchService.merge('branch-1', 'user-1');

      expect(result.mergedAt).not.toBeNull();
      expect(versionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Merged branch "feature"',
        }),
      );
    });

    it('throws when branch not approved', async () => {
      const branch = makeBranch({ status: 'draft', mergedAt: null });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      await expect(branchService.merge('branch-1', 'user-1')).rejects.toThrow(
        'Branch must be approved before merging',
      );
    });

    it('throws when branch already merged', async () => {
      const branch = makeBranch({ status: 'approved', mergedAt: new Date() });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      await expect(branchService.merge('branch-1', 'user-1')).rejects.toThrow('Branch already merged');
    });

    it('throws when branch not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(branchService.merge('nonexistent', 'user-1')).rejects.toThrow('Branch not found');
    });
  });
});
