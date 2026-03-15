# Subscription Plans — Implementation Execution Plan

This document provides a sequenced, task-level plan for building the subscription system defined in [`docs/features/subscription-plans.md`](../features/subscription-plans.md). Phases are ordered so that each layer builds on the previous one; the shared config and database schema must land before any enforcement or billing code is written.

---

## Phase 0: Prerequisites

Before writing any subscription code, verify these are in place:

- [ ] `teams` table exists (it does — `apps/api/src/db/schema.ts`)
- [ ] Clerk auth middleware is wired into all API routes
- [ ] Drizzle ORM is configured and the `drizzle-kit push --force` workflow is established
- [ ] A Stripe account is provisioned with products/prices matching each plan
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are available as env vars in Railway/Render
- [ ] `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (or Vite equivalent) is available in the frontend env

---

## Phase 1: Shared Plan Configuration

**Goal:** Define the single source of truth for plan limits and features. This package is imported by both the API (enforcement) and the web (UI gating).

### 1.1 Create `packages/shared/src/plans.ts`

```ts
export type PlanTier = 'free' | 'starter' | 'team' | 'enterprise';

export interface PlanLimits {
  maxProjects: number | null;   // null = unlimited
  maxSeats: number | null;
  versionHistoryDays: number | null; // null = unlimited
  snapshots: boolean;
  rollback: 'none' | 'docs' | 'full';
  docBranching: boolean;
  ticketCreation: boolean;
  nonDevChangeFlow: boolean;
  agentIntegrations: boolean;
  kanbanBoard: boolean;
  byok: boolean;
  aiUsageCap: number | null;    // requests/mo; null = unlimited (BYOK)
  exportDocs: boolean;
  sso: boolean;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    maxProjects: 1,
    maxSeats: 1,
    versionHistoryDays: 30,
    snapshots: false,
    rollback: 'none',
    docBranching: false,
    ticketCreation: true,
    nonDevChangeFlow: false,
    agentIntegrations: true,
    kanbanBoard: false,
    byok: false,
    aiUsageCap: 50,
    exportDocs: true,
    sso: false,
  },
  starter: {
    maxProjects: 5,
    maxSeats: 5,
    versionHistoryDays: null,
    snapshots: true,
    rollback: 'docs',
    docBranching: true,
    ticketCreation: true,
    nonDevChangeFlow: false,
    agentIntegrations: true,
    kanbanBoard: false,
    byok: false,
    aiUsageCap: 500,
    exportDocs: true,
    sso: false,
  },
  team: {
    maxProjects: null,
    maxSeats: 20,
    versionHistoryDays: null,
    snapshots: true,
    rollback: 'full',
    docBranching: true,
    ticketCreation: true,
    nonDevChangeFlow: true,
    agentIntegrations: true,
    kanbanBoard: true,
    byok: true,
    aiUsageCap: null,
    exportDocs: true,
    sso: false,
  },
  enterprise: {
    maxProjects: null,
    maxSeats: null,
    versionHistoryDays: null,
    snapshots: true,
    rollback: 'full',
    docBranching: true,
    ticketCreation: true,
    nonDevChangeFlow: true,
    agentIntegrations: true,
    kanbanBoard: true,
    byok: true,
    aiUsageCap: null,
    exportDocs: true,
    sso: true,
  },
};

/** Stripe price IDs — set via environment variables to keep them out of source. */
export const STRIPE_PRICE_IDS: Partial<Record<PlanTier, string>> = {
  starter: process.env.STRIPE_PRICE_ID_STARTER ?? '',
  team: process.env.STRIPE_PRICE_ID_TEAM ?? '',
};
```

### 1.2 Export from `packages/shared/src/index.ts`

```ts
export * from './plans.js';
```

---

## Phase 2: Database Schema

**Goal:** Add a `workspace_subscriptions` table to store the active plan and Stripe identifiers for each team.

### 2.1 Add to `apps/api/src/db/schema.ts`

```ts
export const planTierEnum = pgEnum('plan_tier', ['free', 'starter', 'team', 'enterprise']);
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active', 'trialing', 'past_due', 'canceled', 'unpaid',
]);

