import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { marketplaceListings, marketplaceReviews, marketplaceTransactions, users } from '../db/schema.js';
import {
  createConnectAccount,
  createConnectAccountLink,
  getConnectAccountStatus,
  createMarketplaceCheckout,
} from '../services/stripe.service.js';

export const marketplaceRoutes: FastifyPluginAsync = async (app) => {
  // GET / — list published listings with optional type/category/search filters
  app.get('/', async (request) => {
    const { type, category, search, limit = '20', offset = '0' } = request.query as Record<string, string>;
    let query = db.select().from(marketplaceListings).where(eq(marketplaceListings.published, true)).orderBy(desc(marketplaceListings.createdAt));
    // Apply filters in JS for simplicity
    const rows = await query;
    let filtered = rows;
    if (type) filtered = filtered.filter(r => r.type === type);
    if (category) filtered = filtered.filter(r => r.category === category);
    if (search) filtered = filtered.filter(r => r.title.toLowerCase().includes(search.toLowerCase()) || r.description.toLowerCase().includes(search.toLowerCase()));
    return filtered.slice(Number(offset), Number(offset) + Number(limit));
  });

  // GET /:id — get single listing with reviews
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [listing] = await db.select().from(marketplaceListings).where(eq(marketplaceListings.id, id));
    if (!listing) { reply.code(404); return { error: 'Listing not found' }; }
    const reviews = await db.select().from(marketplaceReviews).where(eq(marketplaceReviews.listingId, id)).orderBy(desc(marketplaceReviews.createdAt));
    const avgRating = reviews.length > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null;
    return { ...listing, reviews, avgRating };
  });

  // POST / — create listing (auth required)
  app.post('/', async (request) => {
    const userId = request.user.id;
    const body = request.body as { type: string; title: string; description: string; content: string; priceType?: string; priceAmountCents?: number; category?: string; tags?: string[]; stage?: string; teamId?: string };
    const [listing] = await db.insert(marketplaceListings).values({
      type: body.type as any,
      title: body.title,
      description: body.description,
      content: body.content,
      priceType: (body.priceType || 'free') as any,
      priceAmountCents: body.priceAmountCents,
      category: body.category,
      tags: body.tags || [],
      stage: body.stage as any,
      authorId: userId,
      teamId: body.teamId,
      published: true,
    }).returning();
    return listing;
  });

  // POST /:id/reviews — add review
  app.post('/:id/reviews', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    const { rating, comment } = request.body as { rating: number; comment?: string };
    if (rating < 1 || rating > 5) { reply.code(400); return { error: 'Rating must be 1-5' }; }
    const [review] = await db.insert(marketplaceReviews).values({ listingId: id, userId, rating, comment }).returning();
    return review;
  });

  // POST /:id/download — increment download count
  app.post('/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [listing] = await db.select().from(marketplaceListings).where(eq(marketplaceListings.id, id));
    if (!listing) { reply.code(404); return { error: 'Listing not found' }; }
    await db.update(marketplaceListings).set({ downloadCount: listing.downloadCount + 1 }).where(eq(marketplaceListings.id, id));
    return { content: listing.content, title: listing.title };
  });

  // DELETE /:id — delete own listing
  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    const [listing] = await db.select().from(marketplaceListings).where(and(eq(marketplaceListings.id, id), eq(marketplaceListings.authorId, userId)));
    if (!listing) { reply.code(404); return { error: 'Listing not found or unauthorized' }; }
    await db.delete(marketplaceListings).where(eq(marketplaceListings.id, id));
    return { deleted: true };
  });

  // POST /:id/purchase — initiate purchase of a paid listing
  app.post('/:id/purchase', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    const { successUrl, cancelUrl } = request.body as { successUrl: string; cancelUrl: string };

    const [listing] = await db.select().from(marketplaceListings).where(eq(marketplaceListings.id, id));
    if (!listing) { reply.code(404); return { error: 'Listing not found' }; }
    if (listing.priceType !== 'paid' || !listing.priceAmountCents) {
      reply.code(400); return { error: 'This listing is free — use the download endpoint instead' };
    }

    // Get seller's Connect account
    const [seller] = await db.select({ stripeConnectAccountId: users.stripeConnectAccountId }).from(users).where(eq(users.id, listing.authorId));
    if (!seller?.stripeConnectAccountId) {
      reply.code(400); return { error: 'Seller has not connected their Stripe account yet' };
    }

    const [buyer] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!buyer) { reply.code(400); return { error: 'Buyer user not found' }; }

    const { url, transactionId } = await createMarketplaceCheckout({
      listingId: id,
      listingTitle: listing.title,
      amountCents: listing.priceAmountCents,
      buyerEmail: buyer.email,
      buyerUserId: userId,
      sellerUserId: listing.authorId,
      sellerConnectAccountId: seller.stripeConnectAccountId,
      successUrl,
      cancelUrl,
    });

    return { url, transactionId };
  });

  // POST /connect/onboard — start Stripe Connect onboarding for a seller
  app.post('/connect/onboard', async (request, reply) => {
    const userId = request.user.id;
    const { returnUrl, refreshUrl } = request.body as { returnUrl: string; refreshUrl: string };

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) { reply.code(404); return { error: 'User not found' }; }

    let accountId = user.stripeConnectAccountId;
    if (!accountId) {
      accountId = await createConnectAccount(user.email, userId);
    }

    const url = await createConnectAccountLink(accountId, returnUrl, refreshUrl);
    return { url, accountId };
  });

  // GET /connect/status — check Stripe Connect onboarding status
  app.get('/connect/status', async (request, reply) => {
    const userId = request.user.id;
    const [user] = await db.select({ stripeConnectAccountId: users.stripeConnectAccountId }).from(users).where(eq(users.id, userId));
    if (!user?.stripeConnectAccountId) {
      return { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    }

    const status = await getConnectAccountStatus(user.stripeConnectAccountId);
    return { connected: true, ...status };
  });

  // GET /seller/transactions — seller's transaction history and earnings
  app.get('/seller/transactions', async (request) => {
    const userId = request.user.id;
    const rows = await db
      .select({
        id: marketplaceTransactions.id,
        listingId: marketplaceTransactions.listingId,
        listingTitle: marketplaceListings.title,
        amountCents: marketplaceTransactions.amountCents,
        platformFeeCents: marketplaceTransactions.platformFeeCents,
        status: marketplaceTransactions.status,
        createdAt: marketplaceTransactions.createdAt,
      })
      .from(marketplaceTransactions)
      .innerJoin(marketplaceListings, eq(marketplaceTransactions.listingId, marketplaceListings.id))
      .where(eq(marketplaceTransactions.sellerId, userId))
      .orderBy(desc(marketplaceTransactions.createdAt));

    const totalEarningsCents = rows
      .filter(r => r.status === 'completed')
      .reduce((sum, r) => sum + (r.amountCents - r.platformFeeCents), 0);

    return { transactions: rows, totalEarningsCents };
  });
};
