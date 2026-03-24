# Persistent Pipeline Access

Users who purchase or activate a marketplace pipeline should never be charged again when they switch back to it. Access is persistent once unlocked — credits are only spent on first-time activation and on per-use compute costs, not on re-entry.

---

## 1. Problem

The current `POST /marketplace/:id/purchase` endpoint calls `deductCredits` on every invocation. There is no record of prior purchases, so a user who returns to a pipeline they already paid for is charged a second (or third) time. This:

- Violates the implicit contract that paying for a resource grants ongoing access.
- Discourages workflow exploration — users avoid switching pipelines to conserve credits.
- Erodes trust in the credit system, leading to churn and support tickets.

---

## 2. Goals

| # | Goal |
|---|---|
| G1 | A user who has purchased a paid pipeline listing is never charged credits for it again. |
| G2 | Free listings remain free and require no ownership record. |
| G3 | Users can see which pipelines they already own ("My Pipelines"). |
| G4 | Per-use compute costs (AI calls, inference) remain separate from access grants. |
| G5 | The solution is backward-compatible — existing download/free flows are unchanged. |

---

## 3. Non-Goals

- Subscription-gated access (e.g. "pro plan unlocks all pipelines") — out of scope.
- Team-level pipeline ownership — access is tracked per user for now.
- Transferring ownership between users.
- Expiring pipeline access after a time window.

---

## 4. User Stories

**US-1 — Re-access without re-payment**
> As a user who has already purchased a pipeline, when I click "Activate" or "Open" on that pipeline again, I should enter it immediately — no credit prompt, no deduction.

**US-2 — My Pipelines view**
> As a user, I want to filter the Marketplace to show only pipelines I already own, so I can quickly find and resume my workflows.

**US-3 — Owned badge**
> As a user browsing the Marketplace, I want purchased pipelines to display an "Owned" badge instead of a credit price, so I know what I already have access to at a glance.

**US-4 — First-time purchase still charges**
> As a user, I expect to be charged credits the first time I activate a paid pipeline. I understand this grants me permanent access.

**US-5 — Compute costs remain separate**
> As a user, I understand that using a pipeline (e.g. running AI analysis) may still consume credits per-use. Owning the pipeline does not mean AI calls are free.

---

## 5. Data Model

### 5.1 New Table: `marketplace_purchases`

Tracks which users own which listings. One row per `(userId, listingId)` pair — unique constraint prevents double-recording.

```sql
CREATE TABLE marketplace_purchases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,                        -- Clerk user ID (matches credit_balances.user_id)
  listing_id  UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  credits_paid INTEGER NOT NULL DEFAULT 0,          -- Credits charged at time of purchase
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, listing_id)
);

CREATE INDEX marketplace_purchases_user_idx ON marketplace_purchases(user_id);
```

**Drizzle schema addition** (`apps/api/src/db/schema.ts`):

```ts
export const marketplacePurchases = pgTable('marketplace_purchases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  listingId: uuid('listing_id')
    .notNull()
    .references(() => marketplaceListings.id, { onDelete: 'cascade' }),
  creditsPaid: integer('credits_paid').notNull().default(0),
  purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('marketplace_purchases_user_listing_idx').on(t.userId, t.listingId),
]);
```

### 5.2 No Changes to Existing Tables

The `creditTransactions` table already records every deduction. The new `marketplace_purchases` table is additive — it acts as an access-grant registry, not a replacement for the ledger.

---

## 6. API Changes

### 6.1 Updated: `POST /marketplace/:id/purchase`

**New behavior:**
1. Authenticate user.
2. Fetch listing. Return 404 if not found.
3. Return 400 if listing is free (unchanged).
4. **Check ownership:** query `marketplace_purchases` for `(userId, listingId)`. If a row exists, skip credit deduction and return `{ alreadyOwned: true, content, title }`.
5. If not owned: deduct credits (existing logic), then **insert a row into `marketplace_purchases`**, then return `{ alreadyOwned: false, content, title, balance }`.

**Response shape additions:**

```ts
// Success — first purchase
{
  content: string;
  title: string;
  balance: number;          // remaining credit balance
  alreadyOwned: false;
  message: string;
}

// Success — already owned
{
  content: string;
  title: string;
  alreadyOwned: true;
}
```

### 6.2 New: `GET /marketplace/owned`

Returns all listings the authenticated user has purchased.

```
GET /marketplace/owned
Authorization: Bearer <token>
```

**Response:**

```ts
{
  listings: Array<{
    id: string;
    type: string;
    title: string;
    description: string;
    content: string;
    category: string | null;
    tags: string[];
    purchasedAt: string;   // ISO timestamp
    creditsPaid: number;
  }>
}
```

**Implementation notes:**
- Join `marketplace_purchases` with `marketplace_listings` on `listing_id`.
- Filter by `userId = request.user.id`.
- Order by `purchasedAt DESC`.

### 6.3 New: `GET /marketplace/:id/access`

Lightweight ownership check — used by the frontend before showing the Activate button vs. Open button.

```
GET /marketplace/:id/access
Authorization: Bearer <token>
```

**Response:**

```ts
{ owned: boolean; creditsPaid: number | null }
```

### 6.4 Updated: `GET /marketplace/` (list endpoint)

When the caller is authenticated, the response can include an `owned: boolean` field per listing if a `?includeOwned=true` query param is provided. This avoids N+1 calls from the frontend by batch-checking ownership.

**Optional query param:** `includeOwned=true`

When enabled:
- Fetch all `marketplace_purchases.listingId` for the current user in a single query.
- Attach `owned: true/false` to each listing row before returning.

