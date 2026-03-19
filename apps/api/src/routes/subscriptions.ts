import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions, teams } from '../db/schema.js';
import {
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  getPriceId,
} from '../services/stripe.service.js';

// ── Static plan data ────────────────────────────────────

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    interval: null,
    features: [
      '5 documents',
      '1 team member',
      'Basic AI assistance',
      'GitHub integration',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 19,
    interval: 'month',
    features: [
      'Unlimited documents',
      '5 team members',
      'Advanced AI analysis',
      'All integrations',
      'Version history',
      'Export to PDF',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    price: 49,
    interval: 'month',
    features: [
      'Everything in Pro',
      'Unlimited team members',
      'Priority AI processing',
      'Custom templates',
      'Audit trail',
      'SSO support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: null,
    interval: null,
    features: [
      'Everything in Team',
      'Dedicated support',
      'Custom integrations',
      'SLA guarantee',
      'On-premise option',
    ],
  },
];

// ── Routes ──────────────────────────────────────────────

export const subscriptionRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List available plans (public) ─────────────────────
  fastify.get('/plans', async () => {
    return PLANS;
  });

  // ── Get current subscription for a team ───────────────
  fastify.get<{ Querystring: { teamId: string } }>(
    '/current',
    async (request) => {
      const { teamId } = request.query;

      if (!teamId) {
        throw { statusCode: 400, message: 'teamId is required' };
      }

      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.teamId, teamId))
        .limit(1);

      if (!sub) {
        // No subscription record — team is on the free plan
        return {
          id: null,
          teamId,
          plan: 'free',
          status: 'active',
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        };
      }

      return {
        id: sub.id,
        teamId: sub.teamId,
        plan: sub.plan,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      };
    },
  );

  // ── Create Stripe checkout session ────────────────────
  fastify.post<{
    Body: {
      plan: string;
      teamId: string;
      successUrl: string;
      cancelUrl: string;
    };
  }>('/checkout', async (request) => {
    const { plan, teamId, successUrl, cancelUrl } = request.body;
    const user = request.user;

    if (!plan || !teamId || !successUrl || !cancelUrl) {
      throw { statusCode: 400, message: 'plan, teamId, successUrl, and cancelUrl are required' };
    }

    if (plan === 'free') {
      throw { statusCode: 400, message: 'Cannot checkout for the free plan' };
    }

    const priceId = getPriceId(plan);
    if (!priceId) {
      throw { statusCode: 400, message: `Unknown plan: ${plan}` };
    }

    // Get team name for Stripe customer
    const [team] = await db
      .select({ name: teams.name })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) {
      throw { statusCode: 404, message: 'Team not found' };
    }

    const customerId = await getOrCreateCustomer(teamId, team.name, user.email);
    const url = await createCheckoutSession(
      customerId,
      priceId,
      teamId,
      successUrl,
      cancelUrl,
    );

    return { url };
  });

  // ── Create Stripe billing portal session ──────────────
  fastify.post<{
    Body: { teamId: string; returnUrl: string };
  }>('/portal', async (request) => {
    const { teamId, returnUrl } = request.body;

    if (!teamId || !returnUrl) {
      throw { statusCode: 400, message: 'teamId and returnUrl are required' };
    }

    const [sub] = await db
      .select({ stripeCustomerId: subscriptions.stripeCustomerId })
      .from(subscriptions)
      .where(eq(subscriptions.teamId, teamId))
      .limit(1);

    if (!sub?.stripeCustomerId) {
      throw { statusCode: 400, message: 'No active subscription found for this team' };
    }

    const url = await createPortalSession(sub.stripeCustomerId, returnUrl);
    return { url };
  });

  // ── Stripe webhook handler ────────────────────────────
  fastify.post('/webhook', {
    config: {
      // Need raw body for Stripe signature verification
      rawBody: true,
    },
  }, async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (!signature) {
      return reply.code(400).send({ error: 'Missing stripe-signature header' });
    }

    try {
      const rawBody = (request as unknown as { rawBody: string | Buffer }).rawBody
        ?? JSON.stringify(request.body);

      await handleWebhookEvent(rawBody, signature as string);
      return { received: true };
    } catch (err) {
      request.log.error(err, 'Stripe webhook processing failed');
      return reply.code(400).send({ error: 'Webhook processing failed' });
    }
  });
};
