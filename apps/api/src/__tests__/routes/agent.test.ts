import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { agentRoutes } from '../../routes/agent.js';

vi.mock('../../services/agent/loop.js', () => ({
  runAgentLoop: vi.fn().mockResolvedValue(undefined),
}));

const mockWorkflows = vi.hoisted(() => [
  { id: 'wf-1', name: 'Test Workflow', description: 'A test', defaultPrompt: 'do stuff', systemPrompt: 'You are a bot', tools: [] },
]);
vi.mock('../../services/agent/workflows.js', () => ({
  listWorkflows: () => mockWorkflows,
  getWorkflow: (id: string) => mockWorkflows.find((w: any) => w.id === id),
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: { recordEvent: vi.fn().mockResolvedValue({}) },
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', clerkId: 'clerk_1', email: 'test@test.com', name: 'Test User', avatarUrl: null, role: 'admin' } as any;
  });
  app.register(agentRoutes, { prefix: '/api/agent' });
  await app.ready();
  return app;
}

describe('Agent Routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('GET /api/agent/workflows returns workflows', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/agent/workflows' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('wf-1');
  });

  it('GET /api/agent/:sessionId returns session', async () => {
    const session = { id: 'sess-1', status: 'completed' };
    const toolCalls = [{ id: 'tc-1', sessionId: 'sess-1', sequence: 1 }];

    let selectCall = 0;
    mockDb.select.mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([session]),
            }),
          }),
        } as any;
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(toolCalls),
          }),
        }),
      } as any;
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/agent/sess-1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.session.id).toBe('sess-1');
    expect(body.toolCalls).toHaveLength(1);
  });

  it('GET /api/agent/:sessionId returns 404 for missing session', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/agent/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/agent/:sessionId/cancel cancels a non-running session', async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/agent/sess-1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cancelled).toBe(true);
  });

  it('GET /api/agent/sessions lists team sessions', async () => {
    const sessions = [{ id: 'sess-1' }, { id: 'sess-2' }];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(sessions),
          }),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/agent/sessions?teamId=team-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(2);
  });
});
