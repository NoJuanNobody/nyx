# Subscription Plans

Nyx uses a tiered subscription model that gates features by plan level. Plans are per-workspace (not per-user). Every workspace has exactly one active plan at any time.

---

## 1. Plan Overview

| | Free | Starter | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $29/mo | $99/mo | Custom |
| **Projects** | 1 | Up to 5 | Unlimited | Unlimited |
| **Seats** | 1 | Up to 5 | Up to 20 | Custom |
| **Seat types** | Dev only | Dev only | Dev + non-dev | Dev + non-dev |
| **Support** | Community | Email | Priority | Dedicated |

---

## 2. Feature Matrix

| Feature | Free | Starter | Team | Enterprise |
|---|---|---|---|---|
| Document editor (markdown + AI-assisted spec writing) | ✅ | ✅ | ✅ | ✅ |
| GitHub integration (drift detection) | ✅ | ✅ | ✅ | ✅ |
| Ticket creation (GitHub Issues / Jira) | ✅ | ✅ | ✅ | ✅ |
| Coding agent integrations (Claude Code, Cursor, Copilot) | ✅ | ✅ | ✅ | ✅ |
| Documentation export (Markdown, PDF) | ✅ | ✅ | ✅ | ✅ |
| Diff view | ✅ | ✅ | ✅ | ✅ |
| Version history | Limited | Full | Full | Full |
| Product snapshots | ❌ | ✅ | ✅ | ✅ |
| Rollback | ❌ | ✅ Doc-only | ✅ Full cross-platform | ✅ Full cross-platform |
| Doc branching & approval flow | ❌ | ✅ | ✅ | ✅ |
| Non-dev change flow (stakeholder → ticket) | ❌ | ❌ | ✅ | ✅ |
| Agile / Kanban board (unified view) | ❌ | ❌ | ✅ | ✅ |
| AI features (Nyx-managed) | ✅ Capped | ✅ Capped | ✅ Higher cap | ✅ Higher cap |
| BYOK (Bring Your Own Anthropic Key) | ❌ | ❌ | ✅ | ✅ Included |
| SSO | ❌ | ❌ | ❌ | ✅ |
| SLA | ❌ | ❌ | ❌ | ✅ |

### Version history limits (Free tier)

Free workspaces retain the last **30 days** of document history, capped at **10 versions per document**. Older versions are soft-deleted and purged after 7 additional days. Paid plans have no limit.

### Rollback scope

- **Starter (doc-only rollback):** Reverts document content to a prior version. Does not touch external state (GitHub, Jira).
- **Team / Enterprise (full cross-platform rollback):** Reverts document content **and** triggers cross-platform actions — reopens closed Jira tickets, creates revert PRs in GitHub — via the same integration layer used for the non-dev change flow.

### Non-dev change flow (Team+)

Non-dev seats can edit documentation. Nyx AI analyzes the accumulated changes and suggests how to group them into tickets. A dev-seat holder reviews and adjusts the groupings before tickets are pushed to GitHub Issues or Jira. Full traceability is maintained from the stakeholder edit through ticket creation to code change.

---

## 3. Seat Types

| Seat type | Can edit docs | Can approve doc branches | Can trigger ticket creation | Can review change proposals | Can manage workspace |
|---|---|---|---|---|---|
| **Dev** | ✅ | ✅ | ✅ | ✅ | ✅ (admin role only) |
| **Non-dev** | ✅ (via change proposal) | ❌ | ❌ directly (proposals only) | ❌ | ❌ |

Non-dev seats are only available on Team and Enterprise plans. Attempting to add a non-dev seat on Free or Starter returns a plan upgrade prompt.

---

## 4. AI Cost Strategy

Nyx uses a hybrid model to manage AI costs (drift detection, spec quality analysis, ticket generation):

- **Nyx-managed (Free & Starter):** AI is included with a monthly usage cap. No setup required. Cost is baked into the subscription price.
- **Nyx-managed with higher cap (Team):** Increased cap for larger workspaces. BYOK available as an opt-in alternative.
- **BYOK — Bring Your Own Key (Team & Enterprise):** The workspace owner connects their own Anthropic API key. AI usage bills directly to their Anthropic account. Removes the Nyx AI cap entirely and gives the team direct cost control and compliance flexibility.

BYOK is configured per-workspace under **Settings → Integrations → Anthropic API Key**.

---

## 5. Plan Enforcement

### 5.1 Enforcement Points

Feature access is enforced at the API layer, not just the UI. The following checks happen on every relevant request:

