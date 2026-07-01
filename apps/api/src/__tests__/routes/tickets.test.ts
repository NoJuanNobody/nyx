import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

const { mockTicketService } = vi.hoisted(() => ({
  mockTicketService: {
    listByTeam: vi.fn(),
    syncAllForTeam: vi.fn(),
    listByDocument: vi.fn(),
    createFromDocument: vi.fn(),
    syncStatus: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('../../services/ticket.service.js', () => ({
  ticketService: mockTicketService,
}));

vi.mock('../../services/timeline.service.js', () => ({
  timelineService: { create: vi.fn() },
}));

vi.mock('../../services/github.service.js', () => ({
  GitHubTokenExpiredError: class GitHubTokenExpiredError extends Error {},
}));

import { ticketRoutes } from '../../routes/tickets.js';

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
  app.register(ticketRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Ticket Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/tickets?teamId=t1 returns tickets', async () => {
    const tickets = [{ id: 'ticket-1', title: 'Fix bug' }];
    mockTicketService.listByTeam.mockResolvedValue(tickets);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/tickets?teamId=t1' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe('Fix bug');
  });

  it('GET /api/tickets without teamId returns 400', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/tickets' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  it('POST /api/tickets/sync-all?teamId=t1 returns synced count', async () => {
    mockTicketService.syncAllForTeam.mockResolvedValue(3);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/tickets/sync-all?teamId=t1' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.synced).toBe(3);
  });

  it('GET /api/documents/:docId/tickets returns tickets', async () => {
    const tickets = [{ id: 'ticket-1', documentId: 'doc-1' }];
    mockTicketService.listByDocument.mockResolvedValue(tickets);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/tickets' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
  });

  it('POST /api/documents/:docId/tickets creates ticket and returns 201', async () => {
    const ticket = { id: 'ticket-1', title: 'New feature', externalUrl: 'https://github.com/issues/1' };
    mockTicketService.createFromDocument.mockResolvedValue(ticket);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/tickets',
      payload: { provider: 'github', title: 'New feature', body: 'Description here' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('ticket-1');
  });

  it('PATCH /api/tickets/:id/status updates ticket status', async () => {
    const ticket = { id: 'ticket-1', title: 'Fix bug', status: 'closed' };
    mockTicketService.updateStatus.mockResolvedValue(ticket);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tickets/ticket-1/status',
      payload: { status: 'closed' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('closed');
    expect(mockTicketService.updateStatus).toHaveBeenCalledWith('ticket-1', 'closed');
  });

  it('PATCH /api/tickets/:id/status rejects invalid status', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tickets/ticket-1/status',
      payload: { status: 'invalid' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('status must be one of');
  });

  it('PATCH /api/tickets/:id/status returns 404 for missing ticket', async () => {
    mockTicketService.updateStatus.mockRejectedValue(new Error('Ticket not found'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tickets/nonexistent/status',
      payload: { status: 'closed' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /api/documents/:docId/tickets passes repo param to service when provided', async () => {
    const ticket = { id: 'ticket-2', title: 'With repo', externalUrl: 'https://github.com/issues/2' };
    mockTicketService.createFromDocument.mockResolvedValue(ticket);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/tickets',
      payload: {
        provider: 'github',
        title: 'With repo',
        body: 'Description',
        repo: { owner: 'myorg', name: 'myrepo' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockTicketService.createFromDocument).toHaveBeenCalledWith(
      'doc-1',
      { provider: 'github', identifier: 'myorg/myrepo' },
      'With repo',
      'Description',
      'user-1',
    );
  });
});
