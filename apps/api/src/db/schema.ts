import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, boolean, uniqueIndex, index, vector } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'developer', 'editor', 'viewer']);
export const documentStatusEnum = pgEnum('document_status', ['draft', 'published', 'archived']);
export const ticketProviderEnum = pgEnum('ticket_provider', ['github', 'jira']);
export const ticketStatusEnum = pgEnum('ticket_status', ['open', 'in_progress', 'closed']);
export const integrationTypeEnum = pgEnum('integration_type', ['github', 'gitlab', 'bitbucket', 'jira', 'confluence']);
export const proposalStatusEnum = pgEnum('proposal_status', ['pending', 'approved', 'rejected', 'pushed']);
export const auditEventTypeEnum = pgEnum('audit_event_type', [
  'doc_edit', 'snapshot_created', 'ticket_created', 'ticket_updated',
  'code_commit', 'proposal_created', 'proposal_approved', 'proposal_pushed',
  'agent_workflow',
]);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'expired']);
export const agentSessionStatusEnum = pgEnum('agent_session_status', ['running', 'completed', 'failed', 'cancelled']);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'running', 'completed', 'failed']);
export const notificationEmailModeEnum = pgEnum('notification_email_mode', ['instant', 'daily', 'weekly', 'off']);
export const emailDeliveryStatusEnum = pgEnum('email_delivery_status', ['queued', 'sent', 'failed', 'bounced']);
export const documentStageEnum = pgEnum('document_stage', [
  'conception', 'definition', 'architecture', 'implementation', 'execution',
]);

// ── Lifecycles ───────────────────────────────────────────

