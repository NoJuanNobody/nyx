import { z } from 'zod';

// ── Event Types ────────────────────────────────────────────────────

export const NotificationEventType = z.enum([
  'drift.detected',
  'ticket.created',
  'ticket.updated',
  'change_proposal.submitted',
  'change_proposal.approved',
  'change_proposal.rejected',
  'approval.requested',
  'document.shared',
  'team.invite',
  'snapshot.created',
  'comment.mention',
]);
export type NotificationEventType = z.infer<typeof NotificationEventType>;

export const NotificationEmailMode = z.enum(['instant', 'daily', 'weekly', 'off']);
export type NotificationEmailMode = z.infer<typeof NotificationEmailMode>;

export const EmailDeliveryStatus = z.enum(['queued', 'sent', 'failed', 'bounced']);
export type EmailDeliveryStatus = z.infer<typeof EmailDeliveryStatus>;

// ── Schemas ────────────────────────────────────────────────────────

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  eventType: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  entityId: z.string().nullable().optional(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationPreferenceSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  eventType: z.string(),
  inApp: z.boolean(),
  emailEnabled: z.boolean(),
  emailMode: NotificationEmailMode,
  updatedAt: z.string().datetime().optional(),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const UnreadCountResponseSchema = z.object({
  count: z.number(),
});
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;
