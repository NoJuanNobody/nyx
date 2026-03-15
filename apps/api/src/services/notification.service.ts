import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notifications, notificationPreferences } from '../db/schema.js';

export interface CreateNotificationInput {
  userId: string;
  teamId: string;
  eventType: string;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  entityId?: string;
}

const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

class NotificationService {
  /**
   * Create a notification for a user.
   * - Respects inApp preference (skips if false)
   * - Deduplicates by entityId within a 10-minute window
   */
  async create(input: CreateNotificationInput) {
    // Check user preference for this event type
    const [pref] = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, input.userId),
          eq(notificationPreferences.eventType, input.eventType),
        ),
      );

    // If preference exists and inApp is false, skip
    if (pref && !pref.inApp) {
      return null;
    }

    // Deduplication: check for existing unread notification with same entityId
    if (input.entityId) {
      const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS);

      const [existing] = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, input.userId),
            eq(notifications.eventType, input.eventType),
            eq(notifications.entityId, input.entityId),
            isNull(notifications.readAt),
            gt(notifications.createdAt, windowStart),
          ),
        );

      if (existing) {
        // Update existing notification instead of inserting
        const [updated] = await db
          .update(notifications)
          .set({
            body: input.body ?? existing.body,
            metadata: input.metadata ?? existing.metadata,
            createdAt: new Date(),
          })
          .where(eq(notifications.id, existing.id))
          .returning();

        return updated;
      }
    }

    // Insert new notification
    const [notification] = await db
      .insert(notifications)
      .values({
        userId: input.userId,
        teamId: input.teamId,
        eventType: input.eventType,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? null,
        entityId: input.entityId ?? null,
      })
      .returning();

    return notification;
  }
}

export const notificationService = new NotificationService();