export const lifecycles = pgTable('lifecycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default(''),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const lifecycleStages = pgTable('lifecycle_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  lifecycleId: uuid('lifecycle_id')
    .notNull()
    .references(() => lifecycles.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  label: text('label').notNull(),
  abbreviation: text('abbreviation').notNull().default(''),
  subtitle: text('subtitle').notNull().default(''),
  color: text('color').notNull().default(''),
  textColor: text('text_color').notNull().default(''),
  dotColor: text('dot_color').notNull().default(''),
  borderColor: text('border_color').notNull().default(''),
  hex: text('hex').notNull().default('#888888'),
  who: text('who').notNull().default(''),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default(''),
  ai: text('ai').notNull().default(''),
  output: text('output').notNull().default(''),
  docs: jsonb('docs').$type<string[]>().notNull().default([]),
}, (table) => [
  uniqueIndex('lifecycle_stages_lifecycle_slug_idx').on(table.lifecycleId, table.slug),
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
  token: text('token').notNull().unique(),
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
  stage: text('stage'),  // nullable text — was enum, now supports any lifecycle stage
  lifecycleId: uuid('lifecycle_id').references(() => lifecycles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const meetingDocuments = pgTable('meeting_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  meetingSessionId: text('meeting_session_id').notNull(),
  platform: text('platform').notNull(),
  meetingIntelligence: jsonb('meeting_intelligence').notNull(),
  duration: integer('duration'),
  participants: jsonb('participants').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentTemplates = pgTable('document_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  stage: text('stage').notNull(),  // was enum, now text to support any lifecycle stage
  name: text('name').notNull(),
  description: text('description').notNull(),
  content: text('content').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  teamId: uuid('team_id').references(() => teams.id),
  createdById: uuid('created_by_id').references(() => users.id),
  lifecycleId: uuid('lifecycle_id').references(() => lifecycles.id),
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
  conversationId: uuid('conversation_id'),  // groups sessions in one logical conversation
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

// ── Notifications ─────────────────────────────────────

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  metadata: jsonb('metadata'),
  entityId: text('entity_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  inApp: boolean('in_app').notNull().default(true),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  emailMode: notificationEmailModeEnum('email_mode').notNull().default('daily'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userEventUniq: uniqueIndex('notif_pref_user_event_uniq').on(t.userId, t.eventType),
}));

export const emailDeliveryLog = pgTable('email_delivery_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  notificationId: uuid('notification_id').references(() => notifications.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id'),
  status: emailDeliveryStatusEnum('status').notNull().default('queued'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
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

// ── Subscriptions ─────────────────────────────────────

export const subscriptionPlanEnum = pgEnum('subscription_plan', ['free', 'pro', 'team', 'enterprise']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'past_due', 'canceled', 'trialing', 'incomplete']);

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  plan: subscriptionPlanEnum('plan').notNull().default('free'),
  status: subscriptionStatusEnum('status').notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePriceId: text('stripe_price_id'),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Stripe Customers ─────────────────────────────────

export const stripeCustomers = pgTable('stripe_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  subscriptionId: text('subscription_id'),
  plan: text('plan').notNull().default('free'),
  planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Community Marketplace ─────────────────────────────

// ── Deliverables ──────────────────────────────────────

export const deliverableTypeEnum = pgEnum('deliverable_type', ['pdf', 'markdown', 'report', 'jupyter']);

export const deliverables = pgTable('deliverables', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  type: deliverableTypeEnum('type').notNull(),
  fileName: text('file_name').notNull(),
  fileUrl: text('file_url').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

export const listingTypeEnum = pgEnum('listing_type', ['template', 'workflow', 'prompt']);
export const listingPriceTypeEnum = pgEnum('listing_price_type', ['free', 'paid']);
export const featureRequestStatusEnum = pgEnum('feature_request_status', ['submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined']);

export const marketplaceListings = pgTable('marketplace_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: listingTypeEnum('type').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  content: text('content').notNull(),
  priceType: listingPriceTypeEnum('price_type').notNull().default('free'),
  priceAmountCents: integer('price_amount_cents'),
  creditPrice: integer('credit_price'),
  category: text('category'),
  tags: jsonb('tags').notNull().default([]),
  stage: text('stage'),
  downloadCount: integer('download_count').notNull().default(0),
  authorId: uuid('author_id').notNull().references(() => users.id),
  teamId: uuid('team_id').references(() => teams.id),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceReviews = pgTable('marketplace_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => marketplaceListings.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const featureRequests = pgTable('feature_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: featureRequestStatusEnum('status').notNull().default('submitted'),
  authorId: uuid('author_id').notNull().references(() => users.id),
  upvoteCount: integer('upvote_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const featureRequestUpvotes = pgTable('feature_request_upvotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureRequestId: uuid('feature_request_id').notNull().references(() => featureRequests.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('fr_upvote_user_request_idx').on(t.featureRequestId, t.userId),
]);

export const featureRequestComments = pgTable('feature_request_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureRequestId: uuid('feature_request_id').notNull().references(() => featureRequests.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectShowcases = pgTable('project_showcases', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  techStack: jsonb('tech_stack').notNull().default([]),
  teamSize: integer('team_size'),
  nuxFeatures: jsonb('nyx_features').notNull().default([]),
  url: text('url'),
  imageUrl: text('image_url'),
  authorId: uuid('author_id').notNull().references(() => users.id),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Social Posts ──────────────────────────────────────

export const socialPosts = pgTable('social_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  content: text('content').notNull(),
  postUrl: text('post_url'),
  status: text('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Generated Videos ──────────────────────────────────

export const videoStatusEnum = pgEnum('video_status', ['pending', 'generating', 'completed', 'failed']);

export const generatedVideos = pgTable('generated_videos', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  status: videoStatusEnum('status').notNull().default('generating'),
  videoUrl: text('video_url'),
  thumbnailUrl: text('thumbnail_url'),
  duration: integer('duration').notNull().default(5),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Team AI Keys (BYOK) ──────────────────────────────

export const teamAiKeys = pgTable('team_ai_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('anthropic'),
  encryptedKey: text('encrypted_key').notNull(),
  keyIv: text('key_iv').notNull(),
  keySuffix: text('key_suffix').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
}, (table) => [
  uniqueIndex('team_ai_keys_team_provider_idx').on(table.teamId, table.provider),
]);

// ── AI Usage Log ─────────────────────────────────────

export const aiUsageLog = pgTable('ai_usage_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  operation: text('operation').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  keySource: text('key_source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Credit Ledger ─────────────────────────────────────

export const creditTransactionTypeEnum = pgEnum('credit_transaction_type', [
  'purchase',
  'consumption',
  'refund',
]);

export const creditBalances = pgTable('credit_balances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(),
  balance: integer('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  amount: integer('amount').notNull(),
  type: creditTransactionTypeEnum('type').notNull(),
  description: text('description').notNull(),
  taskType: text('task_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── User Pipeline Access ──────────────────────────────────────

export const userPipelineAccess = pgTable('user_pipeline_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  teamId: uuid('team_id').references(() => teams.id),
  pipelineId: text('pipeline_id').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
  creditsPaid: integer('credits_paid').notNull().default(0),
}, (table) => [
  uniqueIndex('user_pipeline_access_user_pipeline_idx').on(table.userId, table.pipelineId),
]);

// ── Atlassian Connections ─────────────────────────────────────

export const atlassianConnectionStatusEnum = pgEnum('atlassian_connection_status', [
  'connected',
  'token_expired',
  'disconnected',
  'error',
]);

export const atlassianConnections = pgTable('atlassian_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id').references(() => teams.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }).notNull(),
  cloudId: text('cloud_id').notNull(),
  siteUrl: text('site_url').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  status: atlassianConnectionStatusEnum('status').notNull().default('connected'),
  webhookId: text('webhook_id'),
  preferences: jsonb('preferences').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── PKCE Challenges (DB-backed PKCE store for Atlassian OAuth) ───

export const pkceChallenges = pgTable('pkce_challenges', {
  state: text('state').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  userId: text('user_id').notNull(),
  teamId: text('team_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Background Jobs ───────────────────────────────────

export const backgroundJobs = pgTable('background_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .references(() => teams.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  type: text('type').notNull(),
  status: jobStatusEnum('status').notNull().default('pending'),
  input: jsonb('input').notNull().default({}),
  result: jsonb('result'),
  error: text('error'),
  progress: integer('progress').notNull().default(0),
  progressMessage: text('progress_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Approvals ────────────────────────────────────────────

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  action: text('action').notNull(),
  resourceId: text('resource_id').notNull(),
  requestedById: uuid('requested_by_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reviewedById: uuid('reviewed_by_id')
    .references(() => users.id, { onDelete: 'set null' }),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  status: approvalStatusEnum('status').notNull().default('pending'),
  metadata: jsonb('metadata').notNull().default({}),
  reason: text('reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Document Chunks (pgvector) ──────────────────────────

export const docChunks = pgTable('doc_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  docId: uuid('doc_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  version: integer('version').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('doc_chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  index('doc_chunks_doc_version_idx').on(table.docId, table.version),
]);
