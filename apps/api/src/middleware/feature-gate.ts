import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions } from '../db/schema.js';

/**
 * Plan hierarchy — higher index = more features.
 */
const PLAN_HIERARCHY = ['free', 'pro', 'team', 'enterprise'] as const;
type Plan = (typeof PLAN_HIERARCHY)[number];

function planIndex(plan: Plan): number {
  return PLAN_HIERARCHY.indexOf(plan);
}

export interface RequirePlanOptions {
  /** Minimum subscription plan required to access this route. */
  minimumPlan: Plan;
}

/**
 * Middleware factory that checks whether a team's subscription
 * meets the minimum plan requirement.
 *
 * Usage:
 * ```ts
 * fastify.get('/', { preHandler: [requirePlan({ minimumPlan: 'pro' })] }, handler);
 * ```
 *
 * The teamId is resolved from params.teamId, query.teamId, or body.teamId.
 */
export function requirePlan(options: RequirePlanOptions) {
  const { minimumPlan } = options;

  return async function checkPlan(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    // Resolve teamId from request
    const params = request.params as Record<string, string>;
    const query = request.query as Record<string, string>;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const teamId =
      params.teamId ?? query.teamId ?? (body.teamId as string | undefined);

    if (!teamId) {
      return reply
        .code(400)
        .send({ error: 'Unable to determine team context for plan check' });
    }

    // Look up the team's subscription
    const [sub] = await db
      .select({ plan: subscriptions.plan, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.teamId, teamId))
      .limit(1);

    const currentPlan: Plan = (sub?.plan as Plan) ?? 'free';

    // Allow active or trialing subscriptions
    if (sub && sub.status !== 'active' && sub.status !== 'trialing') {
      return reply.code(403).send({
        error: 'Your subscription is not active. Please update your billing information.',
        requiredPlan: minimumPlan,
        currentPlan,
        currentStatus: sub.status,
      });
    }

    if (planIndex(currentPlan) < planIndex(minimumPlan)) {
      return reply.code(403).send({
        error: `This feature requires the ${minimumPlan} plan or higher. Your current plan: ${currentPlan}.`,
        requiredPlan: minimumPlan,
        currentPlan,
        upgradeRequired: true,
      });
    }
  };
}
