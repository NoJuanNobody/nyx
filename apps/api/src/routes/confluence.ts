import type { FastifyPluginAsync } from 'fastify';
import { confluenceService } from '../services/confluence.service.js';

export const confluenceRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/confluence/spaces — list available Confluence spaces
  app.get('/spaces', async () => {
    return confluenceService.listSpaces();
  });

  // GET /api/confluence/spaces/:key/pages — list pages in a space
  app.get('/spaces/:key/pages', async (request) => {
    const { key } = request.params as { key: string };
    return confluenceService.listPages(key);
  });

  // GET /api/confluence/pages/:id — get a single page
  app.get('/pages/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const page = await confluenceService.getPage(id);

    if (!page) {
      reply.code(404);
      return { error: 'Page not found' };
    }

    return page;
  });

  // POST /api/confluence/import — import a single page with quality check
  app.post('/import', async (request, reply) => {
    const { pageId, teamId } = request.body as {
      pageId?: string;
      teamId?: string;
    };

    if (!pageId || !teamId) {
      reply.code(400);
      return { error: 'pageId and teamId are required' };
    }

    try {
      return await confluenceService.importPage({ pageId, teamId });
    } catch (err) {
      reply.code(404);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // POST /api/confluence/import-space — import all pages in a space
  app.post('/import-space', async (request, reply) => {
    const { spaceKey, teamId } = request.body as {
      spaceKey?: string;
      teamId?: string;
    };

    if (!spaceKey || !teamId) {
      reply.code(400);
      return { error: 'spaceKey and teamId are required' };
    }

    return confluenceService.importSpace({ spaceKey, teamId });
  });
};
