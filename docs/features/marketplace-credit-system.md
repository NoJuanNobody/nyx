# Marketplace Credit System

**Issue:** #212
**Status:** Planned
**Author:** @NoJuanNobody

---

## Overview

Nyx already has scaffolding for a community marketplace (listings, reviews, download counts) and a credit ledger (balances, transactions). This document specifies what needs to be built to turn that scaffolding into a fully functional credit-based marketplace where users can buy and sell pipelines, workflows, templates, and prompts.

---

## Current State (What Already Exists)

### Database Schema
- `marketplace_listings` — stores items with `priceType` (`free` | `paid`), `priceAmountCents`, type (`template` | `workflow` | `prompt`), `downloadCount`, `authorId`
- `marketplace_reviews` — per-listing ratings (1–5) and comments
- `credit_balances` — per-user running balance (integer credits)
- `credit_transactions` — ledger of `purchase`, `consumption`, `refund` events

### API Routes
- `GET /marketplace` — browse published listings (filter by type, category, search)
- `GET /marketplace/:id` — single listing + reviews + average rating
- `POST /marketplace` — create a listing (auth required)
- `POST /marketplace/:id/reviews` — submit a review
- `POST /marketplace/:id/download` — increment download count, return content
- `DELETE /marketplace/:id` — delete own listing
- `GET /credits/balance` — current user's credit balance
- `GET /credits/transactions` — transaction history
- `POST /credits/deduct` — deduct credits (internal testing)
- `GET /credits/costs` — AI task cost table

### Frontend
- `Marketplace.tsx` — tabs for Pipelines, Templates, Workflows, Prompts, Feature Requests, Showcase

### What Is Missing
1. **Marketplace purchase flow** — `POST /marketplace/:id/download` does not gate paid items or deduct/award credits
2. **Pipeline listings** — `listing_type` enum only includes `template`, `workflow`, `prompt`; pipelines are not a type
3. **Creator earnings** — no mechanism to credit the seller when their paid item is purchased
4. **Credit acquisition** — no way for users to top up their balance (Stripe or equivalent)
5. **Seller payout** — no mechanism for creators to convert earned credits to real money
6. **Content moderation** — no admin tools to review/approve/reject listings
7. **Frontend credit wallet** — the UI has no balance display, purchase confirmation, or purchase history
8. **Marketplace purchase receipt** — no `marketplace_purchases` join table to track who owns what

---

## Feature Specification

### 1. Credit Wallet

Credits are the platform's internal currency. 1 credit = $0.10 USD (approximate; exact rate is a product decision).

**Earning credits:**
- Top up via Stripe Checkout (e.g., 10 / 50 / 100 / 500 credit bundles)
- Earn passively when another user purchases your paid listing

**Spending credits:**
- Purchase paid marketplace items
- AI operations (spec analysis, drift detection, ticket generation, voice agent minutes) — already implemented

**Balance display:**
- Credit balance shown persistently in the sidebar/navbar
- Low-balance warning when balance drops below 5 credits

### 2. Marketplace Listings

#### Item Types
Add `pipeline` to the `listing_type` enum alongside `template`, `workflow`, `prompt`.

| Type | Description |
|---|---|
| `pipeline` | Multi-stage documentation pipeline (e.g., discovery → spec → review → ship) |
| `workflow` | Repeatable process within a single stage |
| `template` | Structured document template |
| `prompt` | AI prompt for spec writing, drift detection, etc. |

#### Pricing
- `priceType`: `free` or `paid`
- `priceCredits`: integer credits (replaces `priceAmountCents`; keep `priceAmountCents` for future fiat display)
- Suggested price tiers: 1, 5, 10, 25, 50 credits

#### Listing Fields
- Title, description, content (the actual payload)
- Type, category, tags, stage
- Preview images (optional, stored in S3/R2)
- Version field so creators can iterate

### 3. Purchase Flow

When a user purchases a paid listing:

1. Verify buyer has sufficient credits (`credits.service.getBalance`)
2. Deduct credits from buyer (`credits.service.deductCredits`)
3. Award credits to seller (`credits.service.addCredits` — new `sale` transaction type)
4. Insert row into `marketplace_purchases` (buyer, listing, credits paid, timestamp)
5. Increment `listing.downloadCount`
6. Return listing content to buyer

The seller receives **80%** of the listing's credit price (platform takes 20% fee).

For free listings, skip steps 1–4 and proceed directly to content delivery.

### 4. Content Moderation

Simple two-state model: `pending_review` → `published` (or `rejected`).

- New listings start as `published: false` until approved
- Admin route `PATCH /admin/marketplace/:id/moderate` sets `published: true | false`
- Optional: auto-publish free listings after basic spam/length checks; hold paid listings for manual review

### 5. Rating & Reviews

Already partially implemented. Additions needed:
- Prevent users from reviewing their own listings
- Allow one review per user per listing (unique index on `userId + listingId`)
- Require purchase (or download for free items) before reviewing

### 6. Credit Top-Up (Stripe Integration)

- `POST /credits/checkout` — creates a Stripe Checkout session for a credit bundle
- `POST /webhooks/stripe` — receives `checkout.session.completed`, calls `addCredits`
- Bundles: 10 credits ($1), 50 credits ($4.50), 100 credits ($8), 500 credits ($35)

### 7. Seller Payout (Phase 2)

Out of scope for initial implementation. Planned approach: accumulated creator credits can be redeemed for a Stripe payout once a minimum threshold (e.g., 100 credits) is reached.

---

## Implementation Plan

### Phase 1 — Core Purchase Flow (MVP)

**Estimated scope:** ~3–4 days of engineering

