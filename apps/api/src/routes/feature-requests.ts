import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, sql, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { featureRequests, featureRequestUpvotes, featureRequestComments, users } from '../db/schema.js';

export const featureRequestRoutes: FastifyPluginAsync = async (app) => {
  // GET / — list feature requests sorted by upvotes
  app.get('/', async (request) => {
    const { status, sort = 'upvotes' } = request.query as { status?: string; sort?: string };
    let rows = await db.select().from(featureRequests).orderBy(sort === 'newest' ? desc(featureRequests.createdAt) : desc(featureRequests.upvoteCount));
    if (status) rows = rows.filter(r => r.status === status);
    return rows;
  });

  // GET /:id — single request with comments
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [fr] = await db.select().from(featureRequests).where(eq(featureRequests.id, id));
    if (!fr) { reply.code(404); return { error: 'Feature request not found' }; }
    const comments = await db.select({ id: featureRequestComments.id, content: featureRequestComments.content, userId: featureRequestComments.userId, createdAt: featureRequestComments.createdAt }).from(featureRequestComments).where(eq(featureRequestComments.featureRequestId, id)).orderBy(desc(featureRequestComments.createdAt));
    // Check if current user upvoted
    const userId = request.user?.id;
    let userUpvoted = false;
    if (userId) {
      const [vote] = await db.select().from(featureRequestUpvotes).where(and(eq(featureRequestUpvotes.featureRequestId, id), eq(featureRequestUpvotes.userId, userId))).limit(1);
      userUpvoted = !!vote;
    }
    return { ...fr, comments, userUpvoted };
  });

  // POST / — submit feature request
  app.post('/', async (request) => {
    const userId = request.user.id;
    const { title, description } = request.body as { title: string; description: string };
    const [fr] = await db.insert(featureRequests).values({ title, description, authorId: userId }).returning();
    return fr;
  });

  // POST /:id/upvote — toggle upvote
  app.post('/:id/upvote', async (request) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    const [existing] = await db.select().from(featureRequestUpvotes).where(and(eq(featureRequestUpvotes.featureRequestId, id), eq(featureRequestUpvotes.userId, userId))).limit(1);
    if (existing) {
      await db.delete(featureRequestUpvotes).where(eq(featureRequestUpvotes.id, existing.id));
      await db.update(featureRequests).set({ upvoteCount: sql`${featureRequests.upvoteCount} - 1` }).where(eq(featureRequests.id, id));
      return { upvoted: false };
    } else {
      await db.insert(featureRequestUpvotes).values({ featureRequestId: id, userId });
      await db.update(featureRequests).set({ upvoteCount: sql`${featureRequests.upvoteCount} + 1` }).where(eq(featureRequests.id, id));
      return { upvoted: true };
    }
  });

  // POST /:id/comments — add comment
  app.post('/:id/comments', async (request) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    const { content } = request.body as { content: string };
    const [comment] = await db.insert(featureRequestComments).values({ featureRequestId: id, userId, content }).returning();
    return comment;
  });
};
