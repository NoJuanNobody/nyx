import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, boolean, uniqueIndex } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'developer', 'editor', 'viewer']);
export const documentStatusEnum = pgEnum('document_status', ['draft', 'published', 'archived']);
export const ticketProviderEnum = pgEnum('ticket_provider', ['github', 'jira']);
export const ticketStatusEnum = pgEnum('ticket_status', ['open', 'in_progress', 'closed']);
export const integrationTypeEnum = pgEnum('integration_type', ['github', 'jira', 'confluence']);
export const proposalStatusEnum = pgEnum('proposal_status', ['pending', 'approved', 'rejected', 'pushed']);
export const auditEventTypeEnum = pgEnum('audit_event_type', [
  'doc_edit', 'snapshot_created', 'ticket_created', 'ticket_updated',
  'code_commit', 'proposal_created', 'proposal_approved', 'proposal_pushed',
  'agent_workflow',
]);
export const agentSessionStatusEnum = pgEnum('agent_session_status', ['running', 'completed', 'failed', 'cancelled']);
export const documentStageEnum = pgEnum('document_stage', [
  'conception', 'definition', 'architecture', 'implementation', 'execution',
]);

// ── Users ──────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').unique(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Teams ──────────────────────────────────────────────

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: userRoleEnum('role').notNull().default('viewer'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Team Invitations ──────────────────────────────────

export const invitationStatusEnum = pgEnum('invitation_status', ['pending', 'accepted', 'expired']);

export const teamInvitations = pgTable('team_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  email: text('email').notNull(),
  role: userRoleEnum('role').notNull().default('viewer'),
  invitedById: uuid('invited_by_id')
    .notNull()
    .references(() => users.id),
  status: invitationStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ── Waitlist Signups ──────────────────────────────────

export const waitlistSignups = pgTable('waitlist_signups', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Documents ──────────────────────────────────────────

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  path: text('path').notNull().default('/'),
  status: documentStatusEnum('status').notNull().default('draft'),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id),
  stage: documentStageEnum('stage'),  // nullable — existing docs unaffected
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentTemplates = pgTable('document_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  stage: documentStageEnum('stage').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  content: text('content').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  teamId: uuid('team_id').references(() => teams.id),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('document_templates_stage_name_team_idx').on(table.stage, table.name, table.teamId),
]);

export const documentVersions = pgTable('document_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  message: text('message'),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentBranches = pgTable('document_branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  name: text('name').notNull(),
  baseVersionId: uuid('base_version_id')
    .notNull()
    .references(() => documentVersions.id),
  content: text('content').notNull(),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id),
  status: text('status').notNull().default('draft'),
  reviewedById: uuid('reviewed_by_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
});

// ── Integrations ───────────────────────────────────────

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  type: integrationTypeEnum('type').notNull(),
  config: jsonb('config').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Snapshots (code state captures) ────────────────────

export const snapshots = pgTable('snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  integrationId: uuid('integration_id')
    .references(() => integrations.id),
  externalRef: text('external_ref').notNull(),
  content: text('content').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Tickets ────────────────────────────────────────────

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  provider: ticketProviderEnum('provider').notNull(),
  externalId: text('external_id').notNull(),
  externalUrl: text('external_url').notNull(),
  title: text('title').notNull(),
  status: ticketStatusEnum('status').notNull().default('open'),
  claudeInsights: jsonb('claude_insights'),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Timeline Events ────────────────────────────────────

export const timelineEvents = pgTable('timeline_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  actorId: uuid('actor_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Change Proposals ──────────────────────────────────

export const changeProposals = pgTable('change_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: proposalStatusEnum('status').notNull().default('pending'),
  suggestedTickets: jsonb('suggested_tickets').notNull().default([]),
  sourceVersions: jsonb('source_versions').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Audit Trail ───────────────────────────────────────

export const auditTrail = pgTable('audit_trail', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  eventType: auditEventTypeEnum('event_type').notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  documentId: uuid('document_id').references(() => documents.id),
  snapshotId: uuid('snapshot_id').references(() => snapshots.id),
  ticketId: uuid('ticket_id').references(() => tickets.id),
  commitSha: text('commit_sha'),
  parentEventId: uuid('parent_event_id'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Agent Sessions ────────────────────────────────────

export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  documentId: uuid('document_id').references(() => documents.id),
  status: agentSessionStatusEnum('status').notNull().default('running'),
  prompt: text('prompt').notNull(),
  result: text('result'),
  toolCallCount: integer('tool_call_count').notNull().default(0),
  tokenUsage: jsonb('token_usage').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentToolCalls = pgTable('agent_tool_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => agentSessions.id),
  toolName: text('tool_name').notNull(),
  input: jsonb('input').notNull().default({}),
  output: jsonb('output').notNull().default({}),
  durationMs: integer('duration_ms').notNull().default(0),
  error: text('error'),
  sequence: integer('sequence').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── API Keys ──────────────────────────────────────────

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: jsonb('scopes').notNull().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Ticket Suggestions ────────────────────────────────

export const ticketSuggestions = pgTable('ticket_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  title: text('title').notNull(),
  description: text('description').notNull(),
  labels: jsonb('labels').notNull().default([]),
  status: text('status').notNull().default('pending'),
  reviewedById: uuid('reviewed_by_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Intake Sessions ─────────────────────────────────

export const intakeSessions = pgTable('intake_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  createdById: uuid('created_by_id')
    .notNull()
    .references(() => users.id),
  rawInput: text('raw_input').notNull(),
  structuredOutput: jsonb('structured_output'),
  status: text('status').notNull().default('pending'),
  documentId: uuid('document_id').references(() => documents.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Slack Connections ─────────────────────────────────

export const slackConnections = pgTable('slack_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  slackTeamId: text('slack_team_id').notNull(),
  slackBotToken: text('slack_bot_token').notNull(),
  triggerEmoji: text('trigger_emoji').default('nyx'),
  monitoredChannels: jsonb('monitored_channels').default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Feedback Submissions ─────────────────────────────

export const feedbackSubmissions = pgTable('feedback_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  rawMessage: text('raw_message').notNull(),
  formattedTitle: text('formatted_title').notNull(),
  formattedBody: text('formatted_body').notNull(),
  category: text('category').notNull(),
  githubIssueUrl: text('github_issue_url'),
  githubIssueNumber: integer('github_issue_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
