import { z } from 'zod';

export const IntegrationType = z.enum(['github', 'jira', 'confluence']);
export type IntegrationType = z.infer<typeof IntegrationType>;

export const IntegrationSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  type: IntegrationType,
  config: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Integration = z.infer<typeof IntegrationSchema>;

export const SnapshotSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  integrationId: z.string().uuid(),
  externalRef: z.string(),
  content: z.string(),
  capturedAt: z.string().datetime(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export const TimelineEventSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  type: z.string(),
  payload: z.record(z.unknown()),
  actorId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
