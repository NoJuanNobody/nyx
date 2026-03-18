import type { preHandlerAsyncHookHandler } from 'fastify';
import { getBalance } from '../services/credits.service.js';
import { CREDIT_COSTS, type CreditTaskType } from '../config/credit-costs.js';

/**
 * Returns a Fastify preHandler hook that checks a user's credit balance
 * before allowing an agentic task to proceed.
 *
 * Responds with HTTP 402 if the user has insufficient credits.
 *
 * Usage:
 *   fastify.post('/some-ai-route', { preHandler: requireCredits('spec_analysis') }, handler)
 */
export function requireCredits(taskType: CreditTaskType): preHandlerAsyncHookHandler {
  const cost = CREDIT_COSTS[taskType];

  return async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const balance = await getBalance(userId);

    if (balance < cost) {
      reply.code(402).send({
        error: 'Insufficient credits',
        required: cost,
        balance,
        taskType,
      });
    }
  };
}
