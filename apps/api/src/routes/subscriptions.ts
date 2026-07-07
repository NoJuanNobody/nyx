import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions, teams } from '../db/schema.js';
import {
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
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
      '1 user, 1 project, 1 repo',
      '5 documents',
      'Manual drift check only',
      '10 AI credits/month',
      'GitHub Issues integration',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    price: 24,
    interval: 'month',
    features: [
      '1 user, 3 projects, 2 repos',
      'Unlimited documents',
      'Automated drift detection (50 webhooks/mo)',
      '100 AI operations/month',
      'GitHub Issues + Jira integrations',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 59,
    interval: 'month',
    features: [
      'Up to 5 users, 10 projects, unlimited repos',
      'All integrations (GitHub, GitLab, Jira, Confluence)',
      '500 AI operations/month',
      'Up to 3 non-dev seats',
      'BYOK available',
      'MCP/agent integrations (Cursor, Copilot, Claude Code)',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    price: 129,
    interval: 'month',
    features: [
      'Up to 25 users, unlimited projects and repos',
      'BYOK required for AI features',
      'Unlimited AI via BYOK',
      'Unlimited non-dev seats',
      'Priority support',
      'Full version control (rollback, blame, snapshots)',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: null,
    interval: null,
    features: [
      'Everything in Team',
      'SSO, SLA, dedicated support',
      'Custom integrations / self-hosted option',
      'BYOK included and required',
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

  // Stripe webhooks are handled by the single canonical endpoint in
  // billing.ts at POST /api/billing/webhooks/stripe (see #464, #470).
};
