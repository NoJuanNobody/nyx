import type { FastifyPluginAsync } from 'fastify';
import { webSearch } from '../services/search.service.js';

export const searchRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/search — perform a web search
  app.post('/', async (request, reply) => {
    const { query } = request.body as { query?: string };

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      reply.code(400);
      return { error: 'query is required and must be a non-empty string' };
    }

    const results = await webSearch(query.trim());
    return { results };
  });
};
