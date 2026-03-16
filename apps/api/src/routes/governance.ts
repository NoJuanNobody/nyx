import type { FastifyPluginAsync } from 'fastify';
import { governanceService } from '../services/governance.service.js';

export const governanceRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/governance/validate — validate an action against governance rules
  app.post('/validate', async (request, reply) => {
    const { action, documentId: _documentId, teamId, content, stage } = request.body as {
      action: string;
      documentId?: string;
      teamId: string;
      content?: string;
      stage?: string;
    };

    if (!action || !teamId) {
      reply.code(400);
      return { error: 'action and teamId are required' };
    }

    const result = await governanceService.validateAction({
      action,
      content,
      stage,
      teamId,
    });

    return result;
  });

  // GET /api/governance/rules — return parsed governance rules
  app.get('/rules', async () => {
    return governanceService.getRules();
  });
};
