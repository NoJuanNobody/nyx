import type { FastifyPluginAsync } from 'fastify';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import {
  getBalance,
  addCredits,
  getTransactionHistory,
} from '../services/credits.service.js';
import { CREDIT_PACKS } from '../config/credit-costs.js';
import { config } from '../lib/config.js';

// ── Stripe client (lazy) ─────────────────────────────────

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured: STRIPE_SECRET_KEY is missing');
  }
  if (!stripeClient) {
    stripeClient = new Stripe(config.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    });
  }
  return stripeClient;
}

// ── Routes ───────────────────────────────────────────────

export const creditRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List available credit packs ────────────────────────
  fastify.get('/packs', async () => {
    return CREDIT_PACKS.map(({ id, label, credits, priceCents, priceLabel, popular }) => ({
      id,
      label,
      credits,
      priceCents,
      priceLabel,
      popular,
    }));
  });

  // ── Get current user's credit balance ──────────────────
  fastify.get('/balance', async (request) => {
    const balance = await getBalance(request.user.id);
    return { balance };
  });

  // ── Get credit transaction history ─────────────────────
  fastify.get<{
    Querystring: { limit?: string; offset?: string };
  }>('/transactions', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 50, 100);
    const offset = Number(request.query.offset) || 0;

    return getTransactionHistory(request.user.id, limit, offset);
  });

  // ── Create Stripe checkout for a credit pack ───────────
  fastify.post<{
    Body: { packId: string; successUrl: string; cancelUrl: string };
  }>('/purchase', async (request, reply) => {
    const { packId, successUrl, cancelUrl } = request.body;

    if (!packId || !successUrl || !cancelUrl) {
      return reply.code(400).send({ error: 'packId, successUrl, and cancelUrl are required' });
    }

    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      return reply.code(400).send({ error: `Unknown credit pack: ${packId}` });
    }

    const stripe = getStripe();
    const userId = request.user.id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price: pack.stripePriceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        type: 'credit_purchase',
        userId,
        packId,
        credits: String(pack.credits),
      },
    });

    return { url: session.url };
  });

  // ── Stripe webhook for credit purchases ────────────────
  fastify.post('/webhook', {
    config: { rawBody: true },
  }, async (request, reply) => {
    if (!config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(500).send({ error: 'Webhook secret not configured' });
    }

    const signature = request.headers['stripe-signature'];
    if (!signature) {
      return reply.code(400).send({ error: 'Missing stripe-signature header' });
    }

    let event: Stripe.Event;
    try {
      const stripe = getStripe();
      const rawBody = (request as unknown as { rawBody: string | Buffer }).rawBody
        ?? JSON.stringify(request.body);
      event = stripe.webhooks.constructEvent(rawBody, signature as string, config.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      request.log.error(err, 'Credit webhook signature verification failed');
      return reply.code(400).send({ error: 'Invalid webhook signature' });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;

      // Only handle credit purchase events
      if (session.metadata?.type !== 'credit_purchase') {
        return { received: true };
      }

      const { userId, packId, credits } = session.metadata;
      if (!userId || !packId || !credits) {
        request.log.warn('Credit purchase webhook missing metadata fields');
        return { received: true };
      }

      const creditAmount = Number(credits);
      const pack = CREDIT_PACKS.find((p) => p.id === packId);
      const description = pack ? `Purchased ${pack.label}` : `Purchased ${creditAmount} credits`;

      // Verify user exists before crediting
      const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        request.log.error({ userId }, 'Credit purchase webhook: user not found');
        return { received: true };
      }

      await addCredits(userId, creditAmount, 'purchase', description, session.id);
      request.log.info({ userId, creditAmount, packId }, 'Credits added via purchase');
    }

    return { received: true };
  });
};
