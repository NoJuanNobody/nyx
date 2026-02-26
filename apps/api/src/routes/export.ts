import type { FastifyPluginAsync } from 'fastify';
import { exportService } from '../services/export.service.js';

export const exportRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/export/documents/:id/export/markdown — download document as markdown
  app.get('/documents/:id/export/markdown', async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await exportService.toMarkdown(id);
    if (!result) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    const filename = `${result.title.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`;

    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(result.content);
  });

  // GET /api/export/documents/:id/export/pdf — download document as PDF
  app.get('/documents/:id/export/pdf', async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await exportService.toPdf(id);
    if (!result) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    const filename = `${result.title.replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;

    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(result.buffer);
  });
};
