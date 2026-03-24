# Persistent Pipeline Access — Implementation Execution Plan

This document provides a sequenced, task-level plan for building the feature defined in [`docs/features/persistent-pipeline-access.md`](../features/persistent-pipeline-access.md). Work is split into four phases. Each phase is independently deployable; later phases depend on earlier ones.

---

## Phase 0: Prerequisites

Before writing any code, confirm these are true:

- [ ] `marketplace_listings` table exists and is populated with at least one paid listing in dev/staging.
- [ ] `credit_balances` and `credit_transactions` tables exist and the `deductCredits` service function is working.
- [ ] Drizzle ORM push workflow is functional (`pnpm --filter api exec drizzle-kit push`).
- [ ] A test user with a non-zero credit balance exists in seed data (`apps/api/src/db/seed.ts`).
- [ ] Auth middleware (`apps/api/src/middleware/auth.ts`) is wired into marketplace routes.

---

## Phase 1: Database Schema

**Goal:** Add the `marketplace_purchases` table that tracks per-user pipeline ownership.

### 1.1 Add Drizzle Schema Definition

**File:** `apps/api/src/db/schema.ts`

After the `marketplaceReviews` table definition, add:

```ts
// ── Marketplace Purchases ─────────────────────────────
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

**Why:** The unique index on `(userId, listingId)` is the enforcement mechanism — it makes double-insert an idempotent no-op at the DB level.

### 1.2 Push Schema to Database

```bash
pnpm --filter api exec drizzle-kit push --force
```

> In CI, schema push runs automatically via the `drizzle-kit push --force` step in the CI pipeline.

### 1.3 Verify

```bash
pnpm --filter api test -- --testPathPattern=schema
```

Check that `marketplace_purchases` appears in the table list when connecting to the dev DB.

---

## Phase 2: Backend — API Routes and Service Layer

**Goal:** Make `POST /marketplace/:id/purchase` idempotent, add `GET /marketplace/owned`, and add `GET /marketplace/:id/access`.

### 2.1 Update `apps/api/src/routes/marketplace.ts`

#### 2.1.1 Import the new table

At the top of the file, add `marketplacePurchases` to the schema import:

```ts
import { marketplaceListings, marketplaceReviews, marketplacePurchases, users } from '../db/schema.js';
```

Also import `and` from drizzle-orm if not already imported (it is — confirm).

#### 2.1.2 Update `POST /:id/purchase`

Replace the existing purchase handler with:

```ts
app.post('/:id/purchase', async (request, reply) => {
  const userId = (request as any).user?.id;
  if (!userId) {
    reply.code(401);
    return { error: 'Authentication required' };
  }

  const { id } = request.params as { id: string };

  // Fetch listing
  const [listing] = await db
    .select()
    .from(marketplaceListings)
    .where(eq(marketplaceListings.id, id));

  if (!listing || !listing.published) {
    reply.code(404);
    return { error: 'Listing not found' };
  }

  // Free listings don't need purchase
  if (listing.priceType === 'free' || !listing.priceAmountCents) {
    reply.code(400);
    return { error: 'This listing is free. Use the download endpoint instead.' };
  }

  // Check if user already owns this listing
  const [existing] = await db
    .select()
    .from(marketplacePurchases)
    .where(
      and(
        eq(marketplacePurchases.userId, userId),
        eq(marketplacePurchases.listingId, id),
      ),
    )
    .limit(1);

  if (existing) {
    // Already owned — return content without charging
    return {
      content: listing.content,
      title: listing.title,
      alreadyOwned: true,
    };
  }

  // First-time purchase — deduct credits
  const creditCost = listing.priceAmountCents;

  try {
    const { balance } = await deductCredits(
      userId,
      creditCost,
      'marketplace_purchase',
      `Purchased "${listing.title}" (${listing.type})`,
    );

    // Record ownership
    await db.insert(marketplacePurchases).values({
      userId,
      listingId: id,
      creditsPaid: creditCost,
    });

    // Increment download count
    await db
      .update(marketplaceListings)
      .set({ downloadCount: sql`${marketplaceListings.downloadCount} + 1` })
      .where(eq(marketplaceListings.id, id));

    return {
      content: listing.content,
      title: listing.title,
      balance,
      alreadyOwned: false,
      message: `Successfully purchased "${listing.title}" for ${creditCost} credits`,
    };
  } catch (err: any) {
    if (err?.statusCode === 402) {
      reply.code(402);
      return { error: 'Insufficient credits', required: creditCost };
    }
    throw err;
  }
});
```

**Key change:** ownership check runs before `deductCredits`. If owned, early-return with content — no DB write, no credit change.

#### 2.1.3 Add `GET /owned`

Register this route **before** `GET /:id` to prevent the `:id` param handler from catching `"owned"` as an ID:

```ts
// GET /owned — list all listings the authenticated user has purchased
app.get('/owned', async (request, reply) => {
  const userId = (request as any).user?.id;
  if (!userId) {
    reply.code(401);
    return { error: 'Authentication required' };
  }

  const rows = await db
    .select({
      id: marketplaceListings.id,
      type: marketplaceListings.type,
      title: marketplaceListings.title,
      description: marketplaceListings.description,
      content: marketplaceListings.content,
      category: marketplaceListings.category,
      tags: marketplaceListings.tags,
      creditsPaid: marketplacePurchases.creditsPaid,
      purchasedAt: marketplacePurchases.purchasedAt,
    })
    .from(marketplacePurchases)
    .innerJoin(
      marketplaceListings,
      eq(marketplacePurchases.listingId, marketplaceListings.id),
    )
    .where(eq(marketplacePurchases.userId, userId))
    .orderBy(desc(marketplacePurchases.purchasedAt));

  return { listings: rows };
});
```

> **Route ordering note:** Fastify matches routes in registration order. `GET /owned` must be registered before `GET /:id` or Fastify will try to look up a listing with id `"owned"`.

#### 2.1.4 Add `GET /:id/access`

```ts
// GET /:id/access — check if authenticated user owns a listing
app.get('/:id/access', async (request, reply) => {
  const userId = (request as any).user?.id;
  if (!userId) {
    reply.code(401);
    return { error: 'Authentication required' };
  }

  const { id } = request.params as { id: string };

  const [purchase] = await db
    .select({ creditsPaid: marketplacePurchases.creditsPaid })
    .from(marketplacePurchases)
    .where(
      and(
        eq(marketplacePurchases.userId, userId),
        eq(marketplacePurchases.listingId, id),
      ),
    )
    .limit(1);

  return {
    owned: !!purchase,
    creditsPaid: purchase?.creditsPaid ?? null,
  };
});
```

### 2.2 Update App Route Registration

**File:** `apps/api/src/app.ts`

No changes needed if `marketplaceRoutes` is already registered. Verify the plugin prefix is `/marketplace`.

### 2.3 Backend Tests

**File:** `apps/api/src/__tests__/routes/marketplace.test.ts` (or create if it doesn't exist)

Add test cases:

```
describe('POST /marketplace/:id/purchase', () => {
  it('deducts credits and returns alreadyOwned=false on first purchase')
  it('returns alreadyOwned=true without deducting credits on repeat purchase')
  it('returns 402 on insufficient credits for first purchase')
  it('returns 400 for free listings')
  it('returns 401 when unauthenticated')
  it('inserts exactly one marketplace_purchases row even if called twice')
})

