import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { exportRoutes } from '../../routes/export.js';

vi.mock('../../services/export.service.js', () => ({
  exportService: {
    toMarkdown: vi.fn(),
    toPdf: vi.fn(),
  },
}));

import { exportService } from '../../services/export.service.js';

async function buildExportApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', role: 'viewer' } as any;
  });
  app.register(exportRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Export Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/documents/:id/export/markdown', () => {
    it('returns markdown with correct headers', async () => {
      (exportService.toMarkdown as any).mockResolvedValue({
        title: 'My Document',
        content: '# Hello',
      });

      const app = await buildExportApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/export/markdown',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toMatch(/My_Document\.md/);
      expect(res.body).toBe('# Hello');
    });

    it('sanitizes special characters from filename', async () => {
      (exportService.toMarkdown as any).mockResolvedValue({
        title: 'My Doc: Special/File*Name',
        content: 'content',
      });

      const app = await buildExportApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/export/markdown',
      });

      expect(res.headers['content-disposition']).not.toMatch(/[:/\*]/);
      expect(res.headers['content-disposition']).toMatch(/\.md/);
    });

    it('returns 404 when document not found', async () => {
      (exportService.toMarkdown as any).mockResolvedValue(null);

      const app = await buildExportApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/nonexistent/export/markdown',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('Document not found');
    });
  });

  describe('GET /api/documents/:id/export/pdf', () => {
    it('returns PDF with correct headers', async () => {
      const buffer = Buffer.from('fake-pdf-content');
      (exportService.toPdf as any).mockResolvedValue({
        title: 'My Document',
        buffer,
      });

      const app = await buildExportApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/export/pdf',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toMatch(/My_Document\.pdf/);
    });

    it('returns 404 when document not found', async () => {
      (exportService.toPdf as any).mockResolvedValue(null);

      const app = await buildExportApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/nonexistent/export/pdf',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('Document not found');
    });
  });
});
