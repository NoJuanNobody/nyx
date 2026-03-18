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

vi.mock('../../services/export-latex.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/export-latex.service.js')>(
    '../../services/export-latex.service.js',
  );
  return {
    ...actual,
    exportLatexService: {
      toLatex: vi.fn(),
    },
  };
});

import { exportLatexService } from '../../services/export-latex.service.js';

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

describe('POST /api/documents/:id/export/latex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns LaTeX content with correct headers using default theme', async () => {
    const texContent = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}';
    vi.mocked(exportLatexService.toLatex).mockResolvedValue({
      title: 'Research Paper',
      content: texContent,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/export/latex',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-tex');
    expect(res.headers['content-disposition']).toContain('Research_Paper.tex');
    expect(res.body).toBe(texContent);
    expect(vi.mocked(exportLatexService.toLatex)).toHaveBeenCalledWith('doc-1', 'plain');
  });

  it('passes theme parameter to service', async () => {
    vi.mocked(exportLatexService.toLatex).mockResolvedValue({
      title: 'Paper',
      content: '\\documentclass[conference]{IEEEtran}',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/export/latex',
      payload: { theme: 'ieee' },
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(exportLatexService.toLatex)).toHaveBeenCalledWith('doc-1', 'ieee');
  });

  it('returns 400 for invalid theme', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/export/latex',
      payload: { theme: 'invalid-theme' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Invalid theme "invalid-theme". Must be one of: ieee, acm, apa, plain',
    });
  });

  it('returns 404 for missing document', async () => {
    vi.mocked(exportLatexService.toLatex).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/missing/export/latex',
      payload: { theme: 'plain' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Document not found' });
  });

  it('sanitizes filename for content-disposition', async () => {
    vi.mocked(exportLatexService.toLatex).mockResolvedValue({
      title: 'My Paper (Draft) v2.0',
      content: 'latex content',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/export/latex',
      payload: { theme: 'acm' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('.tex');
    // Special chars should be replaced with underscores
    expect(res.headers['content-disposition']).not.toContain('(');
  });
});
