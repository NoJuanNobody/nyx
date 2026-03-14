import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { auditRoutes } from '../../routes/audit.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: {
    getTrailForDocument: vi.fn(),
    getTraceChain: vi.fn(),
    getTeamActivity: vi.fn(),
  },
}));

import { auditService } from '../../services/audit.service.js';

function makeAuditEvent(overrides?: Record<string, unknown>) {
  return {
    id: 'event-1',
    teamId: 'team-1',
    eventType: 'doc_edit',
    actorId: 'user-1',
    actorName: 'Test User',
    documentId: 'doc-1',
    snapshotId: null,
    ticketId: null,
    commitSha: null,
    parentEventId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function buildAuditApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', role: 'viewer', teamId: 'team-1' } as any;
  });
  app.register(auditRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Audit Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/documents/:documentId/audit-trail', () => {
    it('returns audit events for document', async () => {
      const events = [makeAuditEvent(), makeAuditEvent({ id: 'event-2' })];
      (auditService.getTrailForDocument as any).mockResolvedValue(events);

      const app = await buildAuditApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/audit-trail',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.documentId).toBe('doc-1');
      expect(body.events).toHaveLength(2);
    });

    it('returns empty events array when none found', async () => {
      (auditService.getTrailForDocument as any).mockResolvedValue([]);

      const app = await buildAuditApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/audit-trail',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.events).toEqual([]);
    });
  });

  describe('GET /api/audit-trail/:eventId/trace', () => {
    it('returns trace chain for event', async () => {
      const chain = [makeAuditEvent(), makeAuditEvent({ id: 'event-2' })];
      (auditService.getTraceChain as any).mockResolvedValue(chain);

      const app = await buildAuditApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-trail/event-1/trace',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.eventId).toBe('event-1');
      expect(body.chain).toHaveLength(2);
    });
  });

  describe('GET /api/teams/:teamId/activity', () => {
    it('returns team activity', async () => {
      const events = [makeAuditEvent()];
      (auditService.getTeamActivity as any).mockResolvedValue(events);

      const app = await buildAuditApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams/team-1/activity',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.teamId).toBe('team-1');
      expect(body.events).toHaveLength(1);
    });

    it('passes limit query param to service', async () => {
      (auditService.getTeamActivity as any).mockResolvedValue([]);

      const app = await buildAuditApp();
      await app.inject({
        method: 'GET',
        url: '/api/teams/team-1/activity?limit=10',
      });

      expect(auditService.getTeamActivity).toHaveBeenCalledWith('team-1', 10);
    });

    it('uses default limit of 50 when not specified', async () => {
      (auditService.getTeamActivity as any).mockResolvedValue([]);

      const app = await buildAuditApp();
      await app.inject({
        method: 'GET',
        url: '/api/teams/team-1/activity',
      });

      expect(auditService.getTeamActivity).toHaveBeenCalledWith('team-1', 50);
    });
  });
});
