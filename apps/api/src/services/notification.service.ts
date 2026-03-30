import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notifications, notificationPreferences, slackConnections } from '../db/schema.js';
import { slackService } from './slack.service.js';

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

    // Fire-and-forget: deliver to Slack if the team has a connection
    this.deliverToSlack(input).catch(() => {
      // Best-effort — don't fail the notification creation
    });

    return notification;
  }

  /**
   * Attempt to deliver a notification to Slack if the team has an active
   * Slack connection with monitored channels configured.
   */
  private async deliverToSlack(input: CreateNotificationInput): Promise<void> {
    const connections = await db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.teamId, input.teamId));

    if (connections.length === 0) {
      return;
    }

    const connection = connections[0];
    const channels = (connection.monitoredChannels as string[]) ?? [];

    // Send to the first monitored channel (primary notification channel)
    if (channels.length === 0) {
      return;
    }

    const slackText = `*${input.title}*${input.body ? `\n${input.body}` : ''}`;
    await slackService.sendSlackChannelMessage(input.teamId, channels[0], slackText);
  }
}

export const notificationService = new NotificationService();
