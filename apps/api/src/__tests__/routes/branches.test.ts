import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

const { mockBranchService } = vi.hoisted(() => ({
  mockBranchService: {
    listByDocument: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    updateContent: vi.fn(),
    diff: vi.fn(),
    approve: vi.fn(),
    merge: vi.fn(),
  },
}));

vi.mock('../../services/branch.service.js', () => ({
  branchService: mockBranchService,
}));

import { branchRoutes } from '../../routes/branches.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(branchRoutes, { prefix: '/api/documents' });
  await app.ready();
  return app;
}

describe('Branch Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/documents/:docId/branches returns branches', async () => {
    const branches = [{ id: 'branch-1', name: 'feature-x' }];
    mockBranchService.listByDocument.mockResolvedValue(branches);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/branches' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('feature-x');
  });

  it('POST /api/documents/:docId/branches creates branch and returns 201', async () => {
    const branch = { id: 'branch-1', name: 'feature-x', documentId: 'doc-1' };
    mockBranchService.create.mockResolvedValue(branch);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/branches',
      payload: { name: 'feature-x', baseVersionId: 'v-1' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('feature-x');
  });

  it('GET /api/documents/:docId/branches/:branchId returns branch', async () => {
    const branch = { id: 'branch-1', name: 'feature-x' };
    mockBranchService.getById.mockResolvedValue(branch);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/branches/branch-1' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('branch-1');
  });

  it('GET /api/documents/:docId/branches/:branchId returns 404 when not found', async () => {
    mockBranchService.getById.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/branches/nonexistent' });

    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/documents/:docId/branches/:branchId updates content', async () => {
    const updated = { id: 'branch-1', content: 'updated content' };
    mockBranchService.updateContent.mockResolvedValue(updated);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/documents/doc-1/branches/branch-1',
      payload: { content: 'updated content' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toBe('updated content');
  });

  it('POST /api/documents/:docId/branches/:branchId/approve approves branch', async () => {
    const approved = { id: 'branch-1', status: 'approved' };
    mockBranchService.approve.mockResolvedValue(approved);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/documents/doc-1/branches/branch-1/approve' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('approved');
  });

  it('POST /api/documents/:docId/branches/:branchId/merge merges branch', async () => {
    const merged = { id: 'branch-1', status: 'merged' };
    mockBranchService.merge.mockResolvedValue(merged);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/documents/doc-1/branches/branch-1/merge' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('merged');
  });
});
