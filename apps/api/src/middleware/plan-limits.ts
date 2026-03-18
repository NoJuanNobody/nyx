import type { FastifyRequest, FastifyReply } from 'fastify';
import { planLimitsService } from '../services/plan-limits.service.js';

/**
 * Fastify preHandler that enforces document count limits per plan.
 *
 * Reads teamId from request body (for POST /documents).
 * Returns 403 with limit details if the team has reached its plan limit.
 */
export function requireDocumentLimit() {
  return async function checkDocumentLimit(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const params = request.params as Record<string, string>;
    const query = request.query as Record<string, string>;

    const teamId =
      (body.teamId as string | undefined) ??
      params.teamId ??
      query.teamId;

    if (!teamId) {
      return reply
        .code(400)
        .send({ error: 'Unable to determine team context for plan limit check' });
    }

    const result = await planLimitsService.checkDocumentLimit(teamId);

    if (!result.allowed) {
      return reply.code(403).send({
        error: 'Plan limit reached',
        feature: 'documents',
        limit: result.limit,
        current: result.current,
        plan: result.plan,
        upgradeUrl: '/settings?tab=billing',
      });
    }
  };
}