| Check | Enforced at |
|---|---|
| Project count limit | `POST /api/projects` |
| Seat count limit | `POST /api/workspaces/:id/members` |
| Non-dev seat creation | `POST /api/workspaces/:id/members` (role = non-dev) |
| Snapshot creation | `POST /api/snapshots` |
| Rollback (cross-platform) | `POST /api/rollbacks` |
| Doc branching | `POST /api/documents/:id/branches` |
| Agile board access | `GET /api/board` |
| BYOK key save | `PUT /api/settings/anthropic-key` |
| SSO configuration | `PUT /api/settings/sso` |

### 5.2 Enforcement Response

When a request is blocked by plan limits, the API returns:

```json
HTTP 403 Forbidden
{
  "error": "plan_limit_exceeded",
  "code": "PLAN_LIMIT_EXCEEDED",
  "message": "This feature requires the Team plan or higher.",
  "upgradeUrl": "https://nyx.dev/settings/billing"
}
```

The frontend catches `PLAN_LIMIT_EXCEEDED` errors and shows an upgrade modal with the relevant plan details and a CTA to the billing settings page.

### 5.3 Seat Limit Behavior

When a workspace reaches its seat limit:
- Existing members continue to have access uninterrupted.
- New invitations are blocked with a `SEAT_LIMIT_REACHED` error.
- Workspace admins see a banner: "You've reached your seat limit. Upgrade to add more members."

---

## 6. Billing Integration

Billing is handled externally (e.g., Stripe). Nyx stores only the plan state — not payment details.

### 6.1 Data Model

```sql
CREATE TABLE workspace_subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan             TEXT NOT NULL DEFAULT 'free',  -- 'free' | 'starter' | 'team' | 'enterprise'
  status           TEXT NOT NULL DEFAULT 'active', -- 'active' | 'past_due' | 'canceled' | 'trialing'
  seat_limit       INTEGER,                         -- NULL = unlimited (enterprise)
  project_limit    INTEGER,                         -- NULL = unlimited
  billing_provider TEXT,                            -- 'stripe'
  external_sub_id  TEXT,                            -- Stripe subscription ID
  current_period_end TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id)
);
```

### 6.2 Plan Resolution

Plan features are resolved at runtime from `workspace_subscriptions.plan`. The plan resolver is a shared utility (`packages/shared/src/plans.ts`) imported by both the API and frontend so feature checks are consistent.

```typescript
// packages/shared/src/plans.ts

export type Plan = 'free' | 'starter' | 'team' | 'enterprise';

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    maxProjects: 1,
    maxSeats: 1,
    nonDevSeats: false,
    versionHistoryDays: 30,
    versionHistoryMax: 10,
    snapshots: false,
    rollback: false,
    docBranching: false,
    nonDevChangeFlow: false,
    kanbanBoard: false,
    byok: false,
    sso: false,
  },
  starter: {
    maxProjects: 5,
    maxSeats: 5,
    nonDevSeats: false,
    versionHistoryDays: null,   // unlimited
    versionHistoryMax: null,
    snapshots: true,
    rollback: 'doc-only',
    docBranching: true,
    nonDevChangeFlow: false,
    kanbanBoard: false,
    byok: false,
    sso: false,
  },
  team: {
    maxProjects: null,
    maxSeats: 20,
    nonDevSeats: true,
    versionHistoryDays: null,
    versionHistoryMax: null,
    snapshots: true,
    rollback: 'full',
    docBranching: true,
    nonDevChangeFlow: true,
    kanbanBoard: true,
    byok: true,
    sso: false,
  },
  enterprise: {
    maxProjects: null,
    maxSeats: null,
    nonDevSeats: true,
    versionHistoryDays: null,
    versionHistoryMax: null,
    snapshots: true,
    rollback: 'full',
    docBranching: true,
    nonDevChangeFlow: true,
    kanbanBoard: true,
    byok: true,
    sso: true,
  },
};

export function canUseFeature(plan: Plan, feature: keyof PlanLimits): boolean {
  const limits = PLAN_LIMITS[plan];
  const value = limits[feature];
  return value !== false && value !== null ? true : !!value;
}
```

### 6.3 Webhook Handling

Billing provider webhooks update `workspace_subscriptions` when:
- A subscription is created or upgraded → `plan` updated, `status = active`
- A payment fails → `status = past_due`; feature access is preserved for a grace period (7 days)
- A subscription is canceled → `status = canceled`; downgrade to Free limits at `current_period_end`
- A subscription is reactivated → `status = active`

Webhook endpoint: `POST /webhooks/billing`

---

## 7. Upgrade / Downgrade Flow

### 7.1 Upgrade

