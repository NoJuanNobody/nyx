import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions, users, marketplaceTransactions } from '../db/schema.js';
import { config } from '../lib/config.js';

// Platform fee percentage (10%)
const PLATFORM_FEE_PERCENT = 0.10;

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

      // Route by metadata type: marketplace purchase vs subscription checkout
      if (session.metadata?.type === 'marketplace_purchase') {
        const transactionId = session.metadata.transactionId;
        if (!transactionId) break;

        const paymentIntentId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id ?? null;

        await db
          .update(marketplaceTransactions)
          .set({
            status: 'completed',
            stripePaymentIntentId: paymentIntentId,
            updatedAt: new Date(),
          })
          .where(eq(marketplaceTransactions.id, transactionId));
        break;
      }

      // Subscription checkout
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

// ── Stripe Connect (Marketplace) ────────────────────────

/**
 * Create a Stripe Connect Express account for a seller.
 */
export async function createConnectAccount(email: string, userId: string): Promise<string> {
  const stripe = getStripe();

  const account = await stripe.accounts.create({
    type: 'express',
    email,
    metadata: { userId },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  // Persist the Connect account ID on the user record
  await db.update(users).set({ stripeConnectAccountId: account.id }).where(eq(users.id, userId));

  return account.id;
}

/**
 * Create an account onboarding link for a Stripe Connect Express account.
 */
export async function createConnectAccountLink(
  accountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<string> {
  const stripe = getStripe();

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });

  return link.url;
}

/**
 * Retrieve a Connect account to check its onboarding status.
 */
export async function getConnectAccountStatus(accountId: string): Promise<{
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(accountId);
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
  };
}

/**
 * Create a Stripe Checkout session for purchasing a marketplace listing.
 * Splits payment: platform fee retained, remainder transferred to seller's Connect account.
 */
export async function createMarketplaceCheckout(opts: {
  listingId: string;
  listingTitle: string;
  amountCents: number;
  buyerEmail: string;
  buyerUserId: string;
  sellerUserId: string;
  sellerConnectAccountId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; transactionId: string }> {
  const stripe = getStripe();

  const platformFeeCents = Math.round(opts.amountCents * PLATFORM_FEE_PERCENT);

  // Create a pending transaction record first
  const [transaction] = await db
    .insert(marketplaceTransactions)
    .values({
      listingId: opts.listingId,
      buyerId: opts.buyerUserId,
      sellerId: opts.sellerUserId,
      amountCents: opts.amountCents,
      platformFeeCents,
      status: 'pending',
    })
    .returning({ id: marketplaceTransactions.id });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: opts.buyerEmail,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: opts.amountCents,
          product_data: { name: opts.listingTitle },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: opts.sellerConnectAccountId },
    },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    metadata: {
      type: 'marketplace_purchase',
      transactionId: transaction.id,
      listingId: opts.listingId,
      buyerUserId: opts.buyerUserId,
    },
  });

  // Store the checkout session ID on the transaction
  await db
    .update(marketplaceTransactions)
    .set({ stripeCheckoutSessionId: session.id })
    .where(eq(marketplaceTransactions.id, transaction.id));

  return { url: session.url!, transactionId: transaction.id };
}
