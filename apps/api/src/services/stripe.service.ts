import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions } from '../db/schema.js';
import { config } from '../lib/config.js';

// ── Plan → Stripe Price ID mapping ──────────────────────
// In production these should be real Stripe price IDs set via env vars.

const PLAN_PRICES: Record<string, string> = {
  pro: process.env.STRIPE_PRICE_PRO || 'price_pro_placeholder',
  team: process.env.STRIPE_PRICE_TEAM || 'price_team_placeholder',
};

// ── Stripe client (lazy, nullable) ──────────────────────

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

// ── Public API ──────────────────────────────────────────

/**
 * Find or create a Stripe customer for the given team.
 */
export async function getOrCreateCustomer(
  teamId: string,
  teamName: string,
  email: string,
): Promise<string> {
  const stripe = getStripe();

  // Check if we already have a customer id stored
  const [sub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.teamId, teamId))
    .limit(1);

  if (sub?.stripeCustomerId) {
    return sub.stripeCustomerId;
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    name: teamName,
    email,
    metadata: { teamId },
  });

  return customer.id;
}

/**
 * Create a Stripe Checkout session for upgrading to a paid plan.
 */
export async function createCheckoutSession(
  customerId: string,
  priceId: string,
  teamId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { teamId },
  });

  return session.url!;
}

/**
 * Create a Stripe Billing Portal session so users can manage their subscription.
 */
export async function createPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const stripe = getStripe();

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return session.url;
}

/**
 * Process a Stripe webhook event and update the local subscription record.
 */
export async function handleWebhookEvent(
  payload: string | Buffer,
  signature: string,
): Promise<void> {
  const stripe = getStripe();

  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }

  const event = stripe.webhooks.constructEvent(
    payload,
    signature,
    config.STRIPE_WEBHOOK_SECRET,
  );

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const teamId = session.metadata?.teamId;
      if (!teamId || !session.subscription) break;

      const stripeSubscription = await stripe.subscriptions.retrieve(
        session.subscription as string,
      );

      // Determine plan from price id
      const priceId = stripeSubscription.items.data[0]?.price.id;
      const plan = Object.entries(PLAN_PRICES).find(([, pid]) => pid === priceId)?.[0] ?? 'pro';

      // Upsert subscription record
      const [existing] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.teamId, teamId))
        .limit(1);

      const values = {
        plan: plan as 'free' | 'pro' | 'team' | 'enterprise',
        status: 'active' as const,
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: stripeSubscription.id,
        stripePriceId: priceId ?? null,
        currentPeriodStart: new Date(stripeSubscription.items.data[0]?.current_period_start
          ? stripeSubscription.items.data[0].current_period_start * 1000
          : Date.now()),
        currentPeriodEnd: new Date(stripeSubscription.items.data[0]?.current_period_end
          ? stripeSubscription.items.data[0].current_period_end * 1000
          : Date.now()),
        cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
        updatedAt: new Date(),
      };

      if (existing) {
        await db
          .update(subscriptions)
          .set(values)
          .where(eq(subscriptions.teamId, teamId));
      } else {
        await db.insert(subscriptions).values({ teamId, ...values });
      }
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const teamId = sub.metadata?.teamId;
      if (!teamId) break;

      const status = sub.status === 'active'
        ? 'active'
        : sub.status === 'past_due'
          ? 'past_due'
          : sub.status === 'canceled'
            ? 'canceled'
            : sub.status === 'trialing'
              ? 'trialing'
              : 'incomplete';

      const priceId = sub.items.data[0]?.price.id;
      const plan = event.type === 'customer.subscription.deleted'
        ? 'free'
        : (Object.entries(PLAN_PRICES).find(([, pid]) => pid === priceId)?.[0] ?? 'pro');

      await db
        .update(subscriptions)
        .set({
          plan: plan as 'free' | 'pro' | 'team' | 'enterprise',
          status: status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete',
          stripePriceId: priceId ?? null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodStart: new Date(sub.items.data[0]?.current_period_start
            ? sub.items.data[0].current_period_start * 1000
            : Date.now()),
          currentPeriodEnd: new Date(sub.items.data[0]?.current_period_end
            ? sub.items.data[0].current_period_end * 1000
            : Date.now()),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.teamId, teamId));
      break;
    }

    default:
      // Unhandled event type — ignore
      break;
  }
}

/**
 * Get the Stripe price ID for a given plan name.
 */
export function getPriceId(plan: string): string | undefined {
  return PLAN_PRICES[plan];
}
