import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeTemplate } from '../helpers/factories.js';
import Fastify from 'fastify';
import { templateRoutes } from '../../routes/templates.js';

async function buildTemplateApp() {
  const app = Fastify({ logger: false });
  app.register(templateRoutes, { prefix: '/api/templates' });
  await app.ready();
  return app;
}

describe('Template Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/templates returns templates ordered by sortOrder', async () => {
    const templates = [
      makeTemplate({ sortOrder: 0, name: 'First' }),
      makeTemplate({ sortOrder: 1, name: 'Second' }),
      makeTemplate({ sortOrder: 2, name: 'Third' }),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(templates),
      }),
    } as any);

    const app = await buildTemplateApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/templates',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(3);
    expect(body[0].name).toBe('First');
    expect(body[1].name).toBe('Second');
    expect(body[2].name).toBe('Third');
  });

  it('GET /api/templates?stage=X filters templates by stage', async () => {
    const allTemplates = [
      makeTemplate({ stage: 'definition', name: 'PRD', sortOrder: 0 }),
      makeTemplate({ stage: 'architecture', name: 'Tech Spec', sortOrder: 1 }),
      makeTemplate({ stage: 'definition', name: 'User Stories', sortOrder: 2 }),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(allTemplates),
      }),
    } as any);

    const app = await buildTemplateApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/templates?stage=definition',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body.every((t: any) => t.stage === 'definition')).toBe(true);
  });

  it('GET /api/templates deduplicates by (stage, name), keeping first by sortOrder', async () => {
    const templates = [
      makeTemplate({ stage: 'definition', name: 'PRD', sortOrder: 0, id: 'keep-1' }),
      makeTemplate({ stage: 'definition', name: 'PRD', sortOrder: 1, id: 'dup-1' }),
      makeTemplate({ stage: 'definition', name: 'User Stories', sortOrder: 2, id: 'keep-2' }),
      makeTemplate({ stage: 'architecture', name: 'PRD', sortOrder: 3, id: 'keep-3' }),
      makeTemplate({ stage: 'architecture', name: 'PRD', sortOrder: 4, id: 'dup-2' }),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(templates),
      }),
    } as any);

    const app = await buildTemplateApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/templates',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should remove dup-1 and dup-2 (duplicate stage+name pairs)
    expect(body).toHaveLength(3);
    const ids = body.map((t: any) => t.id);
    expect(ids).toContain('keep-1');
    expect(ids).toContain('keep-2');
    expect(ids).toContain('keep-3');
    expect(ids).not.toContain('dup-1');
    expect(ids).not.toContain('dup-2');
  });

  it('GET /api/templates/:id returns a single template', async () => {
    const template = makeTemplate({ id: 'tmpl-1', name: 'Specific Template' });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([template]),
      }),
    } as any);

    const app = await buildTemplateApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/templates/tmpl-1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('tmpl-1');
    expect(body.name).toBe('Specific Template');
  });

  it('GET /api/templates/:id returns 404 for missing template', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildTemplateApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/templates/nonexistent',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not found/i);
  });
});