#### Step 1: Database
- [ ] Add `pipeline` to `listing_type` enum (new migration)
- [ ] Add `priceCredits integer` column to `marketplace_listings`
- [ ] Add `sale` to `credit_transaction_type` enum
- [ ] Create `marketplace_purchases` table:
  ```sql
  id uuid PK
  listing_id uuid FK → marketplace_listings
  buyer_id text (user id)
  seller_id text (user id)
  credits_paid integer
  platform_fee integer
  seller_earnings integer
  created_at timestamptz
  ```
- [ ] Add `unique(buyer_id, listing_id)` index on `marketplace_purchases` to prevent duplicate purchases
- [ ] Add `pending_review` status and update `published` logic

#### Step 2: Credits Service
- [ ] Add `sale` transaction type to `addCredits` (or create `awardSaleCredits`)
- [ ] Export a `purchaseMarketplaceItem(buyerId, sellerId, listingId, priceCredits)` transaction function that atomically deducts from buyer and awards to seller

#### Step 3: Marketplace API
- [ ] Add `priceCredits` to listing creation/response
- [ ] Update `POST /marketplace/:id/download`:
  - If free: current behavior (increment count, return content)
  - If paid: check buyer balance → deduct → award seller → insert purchase record → return content
- [ ] Add `GET /marketplace/:id/purchased` — check if requesting user owns the item (to gate re-downloads)
- [ ] Add `POST /admin/marketplace/:id/moderate` — toggle `published` (admin middleware guard)
- [ ] Prevent review of own listing in `POST /marketplace/:id/reviews`
- [ ] Add `GET /marketplace/my/listings` — creator dashboard listings
- [ ] Add `GET /marketplace/my/purchases` — buyer purchase history

#### Step 4: Frontend
- [ ] Add credit balance display to `Sidebar.tsx` (pull from `GET /credits/balance`)
- [ ] Add "Buy for X credits" button on paid listing cards in `Marketplace.tsx`
- [ ] Add purchase confirmation modal (shows price, current balance, earnings estimate for sellers)
- [ ] Add "Owned" badge on already-purchased items
- [ ] Add pipeline tab to marketplace (type = `pipeline`)
- [ ] Add "My Listings" sub-page for creators to manage their items
- [ ] Add "Purchase History" to user settings or profile page
- [ ] Show low-balance warning when < 5 credits

### Phase 2 — Credit Acquisition (Stripe)

**Estimated scope:** ~2 days of engineering

- [ ] Install `stripe` package in `apps/api`
- [ ] Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to env config
- [ ] Create `POST /credits/checkout` route (Stripe Checkout session)
- [ ] Create `POST /webhooks/stripe` route (handle `checkout.session.completed`)
- [ ] Add credit bundle picker UI in Settings → Billing

### Phase 3 — Content Moderation & Quality

**Estimated scope:** ~1–2 days of engineering

- [ ] Admin dashboard page or simple admin API for moderation queue
- [ ] Email notification to creator on approval/rejection
- [ ] Auto-check: minimum description length, content not empty
- [ ] Flag system: users can report inappropriate listings

### Phase 4 — Seller Payout (Future)

- Stripe Connect for seller payouts
- Minimum payout threshold
- 1099 tax form generation for US creators above IRS threshold

---

## API Contract (Phase 1)

### Updated `POST /marketplace/:id/download`

**Request:** authenticated, no body

**Response (free listing):**
```json
{ "content": "...", "title": "...", "alreadyOwned": false }
```

**Response (paid listing, sufficient credits):**
```json
{ "content": "...", "title": "...", "creditsSpent": 10, "newBalance": 40, "alreadyOwned": false }
```

**Response (paid listing, already owned):**
```json
{ "content": "...", "title": "...", "alreadyOwned": true }
```

**Error (insufficient credits):**
```json
{ "statusCode": 402, "message": "Insufficient credits. Balance: 3, required: 10" }
```

### New `GET /marketplace/my/purchases`

**Response:**
```json
[
  {
    "id": "uuid",
    "listingId": "uuid",
    "listing": { "title": "...", "type": "workflow", ... },
    "creditsSpent": 10,
    "createdAt": "2026-03-18T..."
  }
]
```

### New `GET /marketplace/my/listings`

**Response:**
```json
[
  {
    "id": "uuid",
    "title": "...",
    "type": "pipeline",
    "priceCredits": 25,
    "downloadCount": 47,
    "totalEarned": 940,
    "avgRating": 4.2,
    "published": true
  }
]
```

---

## Data Model Diagram

```
users
  ↓ (authorId)
marketplace_listings ←──────────────────── marketplace_reviews
  ↑ (listingId)                                  ↑ (listingId)
marketplace_purchases ──→ credit_transactions (buyer debit + seller credit)
  └── buyer_id ──→ credit_balances
  └── seller_id ──→ credit_balances
```

---

## Open Questions

1. **Credit price rate**: What is the USD equivalent of 1 credit? Recommendation: 1 credit = $0.10 USD for round-number bundles.
2. **Platform fee**: 20% take rate is standard for marketplaces (similar to Gumroad). Confirm before implementation.
3. **Refund policy**: What is the window for credit refunds on purchased items? Recommendation: no refunds after content is delivered (credits are digital goods).
4. **Listing versioning**: Should buyers who purchased v1 get v2 for free? Recommendation: yes, if same listing ID.
5. **Free-tier limits**: Should free users have a credit allowance at signup (e.g., 10 free credits)? This drives trial adoption.
6. **Moderation automation**: Use Claude API to auto-score listing quality? This aligns with Nyx's AI-first positioning.