export const workspaceSubscriptions = pgTable('workspace_subscriptions', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  teamId:               uuid('team_id').notNull().unique().references(() => teams.id),
  plan:                 planTierEnum('plan').notNull().default('free'),
  status:               subscriptionStatusEnum('status').notNull().default('active'),
  stripeCustomerId:     text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePriceId:        text('stripe_price_id'),
  // When a downgrade is scheduled (takes effect at period end)
  pendingPlan:          planTierEnum('pending_plan'),
  currentPeriodEnd:     timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd:    boolean('cancel_at_period_end').notNull().default(false),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### 2.2 Run schema push

```bash
pnpm --filter api exec drizzle-kit push --force
```

### 2.3 Update seed to create a `free` subscription for every seeded team

In `apps/api/src/db/seed.ts`, after inserting a team, insert:

```ts
await db.insert(workspaceSubscriptions).values({
  teamId: team.id,
  plan: 'free',
  status: 'active',
}).onConflictDoNothing();
```

---

## Phase 3: Plan Enforcement — API Middleware

**Goal:** Add a `requirePlan` middleware (parallel to `requireRole`) and a helper to check feature flags per plan. This is the primary enforcement layer — all plan gates live here.

### 3.1 Create `apps/api/src/middleware/plan.ts`

```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { workspaceSubscriptions } from '../db/schema.js';
import { PLAN_LIMITS, type PlanTier, type PlanLimits } from '@nyx/shared';

/** Fetch the active plan for a team. Falls back to 'free' if no record exists. */
export async function getTeamPlan(teamId: string): Promise<PlanTier> {
  const [row] = await db
    .select({ plan: workspaceSubscriptions.plan, status: workspaceSubscriptions.status })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.teamId, teamId));

  // Treat past_due/unpaid as free to cut off access gracefully
  if (!row || row.status === 'canceled' || row.status === 'past_due' || row.status === 'unpaid') {
    return 'free';
  }
  return row.plan;
}

export function getPlanLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * Fastify preHandler: enforces that the team's plan satisfies a feature flag.
 *
 * Usage:
 *   app.post('/change-proposals', { preHandler: [requirePlan('nonDevChangeFlow')] }, handler)
 */
export function requirePlan(feature: keyof PlanLimits) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const teamId =
      (request as any).resolvedTeamId ??
      (request.params as any)?.teamId ??
      (request.query as any)?.teamId;

    if (!teamId) {
      return reply.code(400).send({ error: 'Unable to determine team context for plan check' });
    }

    const plan = await getTeamPlan(teamId);
    const limits = PLAN_LIMITS[plan];
    const value = limits[feature];

    // Boolean feature flags
    if (typeof value === 'boolean' && !value) {
      return reply.code(403).send({
        error: 'PLAN_LIMIT_EXCEEDED',
        feature,
        currentPlan: plan,
        message: `This feature requires a higher subscription plan.`,
      });
    }
  };
}
```

### 3.2 Wire gates into existing routes

Add `requirePlan` preHandlers to routes for plan-gated features:

| Feature | Route(s) | Gate |
|---|---|---|
| Snapshots | `POST /snapshots` | `requirePlan('snapshots')` |
| Rollback (full) | `POST /snapshots/:id/rollback` | `requirePlan('snapshots')` |
| Doc branching | `POST /branches` | `requirePlan('docBranching')` |
| Non-dev change flow | `POST /change-proposals` | `requirePlan('nonDevChangeFlow')` |
| Kanban board | `GET /sprint` | `requirePlan('kanbanBoard')` |
| BYOK config | `PUT /api-keys/byok` | `requirePlan('byok')` |
| SSO config | `PUT /teams/:id/sso` | `requirePlan('sso')` |

Ticket creation and agent integrations are available to all plans — no gate needed.

### 3.3 Add project and seat limit checks

In the relevant route handlers (not middleware, since these need count queries):

**`POST /documents` (project creation):**

```ts
const plan = await getTeamPlan(teamId);
const limits = PLAN_LIMITS[plan];
if (limits.maxProjects !== null) {
  const count = await db.$count(documents, eq(documents.teamId, teamId));
  if (count >= limits.maxProjects) {
    return reply.code(403).send({
      error: 'PLAN_LIMIT_EXCEEDED',
      feature: 'maxProjects',
      limit: limits.maxProjects,
      currentPlan: plan,
    });
  }
}
```

**`POST /teams/:id/invitations` (seat limit):**

```ts
const plan = await getTeamPlan(teamId);
const limits = PLAN_LIMITS[plan];
if (limits.maxSeats !== null) {
  const count = await db.$count(teamMembers, eq(teamMembers.teamId, teamId));
  if (count >= limits.maxSeats) {
    return reply.code(403).send({
      error: 'PLAN_LIMIT_EXCEEDED',
      feature: 'maxSeats',
      limit: limits.maxSeats,
      currentPlan: plan,
    });
  }
}
```

**Version history reads (`GET /documents/:id/versions`):**

Filter results to `versionHistoryDays` if non-null:

```ts
const plan = await getTeamPlan(teamId);
const { versionHistoryDays } = PLAN_LIMITS[plan];
const cutoff = versionHistoryDays
  ? new Date(Date.now() - versionHistoryDays * 86_400_000)
  : null;
// append .where(gte(documentVersions.createdAt, cutoff)) if cutoff != null
```

---

## Phase 4: Subscription API Routes

**Goal:** Expose endpoints for the frontend to read plan info, create Stripe checkout sessions, open the billing portal, and receive Stripe webhooks.

### 4.1 Create `apps/api/src/routes/subscriptions.ts`

#### `GET /teams/:teamId/subscription`

Returns the current plan, status, and limits.

```ts
{
  plan: 'starter',
  status: 'active',
  limits: { maxProjects: 5, maxSeats: 5, ... },
  currentPeriodEnd: '2026-04-15T00:00:00Z',
  cancelAtPeriodEnd: false,
  pendingPlan: null,
}
```

#### `POST /teams/:teamId/subscription/checkout`

Creates a Stripe Checkout session and returns `{ url }`. Body: `{ plan: 'starter' | 'team' }`.

```ts
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: stripeCustomerId ?? undefined,
  line_items: [{ price: STRIPE_PRICE_IDS[plan], quantity: 1 }],
  success_url: `${FRONTEND_URL}/settings/billing?success=1`,
  cancel_url: `${FRONTEND_URL}/settings/billing`,
  metadata: { teamId },
});
return { url: session.url };
```

#### `POST /teams/:teamId/subscription/portal`

Opens the Stripe Customer Portal (plan changes, invoice history, cancellation).

```ts
const session = await stripe.billingPortal.sessions.create({
  customer: stripeCustomerId,
  return_url: `${FRONTEND_URL}/settings/billing`,
});
return { url: session.url };
```

#### `GET /plans`

Public endpoint (no auth). Returns plan metadata for the pricing page.

```ts
return Object.entries(PLAN_LIMITS).map(([tier, limits]) => ({
  tier,
  limits,
  monthlyPrice: { free: 0, starter: 29, team: 99, enterprise: null }[tier],
}));
```

#### `POST /webhooks/stripe`

Stripe webhook handler. Verify signature, then handle:

| Event | Action |
|---|---|
| `checkout.session.completed` | Create/update `workspace_subscriptions` row, set plan + Stripe IDs |
| `customer.subscription.updated` | Update plan, status, `currentPeriodEnd`, `cancelAtPeriodEnd` |
| `customer.subscription.deleted` | Set status to `canceled`, reset plan to `free` |
| `invoice.payment_failed` | Set status to `past_due` |
| `invoice.paid` | Set status back to `active` |

```ts
// Signature verification (raw body required — register rawBody plugin)
const sig = request.headers['stripe-signature'] as string;
const event = stripe.webhooks.constructEvent(request.rawBody, sig, STRIPE_WEBHOOK_SECRET);
```

> **Important:** Register `fastify-raw-body` (or equivalent) before the JSON parser for this route so the raw buffer is available for signature verification.

### 4.2 Register route in `apps/api/src/app.ts`

```ts
import subscriptionRoutes from './routes/subscriptions.js';
app.register(subscriptionRoutes, { prefix: '/api' });
```

---

## Phase 5: Frontend — Pricing Page and Plan Gating

**Goal:** Surface the subscription system in the UI with a pricing page, upgrade prompts, and feature gates.

### 5.1 Pricing page — `apps/web/src/pages/Pricing.tsx`

- Fetch `/api/plans` (public, no auth required)
- Render three visible plan cards (Free, Starter, Team) + Enterprise CTA
- On "Upgrade" click → `POST /api/teams/:teamId/subscription/checkout` → redirect to Stripe URL

### 5.2 Billing settings — `apps/web/src/pages/settings/Billing.tsx`

- Fetch `/api/teams/:teamId/subscription` to show current plan + status
- "Manage Billing" button → `POST /api/teams/:teamId/subscription/portal` → redirect to Stripe Portal
- Show `pendingPlan` downgrade warning if set
- Show `cancelAtPeriodEnd` banner

### 5.3 `<PlanGate>` component — `apps/web/src/components/PlanGate.tsx`

Wraps any UI element that should be hidden or disabled on lower plans.

```tsx
interface PlanGateProps {
  feature: keyof PlanLimits;
  children: React.ReactNode;
  fallback?: React.ReactNode; // defaults to upgrade prompt
}

export function PlanGate({ feature, children, fallback }: PlanGateProps) {
  const { subscription } = useSubscription(); // context hook
  const limits = subscription ? PLAN_LIMITS[subscription.plan] : PLAN_LIMITS.free;
  const allowed = typeof limits[feature] === 'boolean' ? limits[feature] : limits[feature] !== null;

  if (!allowed) {
    return fallback ?? <UpgradePrompt feature={feature} />;
  }
  return <>{children}</>;
}
```

Usage:
```tsx
<PlanGate feature="nonDevChangeFlow">
  <ChangeProposalForm />
</PlanGate>

<PlanGate feature="snapshots">
  <SnapshotButton />
</PlanGate>
```

### 5.4 `useSubscription` hook — `apps/web/src/hooks/useSubscription.ts`

```ts
export function useSubscription() {
  const { teamId } = useTeam();
  return useQuery({
    queryKey: ['subscription', teamId],
    queryFn: () => api.get(`/teams/${teamId}/subscription`),
    staleTime: 60_000,
  });
}
```

### 5.5 `<UpgradePrompt>` component — `apps/web/src/components/UpgradePrompt.tsx`

Renders a locked state with a "Upgrade Plan" button that opens the checkout flow. Accepts `feature` prop to display a feature-specific message.

---

## Phase 6: AI Usage Metering

**Goal:** Enforce the `aiUsageCap` limit so Free/Starter users cannot exhaust Nyx's Anthropic API spend.

### 6.1 Add `ai_usage_log` table

```ts
export const aiUsageLog = pgTable('ai_usage_log', {
  id:        uuid('id').primaryKey().defaultRandom(),
  teamId:    uuid('team_id').notNull().references(() => teams.id),
  userId:    uuid('user_id').notNull().references(() => users.id),
  tokens:    integer('tokens').notNull(),
  model:     text('model').notNull(),
  endpoint:  text('endpoint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### 6.2 Pre-request cap check in `apps/api/src/routes/ai.ts`

Before calling the Anthropic API:

```ts
const plan = await getTeamPlan(teamId);
const { aiUsageCap, byok } = PLAN_LIMITS[plan];

// If BYOK is enabled and the team has configured their own key, skip cap
if (byok && teamHasByok(teamId)) {
  // use team's own Anthropic key
} else if (aiUsageCap !== null) {
  const used = await getMonthlyTokenUsage(teamId);
  if (used >= aiUsageCap * 1000) { // rough token estimate
    return reply.code(429).send({
      error: 'AI_USAGE_CAP_REACHED',
      currentPlan: plan,
      message: 'Monthly AI usage limit reached. Upgrade to continue using AI features.',
    });
  }
}
```

### 6.3 Post-request token logging

After each Anthropic API call, insert into `ai_usage_log` with the actual token count from the response.

---

## Phase 7: Testing

### 7.1 Unit tests — `apps/api/src/__tests__/middleware/plan.test.ts`

- Returns `'free'` for teams with no subscription row
- Returns `'free'` for teams with `status: 'past_due'`
- `requirePlan('snapshots')` returns 403 for free plan
- `requirePlan('snapshots')` passes for starter plan
- `requirePlan('nonDevChangeFlow')` returns 403 for starter plan
- `requirePlan('nonDevChangeFlow')` passes for team plan

### 7.2 Unit tests — `apps/api/src/__tests__/routes/subscriptions.test.ts`

- `GET /teams/:teamId/subscription` returns plan + limits
- `POST /checkout` returns a Stripe session URL (mock Stripe client)
- Stripe webhook `checkout.session.completed` upgrades plan in DB
- Stripe webhook `customer.subscription.deleted` resets plan to free

### 7.3 E2E tests — `e2e/subscription.spec.ts`

#### Critical flows:

**Free plan gate:**
```
Given: team is on free plan
When:  user clicks "Create Snapshot"
Then:  PlanGate renders upgrade prompt, not the snapshot form
```

**Seat limit:**
```
Given: free plan team (1 seat)
When:  owner invites a second user
Then:  API returns 403 PLAN_LIMIT_EXCEEDED, UI shows upgrade dialog
```

**Checkout redirect:**
```
Given: team is on free plan
When:  user clicks "Upgrade to Starter" on pricing page
Then:  browser redirects to Stripe Checkout URL
```

**Post-upgrade access:**
```
Given: Stripe webhook fires checkout.session.completed for starter
When:  user refreshes billing page
Then:  plan shows "Starter", snapshot UI is no longer gated
```

Test file: `e2e/subscription.spec.ts`
Fixtures: extend `e2e/fixtures/test-base.ts` with `teamOnPlan(plan: PlanTier)` helper that sets the DB row directly.

---

## Phase 8: Environment Variables

Add to `.env.example` and Railway/Render config:

```
# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_STARTER=price_...
STRIPE_PRICE_ID_TEAM=price_...

# Frontend (Vite)
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

---

## Implementation Order

```
Phase 1 (shared config)
  └─ Phase 2 (DB schema)
       ├─ Phase 3 (API enforcement)
       │    └─ Phase 7.1 (plan middleware unit tests)
       ├─ Phase 4 (subscription routes)
       │    └─ Phase 7.2 (route unit tests)
       └─ Phase 5 (frontend)
            └─ Phase 7.3 (E2E tests)
Phase 6 (AI metering) — can run in parallel with Phase 5
Phase 8 (env vars) — set up before any Stripe calls
```

Phases 1–3 are the critical path. Phases 5–6 can be developed in parallel once the API is stable.
