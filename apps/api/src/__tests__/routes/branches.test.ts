import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { branchRoutes } from '../../routes/branches.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../services/branch.service.js', () => ({
  branchService: {
    listByDocument: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    updateContent: vi.fn(),
    diff: vi.fn(),
    approve: vi.fn(),
    merge: vi.fn(),
  },
}));

import { branchService } from '../../services/branch.service.js';

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
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function buildBranchApp(role = 'developer') {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', role, teamId: 'team-1' } as any;
  });
  app.register(branchRoutes, { prefix: '/api/documents' });
  await app.ready();
  return app;
}

describe('Branch Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/documents/:documentId/branches', () => {
    it('returns list of branches', async () => {
      const branches = [makeBranch(), makeBranch({ id: 'branch-2' })];
      (branchService.listByDocument as any).mockResolvedValue(branches);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/branches',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveLength(2);
    });
  });

  describe('POST /api/documents/:documentId/branches', () => {
    it('creates branch and returns 201', async () => {
      const branch = makeBranch();
      (branchService.create as any).mockResolvedValue(branch);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/branches',
        payload: { name: 'feature-branch', baseVersionId: 'version-1' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('feature-branch');
    });
  });

  describe('GET /api/documents/:documentId/branches/:branchId', () => {
    it('returns branch by id', async () => {
      const branch = makeBranch();
      (branchService.getById as any).mockResolvedValue(branch);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/branches/branch-1',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).id).toBe('branch-1');
    });

    it('returns 404 when branch not found', async () => {
      (branchService.getById as any).mockResolvedValue(null);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/branches/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/documents/:documentId/branches/:branchId', () => {
    it('updates branch content', async () => {
      const branch = makeBranch({ content: 'Updated content' });
      (branchService.updateContent as any).mockResolvedValue(branch);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/documents/doc-1/branches/branch-1',
        payload: { content: 'Updated content' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/documents/:documentId/branches/:branchId/diff', () => {
    it('returns diff', async () => {
      const diff = {
        branchContent: '# Branch',
        baseContent: '# Base',
        branchName: 'feature',
        baseVersion: 1,
      };
      (branchService.diff as any).mockResolvedValue(diff);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/branches/branch-1/diff',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.branchContent).toBe('# Branch');
    });
  });

  describe('POST /api/documents/:documentId/branches/:branchId/approve', () => {
    it('approves branch', async () => {
      const branch = makeBranch({ status: 'approved' });
      (branchService.approve as any).mockResolvedValue(branch);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/branches/branch-1/approve',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('approved');
    });

    it('returns 400 when approve throws', async () => {
      (branchService.approve as any).mockRejectedValue(new Error('Branch already merged'));

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/branches/branch-1/approve',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Branch already merged');
    });
  });

  describe('POST /api/documents/:documentId/branches/:branchId/merge', () => {
    it('merges branch', async () => {
      const branch = makeBranch({ mergedAt: new Date().toISOString() });
      (branchService.merge as any).mockResolvedValue(branch);

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/branches/branch-1/merge',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).mergedAt).not.toBeNull();
    });

    it('returns 400 when merge throws', async () => {
      (branchService.merge as any).mockRejectedValue(
        new Error('Branch must be approved before merging'),
      );

      const app = await buildBranchApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/branches/branch-1/merge',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/approved/);
    });
  });
});
