import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, lt, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notifications, notificationPreferences } from '../db/schema.js';

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  // GET / — list notifications for authenticated user
  app.get('/', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const query = request.query as {
      read?: string;
      event_type?: string;
      limit?: string;
      cursor?: string;
    };

    const limit = Math.min(Math.max(parseInt(query.limit ?? '20', 10) || 20, 1), 50);
    const cursor = query.cursor ? new Date(query.cursor) : null;

    // Build conditions
    const conditions = [eq(notifications.userId, userId)];

    if (query.read === 'true') {
      conditions.push(isNotNull(notifications.readAt));
    } else if (query.read === 'false') {
      conditions.push(isNull(notifications.readAt));
    }

    if (query.event_type) {
      conditions.push(eq(notifications.eventType, query.event_type));
    }

    if (cursor) {
      conditions.push(lt(notifications.createdAt, cursor));
    }

    const items = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit + 1);

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      nextCursor = items[items.length - 1].createdAt.toISOString();
    }

    // Get unread count
    const [unreadResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

    return {
      items,
      nextCursor,
      unreadCount: unreadResult?.count ?? 0,
    };
  });

  // GET /unread-count — badge polling
  app.get('/unread-count', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

    return { count: result?.count ?? 0 };
  });

  // PATCH /:id/read — mark single notification as read
  app.patch('/:id/read', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { id } = request.params as { id: string };

    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning();

    if (!updated) {
      reply.code(404);
      return { error: 'Notification not found' };
    }

    return updated;
  });

  // PATCH /read-all — mark all user's notifications as read
  app.patch('/read-all', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

    return { success: true };
  });

  // DELETE /:id — delete a single notification
  app.delete('/:id', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { id } = request.params as { id: string };

    const [deleted] = await db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning();

    if (!deleted) {
      reply.code(404);
      return { error: 'Notification not found' };
    }

    return { success: true };
  });

  // GET /preferences — get all notification preferences for user
  app.get('/preferences', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const prefs = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));

    return prefs;
  });

  // PUT /preferences — bulk replace all preferences
  app.put('/preferences', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const body = request.body as Array<{
      eventType: string;
      inApp: boolean;
      emailEnabled: boolean;
      emailMode: 'instant' | 'daily' | 'weekly' | 'off';
    }>;

    if (!Array.isArray(body)) {
      reply.code(400);
      return { error: 'Body must be an array of preferences' };
    }

    // Delete existing preferences and insert new ones
    await db
      .delete(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));

    if (body.length > 0) {
      const rows = body.map((p) => ({
        userId,
        eventType: p.eventType,
        inApp: p.inApp,
        emailEnabled: p.emailEnabled,
        emailMode: p.emailMode,
      }));

      await db.insert(notificationPreferences).values(rows);
    }

    // Return updated preferences
    const prefs = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));

    return prefs;
  });

  // PATCH /preferences/:event_type — update single event type preference
  app.patch('/preferences/:event_type', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { event_type } = request.params as { event_type: string };
    const body = request.body as Partial<{
      inApp: boolean;
      emailEnabled: boolean;
      emailMode: 'instant' | 'daily' | 'weekly' | 'off';
    }>;

    // Try to update existing
    const [existing] = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.eventType, event_type),
        ),
      );

    if (existing) {
      const [updated] = await db
        .update(notificationPreferences)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(notificationPreferences.id, existing.id))
        .returning();

      return updated;
    }

    // Create new preference
    const [created] = await db
      .insert(notificationPreferences)
      .values({
        userId,
        eventType: event_type,
        inApp: body.inApp ?? true,
        emailEnabled: body.emailEnabled ?? true,
        emailMode: body.emailMode ?? 'daily',
      })
      .returning();

    return created;
  });
};
