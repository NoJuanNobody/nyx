import type { FastifyPluginAsync } from 'fastify';
import { aiService } from '../services/ai.service.js';

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/ai/analyze — analyze spec quality
  app.post('/analyze', async (request, reply) => {
    const { content } = request.body as { content: string };

    if (!content) {
      reply.code(400);
      return { error: 'content is required' };
    }

    const result = await aiService.analyzeSpecQuality(content);
    return result;
  });

  // POST /api/ai/detect-drift — detect spec-code drift
  app.post('/detect-drift', async (request, reply) => {
    const { specContent, codeContent } = request.body as {
      specContent: string;
      codeContent: string;
    };

    if (!specContent || !codeContent) {
      reply.code(400);
      return { error: 'specContent and codeContent are required' };
    }

    const result = await aiService.detectDrift(specContent, codeContent);
    return result;
  });

  // POST /api/ai/generate-ticket — generate a ticket from a spec diff
  app.post('/generate-ticket', async (request, reply) => {
    const { diff, context } = request.body as {
      diff: string;
      context?: string;
    };

    if (!diff) {
      reply.code(400);
      return { error: 'diff is required' };
    }

    const result = await aiService.generateTicketFromDiff(diff, context);
    return result;
  });
};
