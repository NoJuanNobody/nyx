import type { FastifyPluginAsync } from 'fastify';
import { retrieveChunks } from '../services/retrieval.service.js';

export const retrievalRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/retrieve — vector similarity search over document chunks
  app.post('/', async (request, reply) => {
    const { query, teamId, topK } = request.body as {
      query?: string;
      teamId?: string;
      topK?: number;
    };

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      reply.code(400);
      return { error: 'query is required and must be a non-empty string' };
    }

    if (!teamId || typeof teamId !== 'string') {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    const chunks = await retrieveChunks(query.trim(), teamId, {
      topK: topK ?? undefined,
    });

    return { chunks };
  });
};
