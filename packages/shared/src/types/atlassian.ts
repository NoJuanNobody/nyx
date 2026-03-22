import { z } from 'zod';

// ── Connection Status ────────────────────────────────────────────

export const AtlassianConnectionStatus = z.enum([
  'connected',
  'token_expired',
  'disconnected',
  'error',
]);
export type AtlassianConnectionStatus = z.infer<typeof AtlassianConnectionStatus>;

// ── Jira Types ───────────────────────────────────────────────────

export const JiraIssueType = z.enum(['Task', 'Story', 'Bug', 'Epic']);
export type JiraIssueType = z.infer<typeof JiraIssueType>;

export const JiraStatusCategory = z.enum(['To Do', 'In Progress', 'Done']);
export type JiraStatusCategory = z.infer<typeof JiraStatusCategory>;

export const NyxTicketStatus = z.enum(['pending', 'in_progress', 'completed']);
export type NyxTicketStatus = z.infer<typeof NyxTicketStatus>;

export const JiraProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  self: z.string(),
});
export type JiraProject = z.infer<typeof JiraProjectSchema>;

export const JiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string(),
  fields: z.object({
    summary: z.string(),
    status: z.object({ name: z.string(), statusCategory: z.object({ name: z.string() }).optional() }),
    issuetype: z.object({ name: z.string() }),
  }),
});
export type JiraIssue = z.infer<typeof JiraIssueSchema>;

export const CreateJiraIssuePayload = z.object({
  projectKey: z.string(),
  summary: z.string().max(255),
  description: z.string(),
  issueType: JiraIssueType.optional().default('Task'),
  labels: z.array(z.string()).optional(),
  specUrl: z.string().url().optional(),
  priority: z.string().optional(),
  assigneeAccountId: z.string().optional(),
});
export type CreateJiraIssuePayload = z.infer<typeof CreateJiraIssuePayload>;

// ── Confluence Types ─────────────────────────────────────────────

export const ConfluenceSpaceSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
});
export type ConfluenceSpace = z.infer<typeof ConfluenceSpaceSchema>;

export const ConfluencePageSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  spaceId: z.string(),
  version: z.object({ number: z.number() }).optional(),
});
export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;

export const ExportToConfluencePayload = z.object({
  spaceId: z.string(),
  title: z.string(),
  content: z.string(),
  parentPageId: z.string().optional(),
  existingPageId: z.string().optional(),
});
export type ExportToConfluencePayload = z.infer<typeof ExportToConfluencePayload>;

export const ImportFromConfluencePayload = z.object({
  pageId: z.string(),
});
export type ImportFromConfluencePayload = z.infer<typeof ImportFromConfluencePayload>;

// ── Connection Schema ────────────────────────────────────────────

export const AtlassianConnectionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  organizationId: z.string().uuid().nullable(),
  status: AtlassianConnectionStatus,
  cloudId: z.string(),
  siteUrl: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AtlassianConnection = z.infer<typeof AtlassianConnectionSchema>;

// ── Sync Preferences ─────────────────────────────────────────────

export const AtlassianSyncPreferences = z.object({
  autoExportOnPublish: z.boolean().default(false),
  jiraStatusSync: z.enum(['webhooks', 'polling', 'disabled']).default('webhooks'),
  pollingIntervalMinutes: z.enum(['5', '15', '30', '60']).default('15'),
  confluenceChangeDetection: z.boolean().default(true),
  defaultJiraProjectKey: z.string().optional(),
  defaultConfluenceSpaceId: z.string().optional(),
});
export type AtlassianSyncPreferences = z.infer<typeof AtlassianSyncPreferences>;

// ── Jira Status Map ──────────────────────────────────────────────

export const JIRA_STATUS_TO_NYX: Record<string, NyxTicketStatus> = {
  'To Do': 'pending',
  'In Progress': 'in_progress',
  'Done': 'completed',
};

// ── Webhook Payload ──────────────────────────────────────────────

export const JiraWebhookPayload = z.object({
  webhookEvent: z.string(),
  issue: z.object({
    id: z.string(),
    key: z.string(),
    fields: z.object({
      summary: z.string(),
      status: z.object({
        name: z.string(),
        statusCategory: z.object({ name: z.string() }).optional(),
      }),
    }),
  }).optional(),
});
export type JiraWebhookPayload = z.infer<typeof JiraWebhookPayload>;
