import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { agentRoutes } from '../../routes/agent.js';

vi.mock('../../services/agent/loop.js', () => ({
  runAgentLoop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/agent/workflows.js', () => ({
  listWorkflows: vi.fn().mockReturnValue([
    {
      id: 'draft-spec',
      name: 'Draft Spec',
      description: 'Drafts a spec document',
      defaultPrompt: 'Draft a spec',
      systemPrompt: 'You are a spec writer',
      tools: ['read_document'],
    },
  ]),
  getWorkflow: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: {
    recordEvent: vi.fn().mockResolvedValue({}),
  },
}));

import { runAgentLoop } from '../../services/agent/loop.js';

function makeSession(overrides?: Record<string, unknown>) {
  return {
    id: 'session-1',
    teamId: 'team-1',
    userId: 'user-1',
    documentId: null,
    prompt: 'Hello',
    status: 'completed',
    result: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function buildAgentApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', role: 'developer', teamId: 'team-1' } as any;
  });
  app.register(agentRoutes, { prefix: '/api/agent' });
  await app.ready();
  return app;
}

describe('Agent Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/agent/workflows', () => {
    it('returns list of available workflows', async () => {
      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent/workflows',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('draft-spec');
    });
  });

  describe('GET /api/agent/:sessionId', () => {
    it('returns session with tool calls', async () => {
      const session = makeSession();

      // First select: session
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([session]),
            }),
          }),
        } as any)
        // Second select: tool calls
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent/session-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.session.id).toBe('session-1');
      expect(body.toolCalls).toEqual([]);
    });

    it('returns 404 when session not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/agent/:sessionId/cancel', () => {
    it('cancels a non-running session by updating status', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/session-1/cancel',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).cancelled).toBe(true);
    });
  });

  describe('GET /api/agent/sessions', () => {
    it('returns sessions for team', async () => {
      const sessions = [makeSession(), makeSession({ id: 'session-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(sessions),
            }),
          }),
        }),
      } as any);

      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agent/sessions?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveLength(2);
    });

    it('respects limit query param', async () => {
      const limitMock = vi.fn().mockResolvedValue([]);

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: limitMock,
            }),
          }),
        }),
      } as any);

      const app = await buildAgentApp();
      await app.inject({
        method: 'GET',
        url: '/api/agent/sessions?teamId=team-1&limit=5',
      });

      expect(limitMock).toHaveBeenCalledWith(5);
    });
  });

  describe('POST /api/agent/ (SSE session start)', () => {
    it('creates session and streams SSE response', async () => {
      const session = makeSession({ id: 'session-new', status: 'running' });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([session]),
        }),
      } as any);

      (runAgentLoop as any).mockResolvedValue(undefined);

      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/',
        payload: { prompt: 'Hello', teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.headers['x-session-id']).toBe('session-new');
    });

    it('calls runAgentLoop with user prompt', async () => {
      const session = makeSession({ id: 'session-x', status: 'running' });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([session]),
        }),
      } as any);

      (runAgentLoop as any).mockResolvedValue(undefined);

      const app = await buildAgentApp();
      await app.inject({
        method: 'POST',
        url: '/api/agent/',
        payload: { prompt: 'Analyze my code', teamId: 'team-1' },
      });

      expect(runAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({ userPrompt: 'Analyze my code' }),
      );
    });

    it('updates status to failed on agent loop error', async () => {
      const session = makeSession({ id: 'session-err', status: 'running' });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([session]),
        }),
      } as any);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      (runAgentLoop as any).mockRejectedValue(new Error('AI error'));

      const app = await buildAgentApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/',
        payload: { prompt: 'Fail', teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(200); // SSE already started
      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});