describe('GET /marketplace/owned', () => {
  it('returns empty array for a user with no purchases')
  it('returns purchased listing after purchase')
  it('does not return listings purchased by other users')
  it('returns 401 when unauthenticated')
})

describe('GET /marketplace/:id/access', () => {
  it('returns { owned: false } before purchase')
  it('returns { owned: true, creditsPaid: N } after purchase')
  it('returns 401 when unauthenticated')
})
```

Run tests:
```bash
pnpm --filter api test -- --testPathPattern=marketplace
```

---

## Phase 3: Frontend

**Goal:** Surface ownership status in the Marketplace UI — owned badge, conditional CTA, and "My Pipelines" filter.

### 3.1 Add API Client Functions

**File:** `apps/web/src/lib/api.ts`

Add:

```ts
export type OwnedListing = {
  id: string;
  type: string;
  title: string;
  description: string;
  content: string;
  category: string | null;
  tags: string[];
  creditsPaid: number;
  purchasedAt: string;
};

export async function fetchOwnedListings(): Promise<OwnedListing[]> {
  const res = await apiClient.get('/marketplace/owned');
  return res.data.listings;
}

export async function checkListingAccess(
  id: string,
): Promise<{ owned: boolean; creditsPaid: number | null }> {
  const res = await apiClient.get(`/marketplace/${id}/access`);
  return res.data;
}
```

Update `purchaseMarketplaceListing` return type to include `alreadyOwned`:

```ts
export type PurchaseResult = {
  content: string;
  title: string;
  alreadyOwned: boolean;
  balance?: number;
  message?: string;
};
```

### 3.2 Update `Marketplace.tsx`

**File:** `apps/web/src/pages/Marketplace.tsx`

#### 3.2.1 Fetch owned listing IDs alongside marketplace listing

In the Pipelines tab component, add a query for owned listings:

```ts
const { data: ownedData } = useQuery({
  queryKey: ['marketplace', 'owned'],
  queryFn: fetchOwnedListings,
});

