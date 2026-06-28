import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions, stripeCustomers, creditTransactions } from '../db/schema.js';
import { config } from '../lib/config.js';
import { addCredits } from './credits.service.js';

// ── Plan → Stripe Price ID mapping ──────────────────────
// In production these should be real Stripe price IDs set via env vars.

const PLAN_PRICES: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER || 'price_starter_placeholder',
  pro: process.env.STRIPE_PRICE_PRO || 'price_pro_placeholder',
  team: process.env.STRIPE_PRICE_TEAM || 'price_team_placeholder',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || 'price_enterprise_placeholder',
};

// ── Credit Pack → Stripe Price ID mapping ───────────────

export const CREDIT_PACK_PRICES: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_CREDIT_STARTER || 'price_credit_starter_placeholder',
  growth: process.env.STRIPE_PRICE_CREDIT_GROWTH || 'price_credit_growth_placeholder',
  pro: process.env.STRIPE_PRICE_CREDIT_PRO || 'price_credit_pro_placeholder',
  enterprise: process.env.STRIPE_PRICE_CREDIT_ENTERPRISE || 'price_credit_enterprise_placeholder',
};

// ── Stripe client (lazy, nullable) ──────────────────────

let stripeClient: Stripe | null = null;

function getStripe(): Stripe | null {
  if (!config.STRIPE_SECRET_KEY) {
    return null;
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
  // Check if we already have a customer id stored
  const [sub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.teamId, teamId))
    .limit(1);

  if (sub?.stripeCustomerId) {
    return sub.stripeCustomerId;
  }

  const stripe = getStripe();
  if (!stripe) {
    // Stub: return a mock customer ID when Stripe is not configured
    const mockId = `cus_mock_${teamId.slice(0, 8)}`;
    await db
      .insert(subscriptions)
      .values({ teamId, stripeCustomerId: mockId })
      .onConflictDoNothing();
    return mockId;
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
  if (!stripe) {
    // Stub: return a mock checkout URL when Stripe is not configured
    return `https://checkout.stripe.com/mock?customer=${customerId}&price=${priceId}`;
  }

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
 * Create a Stripe Checkout session for a one-time credit pack purchase.
 */
export async function createCreditPackCheckoutSession(
  userId: string,
  packId: string,
  credits: number,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe();
  if (!stripe) {
    return `https://checkout.stripe.com/mock?pack=${packId}&user=${userId}`;
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    metadata: { kind: 'credit_pack', userId, packId, credits: String(credits) },
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
  if (!stripe) {
    // Stub: return a mock portal URL when Stripe is not configured
    return `https://billing.stripe.com/mock/portal?customer=${customerId}`;
  }

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

  let event: Stripe.Event;

  if (stripe) {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      config.STRIPE_WEBHOOK_SECRET,
    );
  } else {
    // Stub mode: parse the payload directly (no signature verification)
    const raw = typeof payload === 'string' ? payload : payload.toString();
    event = JSON.parse(raw) as Stripe.Event;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;

      // ── Credit pack purchase ─────────────────────────────
      if (session.metadata?.kind === 'credit_pack') {
        const { userId, packId, credits } = session.metadata;
        if (userId && credits) {
          // Idempotency: skip if this session was already processed
          const existing = await db
            .select({ id: creditTransactions.id })
            .from(creditTransactions)
            .where(eq(creditTransactions.stripeSessionId, session.id))
            .limit(1);
          if (existing.length === 0) {
            await addCredits(userId, parseInt(credits, 10), `Purchased credit pack: ${packId ?? 'unknown'} (${credits} credits)`, session.id);
          }
        }
        break;
      }

      // ── Subscription checkout ────────────────────────────
      const teamId = session.metadata?.teamId;
      if (!teamId || !session.subscription) break;

      let priceId: string | undefined;
      let plan = 'pro';
      let periodStart = Date.now();
      let periodEnd = Date.now();
      let cancelAtPeriodEnd = false;

      if (stripe) {
        const stripeSubscription = await stripe.subscriptions.retrieve(
          session.subscription as string,
        );
        priceId = stripeSubscription.items.data[0]?.price.id;
        plan =
          Object.entries(PLAN_PRICES).find(([, pid]) => pid === priceId)?.[0] ?? 'pro';
        periodStart = stripeSubscription.items.data[0]?.current_period_start
          ? stripeSubscription.items.data[0].current_period_start * 1000
          : Date.now();
        periodEnd = stripeSubscription.items.data[0]?.current_period_end
          ? stripeSubscription.items.data[0].current_period_end * 1000
          : Date.now();
        cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
      }

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
        stripeSubscriptionId:
          typeof session.subscription === 'string'
            ? session.subscription
            : (session.subscription as unknown as { id: string }).id,
        stripePriceId: priceId ?? null,
        currentPeriodStart: new Date(periodStart),
        currentPeriodEnd: new Date(periodEnd),
        cancelAtPeriodEnd,
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

      // Also upsert stripe_customers record
      const userId = session.client_reference_id ?? teamId;
      const [existingCustomer] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.stripeCustomerId, session.customer as string))
        .limit(1);

      if (!existingCustomer) {
        await db.insert(stripeCustomers).values({
          userId,
          stripeCustomerId: session.customer as string,
          subscriptionId:
            typeof session.subscription === 'string'
              ? session.subscription
              : null,
          plan,
        });
      }
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const teamId = sub.metadata?.teamId;
      if (!teamId) break;

      const status =
        sub.status === 'active'
          ? 'active'
          : sub.status === 'past_due'
            ? 'past_due'
            : sub.status === 'canceled'
              ? 'canceled'
              : sub.status === 'trialing'
                ? 'trialing'
                : 'incomplete';

      const priceId = sub.items.data[0]?.price.id;
      const plan =
        event.type === 'customer.subscription.deleted'
          ? 'free'
          : (Object.entries(PLAN_PRICES).find(([, pid]) => pid === priceId)?.[0] ?? 'pro');

      await db
        .update(subscriptions)
        .set({
          plan: plan as 'free' | 'pro' | 'team' | 'enterprise',
          status: status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete',
          stripePriceId: priceId ?? null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodStart: new Date(
            sub.items.data[0]?.current_period_start
              ? sub.items.data[0].current_period_start * 1000
              : Date.now(),
          ),
          currentPeriodEnd: new Date(
            sub.items.data[0]?.current_period_end
              ? sub.items.data[0].current_period_end * 1000
              : Date.now(),
          ),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.teamId, teamId));

      // Update stripe_customers plan
      if (sub.customer) {
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.toString();
        await db
          .update(stripeCustomers)
          .set({
            plan,
            planExpiresAt:
              event.type === 'customer.subscription.deleted'
                ? new Date()
                : null,
            updatedAt: new Date(),
          })
          .where(eq(stripeCustomers.stripeCustomerId, customerId));
      }
      break;
    }

    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      const teamId = sub.metadata?.teamId;
      if (!teamId) break;

      const priceId = sub.items.data[0]?.price.id;
      const plan =
        Object.entries(PLAN_PRICES).find(([, pid]) => pid === priceId)?.[0] ?? 'pro';

      const status =
        sub.status === 'active'
          ? 'active'
          : sub.status === 'trialing'
            ? 'trialing'
            : 'incomplete';

      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.toString();

      const [existing] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.teamId, teamId))
        .limit(1);

      const values = {
        plan: plan as 'free' | 'pro' | 'team' | 'enterprise',
        status: status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete',
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        stripePriceId: priceId ?? null,
        currentPeriodStart: new Date(
          sub.items.data[0]?.current_period_start
            ? sub.items.data[0].current_period_start * 1000
            : Date.now(),
        ),
        currentPeriodEnd: new Date(
          sub.items.data[0]?.current_period_end
            ? sub.items.data[0].current_period_end * 1000
            : Date.now(),
        ),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
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

      // Upsert stripe_customers record
      const [existingCustomer] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.stripeCustomerId, customerId))
        .limit(1);

      if (!existingCustomer) {
        await db.insert(stripeCustomers).values({
          userId: teamId,
          stripeCustomerId: customerId,
          subscriptionId: sub.id,
          plan,
        });
      }
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub = invoice.parent?.subscription_details;
      const subscriptionId =
        parentSub
          ? (typeof parentSub.subscription === 'string'
            ? parentSub.subscription
            : parentSub.subscription?.id)
          : undefined;
      if (!subscriptionId) break;

      // Update subscription status to active and refresh period dates
      const [subRecord] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
        .limit(1);

      if (subRecord) {
        await db
          .update(subscriptions)
          .set({
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub = invoice.parent?.subscription_details;
      const subscriptionId =
        parentSub
          ? (typeof parentSub.subscription === 'string'
            ? parentSub.subscription
            : parentSub.subscription?.id)
          : undefined;
      if (!subscriptionId) break;

      // Mark subscription as past_due when payment fails
      await db
        .update(subscriptions)
        .set({
          status: 'past_due',
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
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
