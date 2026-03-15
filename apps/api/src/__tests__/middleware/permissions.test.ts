import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { requireRole } from '../../middleware/permissions.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    user: { id: 'user-1', email: 'test@test.com', name: 'Test', role: 'viewer', clerkId: null, avatarUrl: null },
    params: {},
    query: {},
    body: {},
    url: '/test',
    method: 'GET',
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...overrides,
  } as unknown as FastifyRequest;
}

function mockReply(): FastifyReply {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as FastifyReply;
}

describe('Permissions Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('viewer blocked from admin-only route → 403', async () => {
    const handler = requireRole({ minimumRole: 'admin', source: 'team' });
    const req = mockRequest({ params: { id: 'team-1' } as any });
    const reply = mockReply();

    // Mock: getUserTeamRole returns 'viewer'
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: 'viewer' }]),
      }),
    } as any);

    await handler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('admin') }),
    );
  });

  it('admin allowed on admin-only route → passes', async () => {
    const handler = requireRole({ minimumRole: 'admin', source: 'team' });
    const req = mockRequest({ params: { id: 'team-1' } as any });
    const reply = mockReply();

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: 'admin' }]),
      }),
    } as any);

    const result = await handler(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('owner passes any minimum role check', async () => {
    const handler = requireRole({ minimumRole: 'admin', source: 'team' });
    const req = mockRequest({ params: { id: 'team-1' } as any });
    const reply = mockReply();

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: 'owner' }]),
      }),
    } as any);

    await handler(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('non-member of team → 403 "not a member"', async () => {
    const handler = requireRole({ minimumRole: 'viewer', source: 'team' });
    const req = mockRequest({ params: { id: 'team-1' } as any });
    const reply = mockReply();

    // No membership found
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    await handler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('not a member') }),
    );
  });

  it('source: "team" reads teamId from params.id', async () => {
    const handler = requireRole({ minimumRole: 'viewer', source: 'team' });
    const req = mockRequest({ params: { id: 'team-abc' } as any });
    const reply = mockReply();

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role: 'viewer' }]),
      }),
    } as any);

    await handler(req, reply);

    // Should not return an error — team resolved from params.id
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('source: "document" looks up document to find teamId, returns 404 if doc missing', async () => {
    const handler = requireRole({ minimumRole: 'viewer', source: 'document' });
    const req = mockRequest({ params: { id: 'doc-missing' } as any });
    const reply = mockReply();

    // Document lookup returns empty
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    await handler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Document not found' }),
    );
  });

  it('source: "integration" looks up integration to find teamId', async () => {
    const handler = requireRole({ minimumRole: 'viewer', source: 'integration' });
    const req = mockRequest({ params: { id: 'int-1' } as any });
    const reply = mockReply();

    let callCount = 0;
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve([{ teamId: 'team-1' }]); // integration
          return Promise.resolve([{ role: 'viewer' }]); // membership
        }),
      }),
    } as any);

    await handler(req, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('missing teamId → 400 "Unable to determine team context"', async () => {
    const handler = requireRole({ minimumRole: 'viewer', source: 'request' });
    // No teamId in params, query, or body
    const req = mockRequest({ params: {}, query: {}, body: {} });
    const reply = mockReply();

    await handler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Unable to determine team context' }),
    );
  });
});
