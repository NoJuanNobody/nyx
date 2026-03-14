import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';
import { exportRoutes } from '../../routes/export.js';

vi.mock('../../services/export.service.js', () => ({
  exportService: {
    toMarkdown: vi.fn(),
    toPdf: vi.fn(),
  },
}));

import { exportService } from '../../services/export.service.js';

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
  app.register(exportRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('GET /api/documents/:id/export/markdown', () => {
  it('returns markdown content with correct headers', async () => {
    vi.mocked(exportService.toMarkdown).mockResolvedValue({
      title: 'Test Doc',
      content: '# Test Doc\n\nHello world',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/export/markdown',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('Test_Doc.md');
    expect(res.body).toBe('# Test Doc\n\nHello world');
  });

  it('returns 404 for missing document', async () => {
    vi.mocked(exportService.toMarkdown).mockResolvedValue(null as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/missing/export/markdown',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Document not found' });
  });
});

describe('GET /api/documents/:id/export/pdf', () => {
  it('returns PDF buffer with correct headers', async () => {
    const pdfBuffer = Buffer.from('fake-pdf-content');
    vi.mocked(exportService.toPdf).mockResolvedValue({
      title: 'Test Doc',
      buffer: pdfBuffer,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/export/pdf',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('Test_Doc.pdf');
  });

  it('returns 404 for missing document', async () => {
    vi.mocked(exportService.toPdf).mockResolvedValue(null as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/missing/export/pdf',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Document not found' });
  });
});
