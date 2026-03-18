import type { FastifyPluginAsync } from 'fastify';
import { getUsageSummary, checkLimit } from '../services/plan-limits.service.js';
import type { LimitAction } from '../services/plan-limits.service.js';

export const planRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/plan/usage ─────────────────────────────────
  // Returns the authenticated user's plan and current usage summary.
  fastify.get('/usage', async (request) => {
    const userId = request.user.id;
    const summary = await getUsageSummary(userId);
    return summary;
  });

  // ── GET /api/plan/check/:action ─────────────────────────
  // Checks whether the user can perform a specific action.
  fastify.get<{
    Params: { action: string };
  }>('/check/:action', async (request, reply) => {
    const userId = request.user.id;
    const { action } = request.params;

    const validActions: LimitAction[] = ['create_document', 'use_ai', 'use_voice'];
    if (!validActions.includes(action as LimitAction)) {
      return reply.code(400).send({ error: `Invalid action: ${action}` });
    }

    const result = await checkLimit(userId, action as LimitAction);
    return result;
  });
};