1. User visits **Settings → Billing**, selects a higher plan.
2. Frontend redirects to the billing provider's hosted checkout.
3. On successful payment, the provider fires a webhook.
4. API updates `workspace_subscriptions.plan` and `status`.
5. New features are immediately available.

### 7.2 Downgrade

1. User selects a lower plan.
2. Downgrade is **scheduled** for `current_period_end` — not immediate.
3. A banner is shown: "Your plan will change to [plan] on [date]."
4. At `current_period_end`:
   - If projects exceed the new limit, excess projects are **read-only** (not deleted). A warning directs the admin to archive them.
   - If seats exceed the new limit, the most recently added seats are **deactivated** (not deleted). Admins can reactivate within the new limit by deactivating others.
   - Non-dev seats on a plan that doesn't support them are converted to read-only pending manual action.

Data is never deleted automatically on downgrade. Admins have 30 days to resolve limit conflicts before excess data is soft-deleted.

---

## 8. API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workspaces/:id/subscription` | Get current plan and usage stats |
| `POST` | `/api/workspaces/:id/subscription/checkout` | Create billing provider checkout session |
| `POST` | `/api/workspaces/:id/subscription/portal` | Open billing provider customer portal (manage/cancel) |
| `GET` | `/api/plans` | List all plans with features and pricing (public, no auth) |
| `POST` | `/webhooks/billing` | Billing provider webhook (plan changes, payment events) |

**Get subscription response:**
```json
GET /api/workspaces/:id/subscription

200 OK
{
  "plan": "starter",
  "status": "active",
  "usage": {
    "projects": 3,
    "maxProjects": 5,
    "seats": 4,
    "maxSeats": 5
  },
  "currentPeriodEnd": "2026-04-15T00:00:00Z",
  "upgradeUrl": "https://nyx.dev/settings/billing"
}
```

---

## 9. Frontend: Plan Gate Component

A reusable `<PlanGate>` component wraps any feature that requires a specific plan. It renders its children if the workspace qualifies, or an upgrade prompt otherwise.

```tsx
// Usage example
<PlanGate requires="team" feature="Non-dev change flow">
  <ChangeProposalPanel />
</PlanGate>
```

The component reads the workspace plan from the workspace context (fetched once on load and cached). It does **not** make a separate API call per gate.

---

## 10. E2E Testing

### 10.1 Critical User Flows

1. **Free tier blocks snapshot creation** — user on Free plan clicks "Create snapshot"; upgrade modal appears; no snapshot is created.
2. **Starter allows doc-only rollback** — user on Starter plan can roll back a document; cross-platform rollback options are absent.
3. **Team unlocks non-dev change flow** — non-dev seat on Team plan submits a change proposal; the proposal routes correctly through the review flow.
4. **Seat limit enforcement** — workspace at seat limit cannot invite a new member; correct error is shown.
5. **Downgrade degrades access gracefully** — workspace downgraded from Team to Starter loses kanban board access at period end; existing data is preserved.

### 10.2 Test Scenarios (Given/When/Then)

**Scenario 1: Plan gate blocks feature on Free**
```
Given: A workspace on the Free plan
When: The user navigates to the snapshots page
Then: A plan upgrade prompt is shown
  And: No API call to POST /api/snapshots is made
```

**Scenario 2: Seat limit blocks invite**
```
Given: A Starter workspace with 5/5 seats filled
When: An admin tries to invite a new member
Then: POST /api/workspaces/:id/members returns 403 SEAT_LIMIT_REACHED
  And: The UI shows "You've reached your seat limit"
```

**Scenario 3: BYOK saves on Team plan**
```
Given: A workspace on the Team plan
When: The admin saves a valid Anthropic API key in Settings → Integrations
Then: The key is stored (encrypted) and AI features use the workspace's key
  And: The AI usage cap is removed
```

### 10.3 Test Data Requirements

- Seed workspaces for each plan tier (`free_workspace`, `starter_workspace`, `team_workspace`)
- Seed a workspace at each resource limit (projects, seats) for limit-enforcement tests
- Billing webhook fixtures simulating upgrade, downgrade, and payment failure events

### 10.4 Playwright Test File Locations

```
e2e/
  subscription/
    plan-gates.spec.ts           # PlanGate component blocks/allows correctly per plan
    seat-limits.spec.ts          # Seat limit enforcement on member invite
    upgrade-flow.spec.ts         # Billing checkout redirect and post-webhook state
    downgrade-flow.spec.ts       # Scheduled downgrade, read-only excess data
    byok.spec.ts                 # BYOK key save and AI cap removal
```