---

## 7. Frontend Changes

### 7.1 Pipelines Tab — Owned Badge

In `apps/web/src/pages/Marketplace.tsx`, the `PriceBadge` component currently renders either "Free" or `"{n} credits"`. Add a third state:

```tsx
// New: Owned badge
<span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200">
  Owned
</span>
```

Logic: pass an `owned` prop to `PriceBadge`. When `owned === true`, show the owned badge regardless of price.

### 7.2 Pipelines Tab — CTA Button

Replace the single "Purchase" / "Download" button with conditional rendering:

| State | Button Label | Action |
|---|---|---|
| Free listing | "Use for free" | Calls `POST /marketplace/:id/download` |
| Paid, not owned | "Activate — {n} credits" | Calls `POST /marketplace/:id/purchase` |
| Paid, owned | "Open Pipeline" | Calls `POST /marketplace/:id/purchase` (returns `alreadyOwned: true`, grants access) or navigates directly |

### 7.3 "My Pipelines" Filter

Add an "Owned" toggle or sub-tab to the Pipelines tab. When active:
- Calls `GET /marketplace/owned`.
- Renders the owned pipelines grid.
- Empty state: "You haven't activated any pipelines yet."

### 7.4 API Client (`apps/web/src/lib/api.ts`)

Add new functions:

```ts
export async function fetchOwnedListings(): Promise<OwnedListing[]>
export async function checkListingAccess(id: string): Promise<{ owned: boolean; creditsPaid: number | null }>
```

Update `purchaseMarketplaceListing` to handle `alreadyOwned: true` in its response and surface it to the caller so the UI can skip the "purchased!" toast when the user already owns it.

---

## 8. Credit Ledger Integrity

No changes to the credit ledger design. The `deductCredits` function is only called when `marketplace_purchases` does not already contain a row for `(userId, listingId)`. Existing transactions in `credit_transactions` are unaffected.

**Important:** existing purchases made before this feature ships have no rows in `marketplace_purchases`. Migration options:

- **Option A (recommended):** Backfill `marketplace_purchases` from `credit_transactions` where `task_type = 'marketplace_purchase'` and match to listing by description string. This is approximate (descriptions include listing titles) so a manual review pass is needed.
- **Option B (simpler):** Accept that pre-existing purchasers will be re-charged once more after deploy, then own permanently. Communicate this in release notes and offer a credits refund to affected users via support.

Option B is lower-risk for data integrity but worse for user trust. **Option A is preferred** for a clean launch.

---

## 9. Testing Plan

### 9.1 Unit Tests (Vitest)

**`apps/api/src/__tests__/routes/marketplace.test.ts` additions:**

- `POST /marketplace/:id/purchase` — first purchase: deducts credits, creates `marketplace_purchases` row, returns `alreadyOwned: false`.
- `POST /marketplace/:id/purchase` — repeat purchase: no credit deduction, returns `alreadyOwned: true`, `marketplace_purchases` row count unchanged.
- `POST /marketplace/:id/purchase` — free listing: returns 400 (unchanged).
- `POST /marketplace/:id/purchase` — insufficient credits on first purchase: returns 402 (unchanged).
- `GET /marketplace/owned` — returns only listings owned by the authenticated user.
- `GET /marketplace/owned` — returns empty array when user owns nothing.
- `GET /marketplace/:id/access` — returns `{ owned: true }` after purchase.
- `GET /marketplace/:id/access` — returns `{ owned: false }` before purchase.

### 9.2 E2E Tests (Playwright)

**`e2e/` additions:**

- Navigate to Marketplace → Pipelines tab.
- Purchase a paid pipeline (seed a paid listing + sufficient credit balance).
- Verify "Owned" badge appears.
- Refresh or re-navigate to Marketplace.
- Click the pipeline again; verify no credit deduction in the credit balance display.
- Navigate to "My Pipelines" / owned filter; verify the pipeline appears.

### 9.3 Manual QA Checklist

- [ ] Purchase a paid pipeline → credits deducted, owned badge appears.
- [ ] Navigate away and return → owned badge still appears, no re-charge on open.
- [ ] Purchase same pipeline in a new browser session (different tab) → no second charge.
- [ ] Free pipeline → unaffected, no owned tracking needed.
- [ ] Credit balance display stays accurate throughout.
- [ ] `GET /marketplace/owned` returns the right listings for user A but not user B.

---

## 10. Rollout

1. **Schema migration:** run Drizzle migration to create `marketplace_purchases` table (no downtime risk — additive).
2. **Backend deploy:** deploy updated `marketplace.ts` route. The `purchase` endpoint is now idempotent for previously purchased listings.
3. **Backfill (Option A):** run the backfill script on the production database to populate `marketplace_purchases` from existing `credit_transactions`.
4. **Frontend deploy:** deploy updated Marketplace UI with owned badges and "My Pipelines" filter.
5. **Monitor:** watch credit transaction logs for `marketplace_purchase` task type — verify the volume of repeat-purchase charges drops to near-zero post-deploy.

---

## 11. Open Questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | Should owned access be per-user or per-team? (Current design: per-user.) | Product |
| OQ-2 | Should pipeline ownership expire after N months? | Product |
| OQ-3 | What happens if a listing is deleted by its author — should owned users retain access? (Current: `ON DELETE CASCADE` removes purchase records. Consider archiving instead.) | Product / Eng |
| OQ-4 | Should the `GET /marketplace/` list endpoint always include `owned` status when authenticated, or only on explicit opt-in? | Eng |
| OQ-5 | Backfill approach — Option A vs Option B (see §8). | Eng / Product |
