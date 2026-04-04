import type { FastifyPluginAsync } from 'fastify';
import { checkCompliance } from '../services/compliance.service.js';

export const complianceRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/compliance/check — check code against team specs
  app.post('/check', async (request, reply) => {
    const { code, teamId, filePath } = request.body as {
      code?: string;
      teamId?: string;
      filePath?: string;
    };

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      reply.code(400);
      return { error: 'code is required and must be a non-empty string' };
    }

    if (!teamId || typeof teamId !== 'string') {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    const result = await checkCompliance(code.trim(), teamId, filePath);
    return result;
  });
};
