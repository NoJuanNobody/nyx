import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { changeProposalRoutes } from '../../routes/change-proposals.js';

const mockChangeProposalService = vi.hoisted(() => ({
  generate: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  push: vi.fn(),
}));
vi.mock('../../services/change-proposal.service.js', () => ({ changeProposalService: mockChangeProposalService }));
vi.mock('../../middleware/permissions.js', () => ({ requireRole: () => async () => {} }));
vi.mock('../../services/audit.service.js', () => ({ auditService: { recordEvent: vi.fn().mockResolvedValue({}) } }));
vi.mock('../../services/timeline.service.js', () => ({ timelineService: { create: vi.fn().mockResolvedValue({}) } }));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', clerkId: 'clerk_1', email: 'test@test.com', name: 'Test User', avatarUrl: null, role: 'admin' } as any;
  });
  app.register(changeProposalRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Change Proposal Routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /api/documents/:docId/change-proposals/generate creates proposal', async () => {
    const proposal = { id: 'p-1', title: 'Proposal', teamId: 'team-1', documentId: 'doc-1' };
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: 'team-1' }]),
      }),
    } as any);
    mockChangeProposalService.generate.mockResolvedValueOnce(proposal);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/documents/doc-1/change-proposals/generate' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).title).toBe('Proposal');
  });

  it('POST generate returns 404 for missing document', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/documents/nonexistent/change-proposals/generate' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/documents/:docId/change-proposals lists proposals', async () => {
    mockChangeProposalService.list.mockResolvedValueOnce([{ id: 'p-1' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/change-proposals' });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH /api/change-proposals/:id/approve approves proposal', async () => {
    const proposal = { id: 'p-1', teamId: 'team-1', documentId: 'doc-1' };
    mockChangeProposalService.getById.mockResolvedValueOnce(proposal);
    mockChangeProposalService.approve.mockResolvedValueOnce({ ...proposal, status: 'approved' });

    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/change-proposals/p-1/approve', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH /api/change-proposals/:id/approve returns 404 for missing', async () => {
    mockChangeProposalService.getById.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/change-proposals/nonexistent/approve', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /api/change-proposals/:id/reject rejects proposal', async () => {
    const proposal = { id: 'p-1', teamId: 'team-1', documentId: 'doc-1' };
    mockChangeProposalService.getById.mockResolvedValueOnce(proposal);
    mockChangeProposalService.reject.mockResolvedValueOnce({ ...proposal, status: 'rejected' });

    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/change-proposals/p-1/reject' });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/change-proposals/:id/push pushes proposal', async () => {
    const proposal = { id: 'p-1', teamId: 'team-1', documentId: 'doc-1', title: 'P1' };
    mockChangeProposalService.getById.mockResolvedValueOnce(proposal);
    mockChangeProposalService.push.mockResolvedValueOnce({ createdTickets: [{ id: 't-1' }] });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/change-proposals/p-1/push' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).createdTickets).toHaveLength(1);
  });

  it('POST /api/change-proposals/:id/push returns 404 for missing', async () => {
    mockChangeProposalService.getById.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/change-proposals/nonexistent/push' });
    expect(res.statusCode).toBe(404);
  });
});
