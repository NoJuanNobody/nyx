import type { FastifyPluginAsync } from 'fastify';
import { contextMatchingService } from '../services/context-matching.service.js';

export const contextRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/intake/context — find related specs and signals for new input
  app.post('/context', async (request, reply) => {
    const { rawInput, teamId } = request.body as { rawInput: string; teamId: string };

    if (!rawInput || !teamId) {
      reply.code(400);
      return { error: 'rawInput and teamId are required' };
    }

    const result = await contextMatchingService.findRelatedSpecs(rawInput, teamId);
    return result;
  });
};