const ownedIds = new Set((ownedData ?? []).map((l) => l.id));
```

#### 3.2.2 Update `PriceBadge` component

```tsx
function PriceBadge({
  priceType,
  priceAmountCents,
  creditPrice,
  owned,
}: {
  priceType: string;
  priceAmountCents: number | null;
  creditPrice: number | null;
  owned?: boolean;
}) {
  if (owned) {
    return (
      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200">
        Owned
      </span>
    );
  }
  if (priceType === 'free') {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
        Free
      </span>
    );
  }
  const credits = creditPrice ?? priceAmountCents ?? 0;
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
      {credits} {credits === 1 ? 'credit' : 'credits'}
    </span>
  );
}
```

Pass `owned={ownedIds.has(listing.id)}` wherever `PriceBadge` is rendered.

#### 3.2.3 Conditional CTA Button

In the pipeline card action area, replace the single purchase button with:

```tsx
{ownedIds.has(listing.id) ? (
  <button
    onClick={() => handleOpenPipeline(listing)}
    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
  >
    Open Pipeline
  </button>
) : listing.priceType === 'free' ? (
  <button
    onClick={() => handleDownload(listing.id)}
    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
  >
    Use for free
  </button>
) : (
  <button
    onClick={() => handlePurchase(listing)}
    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 transition-colors"
  >
    Activate — {listing.creditPrice ?? listing.priceAmountCents} credits
  </button>
)}
```

#### 3.2.4 Handle `alreadyOwned` in `handlePurchase`

Update the purchase mutation's `onSuccess` callback:

```ts
onSuccess: (result) => {
  if (result.alreadyOwned) {
    // Silently open the pipeline — don't show "purchased!" toast
    handleOpenPipeline(listing);
  } else {
    toast.success(result.message ?? 'Pipeline activated!');
    queryClient.invalidateQueries({ queryKey: ['marketplace', 'owned'] });
    queryClient.invalidateQueries({ queryKey: ['credits', 'balance'] });
    handleOpenPipeline(listing);
  }
},
```

#### 3.2.5 Add "My Pipelines" filter / sub-tab

Within the Pipelines tab, add a toggle above the grid:

```tsx
const [showOwnedOnly, setShowOwnedOnly] = useState(false);

// ...

<div className="flex items-center gap-2 mb-4">
  <button
    onClick={() => setShowOwnedOnly(false)}
    className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
      !showOwnedOnly
        ? 'bg-slate-900 text-white'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
    }`}
  >
    All Pipelines
  </button>
  <button
    onClick={() => setShowOwnedOnly(true)}
    className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
      showOwnedOnly
        ? 'bg-blue-600 text-white'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
    }`}
  >
    My Pipelines {ownedIds.size > 0 && `(${ownedIds.size})`}
  </button>
</div>
```

When `showOwnedOnly` is true, filter the displayed listings to `ownedIds`:

```ts
const displayedListings = showOwnedOnly
  ? listings.filter((l) => ownedIds.has(l.id))
  : listings;
