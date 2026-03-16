import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { mockSprintService } = vi.hoisted(() => ({
  mockSprintService: {
    getSprintCapacity: vi.fn(),
    checkSprintCapacity: vi.fn(),
    deferTicket: vi.fn(),
    _resetDeferred: vi.fn(),
  },
}));

vi.mock('../../services/sprint.service.js', () => ({
  sprintService: mockSprintService,
}));

import { sprintRoutes } from '../../routes/sprint.js';

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
  app.register(sprintRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

const mockCapacity = {
  sprintName: 'Sprint 12',
  totalPoints: 40,
  usedPoints: 34,
  capacityPercent: 85,
  tickets: [
    { id: 'MOCK-101', title: 'Test ticket', points: 5, status: 'in_progress' },
    { id: 'MOCK-102', title: 'Another ticket', points: 8, status: 'todo' },
  ],
};

describe('Sprint Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/sprint/capacity', () => {
    it('returns sprint capacity for a team', async () => {
      mockSprintService.getSprintCapacity.mockResolvedValue(mockCapacity);

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/sprint/capacity?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sprintName).toBe('Sprint 12');
      expect(body.capacityPercent).toBe(85);
      expect(body.tickets).toHaveLength(2);
      expect(mockSprintService.getSprintCapacity).toHaveBeenCalledWith('team-1');
    });

    it('returns 400 when teamId is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/sprint/capacity',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });

  describe('POST /api/sprint/check', () => {
    it('returns capacity check result', async () => {
      const checkResult = {
        capacity: mockCapacity,
        overThreshold: true,
        suggestions: ['Defer "Another ticket" (MOCK-102, 8 pts) to free capacity'],
      };
      mockSprintService.checkSprintCapacity.mockResolvedValue(checkResult);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/sprint/check',
        payload: { teamId: 'team-1', newTicketPoints: 5 },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.overThreshold).toBe(true);
      expect(body.suggestions).toHaveLength(1);
      expect(mockSprintService.checkSprintCapacity).toHaveBeenCalledWith('team-1', 5, undefined);
    });

    it('returns 400 when teamId is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/sprint/check',
        payload: { newTicketPoints: 5 },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it('works without newTicketPoints', async () => {
      mockSprintService.checkSprintCapacity.mockResolvedValue({
        capacity: mockCapacity,
        overThreshold: true,
        suggestions: [],
      });

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/sprint/check',
        payload: { teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockSprintService.checkSprintCapacity).toHaveBeenCalledWith('team-1', undefined, undefined);
    });
  });

  describe('POST /api/sprint/defer', () => {
    it('defers a ticket successfully', async () => {
      mockSprintService.deferTicket.mockResolvedValue({ deferred: true });

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/sprint/defer',
        payload: { teamId: 'team-1', ticketKey: 'MOCK-102' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deferred).toBe(true);
      expect(mockSprintService.deferTicket).toHaveBeenCalledWith('team-1', 'MOCK-102');
    });

    it('returns 400 when teamId is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/sprint/defer',
        payload: { ticketKey: 'MOCK-102' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when ticketKey is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/sprint/defer',
        payload: { teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
