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

export const billingRoutes: FastifyPluginAsync = async (fastify) => {
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

    if (plan === 'free' || plan === 'enterprise') {
      throw { statusCode: 400, message: `Cannot checkout for the ${plan} plan` };
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
    const url = await createCheckoutSession(customerId, priceId, teamId, successUrl, cancelUrl);

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
  fastify.post(
    '/webhooks/stripe',
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      const signature = request.headers['stripe-signature'];
      if (!signature) {
        return reply.code(400).send({ error: 'Missing stripe-signature header' });
      }

      try {
        const rawBody =
          (request as unknown as { rawBody: string | Buffer }).rawBody ??
          JSON.stringify(request.body);

        await handleWebhookEvent(rawBody, signature as string);
        return { received: true };
      } catch (err) {
        request.log.error(err, 'Stripe webhook processing failed');
        return reply.code(400).send({ error: 'Webhook processing failed' });
      }
    },
  );
};