```

Empty state when owned filter is active and there are no owned pipelines:

```tsx
{showOwnedOnly && displayedListings.length === 0 && (
  <EmptyState
    icon="○"
    title="No pipelines yet"
    subtitle="Activate a pipeline and it will appear here."
  />
)}
```

### 3.3 Frontend Tests

**File:** `apps/web/src/__tests__/` — add or update Marketplace component tests:

- Mock `fetchOwnedListings` to return a listing ID.
- Render the Marketplace Pipelines tab.
- Assert the listing renders "Owned" badge and "Open Pipeline" button.
- Assert listings not in owned set still render the price badge and "Activate" button.
- Assert "My Pipelines" filter shows only owned listings.

Run tests:
```bash
pnpm --filter web test -- --testPathPattern=Marketplace
```

---

## Phase 4: Data Backfill (Production Only)

**Goal:** Retroactively populate `marketplace_purchases` for users who already paid before this feature shipped.

### 4.1 Backfill Script

**File:** `apps/api/src/db/scripts/backfill-marketplace-purchases.ts`

```ts
import { db } from '../index.js';
import { creditTransactions, marketplacePurchases, marketplaceListings } from '../schema.js';
import { eq, like } from 'drizzle-orm';

// Fetch all past marketplace purchase transactions
const transactions = await db
  .select()
  .from(creditTransactions)
  .where(eq(creditTransactions.taskType, 'marketplace_purchase'));

// For each transaction, match to a listing by title string
// Description format: `Purchased "{listing.title}" ({listing.type})`
const listings = await db.select().from(marketplaceListings);
const titleToListing = new Map(listings.map((l) => [l.title, l]));

let inserted = 0;
let skipped = 0;

for (const tx of transactions) {
  const match = tx.description.match(/^Purchased "(.+)" \(/);
  if (!match) { skipped++; continue; }
  const title = match[1];
  const listing = titleToListing.get(title);
  if (!listing) { skipped++; continue; }

  await db
    .insert(marketplacePurchases)
    .values({
      userId: tx.userId,
      listingId: listing.id,
      creditsPaid: Math.abs(tx.amount),
      purchasedAt: tx.createdAt,
    })
    .onConflictDoNothing(); // Skip if already exists (idempotent)

  inserted++;
}

console.log(`Backfill complete: ${inserted} inserted, ${skipped} skipped`);
```

Run on production:
```bash
pnpm --filter api exec tsx src/db/scripts/backfill-marketplace-purchases.ts
```

**Verify:** After running, spot-check 3–5 known purchasers in the `marketplace_purchases` table and confirm their rows are present.

---

## Deployment Sequence

```
1. Merge schema change (Phase 1)
   → CI runs drizzle-kit push on staging DB
   → Verify table exists in staging

2. Deploy API with new routes (Phase 2)
   → POST /marketplace/:id/purchase is now idempotent
   → New GET /owned and GET /:id/access endpoints live
   → Run API test suite: pnpm --filter api test

3. Deploy frontend (Phase 3)
   → Owned badges and My Pipelines filter visible in staging
   → Manual QA pass against staging

4. Run backfill script on production DB (Phase 4)
   → Idempotent — safe to re-run
   → Verify row counts

5. Deploy to production
   → Monitor credit_transactions for marketplace_purchase volume
   → Expect repeat-purchase deductions to drop to ~0
```

---

## Acceptance Criteria

- [ ] A user who purchases a paid pipeline sees "Owned" badge on that pipeline immediately.
- [ ] Calling `POST /marketplace/:id/purchase` a second time returns `alreadyOwned: true` and the user's credit balance is unchanged.
- [ ] `GET /marketplace/owned` returns the purchased listing with correct `creditsPaid` and `purchasedAt`.
- [ ] The "My Pipelines" filter shows only owned listings and has an appropriate empty state.
- [ ] Free pipelines are unaffected — no `marketplace_purchases` row is created.
- [ ] All new backend tests pass: `pnpm --filter api test`.
- [ ] All new frontend tests pass: `pnpm --filter web test`.
- [ ] E2E test covers the full purchase → re-access flow without re-charging.
