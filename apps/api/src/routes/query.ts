import type { FastifyPluginAsync } from 'fastify';
import { queryDocs } from '../services/query.service.js';
import { sseCorsHeaders } from '../lib/cors.js';

export const queryRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/query — SSE endpoint that streams a RAG-powered answer
  fastify.post<{
    Body: { query: string; teamId: string };
  }>('/', async (request, reply) => {
    const { query, teamId } = request.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      reply.code(400);
      return { error: 'query is required and must be a non-empty string' };
    }

    if (!teamId || typeof teamId !== 'string') {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    // Set up SSE response. Raw responses bypass the @fastify/cors onSend hook,
    // so set CORS headers explicitly for cross-origin browsers.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...sseCorsHeaders(request.headers.origin),
    });

    try {
      for await (const chunk of queryDocs(query.trim(), teamId)) {
        reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
};
