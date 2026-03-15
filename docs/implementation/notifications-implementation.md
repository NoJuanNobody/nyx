# Notifications System — Implementation Execution Plan

This document provides a sequenced, task-level plan for building the notifications system defined in [`docs/features/notifications.md`](../features/notifications.md). Work is broken into phases so the in-app center ships first and email/real-time layers follow.

---

## Phase 0: Prerequisites

Before writing any notification code, verify these are in place:

- [ ] `users` and `workspaces` tables exist with UUID primary keys
- [ ] Clerk auth middleware is wired into all API routes
- [ ] Drizzle ORM is configured and migrations/push workflow is established
- [ ] A test user and workspace exist in seed data

---

## Phase 1: Database Schema

**Goal:** Create the three notifications tables and expose them via Drizzle schema.

### 1.1 Write Drizzle Schema Definitions

File: `packages/db/src/schema/notifications.ts`

```ts
import { pgTable, uuid, text, boolean, jsonb, timestamptz, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users';
import { workspaces } from './workspaces';

export const notifications = pgTable('notifications', {
  id:          uuid('id').primaryKey().defaultRandom(),
  userId:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  eventType:   text('event_type').notNull(),
  title:       text('title').notNull(),
  body:        text('body'),
  metadata:    jsonb('metadata'),
  readAt:      timestamptz('read_at'),
  createdAt:   timestamptz('created_at').notNull().defaultNow(),
}, (t) => ({
  userUnreadIdx: index('idx_notifications_user_unread')
    .on(t.userId, t.createdAt)
    .where(sql`${t.readAt} IS NULL`),
}));

export const notificationPreferences = pgTable('notification_preferences', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType:    text('event_type').notNull(),
  inApp:        boolean('in_app').notNull().default(true),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  emailMode:    text('email_mode').notNull().default('daily'),  // instant | daily | weekly | off
  updatedAt:    timestamptz('updated_at').notNull().defaultNow(),
}, (t) => ({
  userEventUniq: unique().on(t.userId, t.eventType),
}));

export const emailDeliveryLog = pgTable('email_delivery_log', {
  id:             uuid('id').primaryKey().defaultRandom(),
  notificationId: uuid('notification_id').references(() => notifications.id),
  userId:         uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId:     text('provider_id'),
  status:         text('status').notNull(), // queued | sent | failed | bounced
  sentAt:         timestamptz('sent_at'),
  error:          text('error'),
  createdAt:      timestamptz('created_at').notNull().defaultNow(),
});
```

### 1.2 Push Schema to Database

```bash
pnpm --filter @nyx/api exec drizzle-kit push --force
```

### 1.3 Acceptance Criteria

- All three tables exist in the database with correct columns and constraints
- Unique index on `(user_id, event_type)` in `notification_preferences` prevents duplicates
- Partial index on `notifications` covers unread-count queries efficiently

---

## Phase 2: Core Notification Service

**Goal:** A single service that creates notifications with deduplication and grouping logic.

### 2.1 Create the Notification Service

File: `apps/api/src/notifications/notification.service.ts`

```ts
export interface CreateNotificationInput {
  userId: string;
  workspaceId: string;
  eventType: string;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  entityId?: string;  // used for grouping/deduplication
}

const GROUPING_WINDOW_MINUTES = 10;

export class NotificationService {
  async create(input: CreateNotificationInput): Promise<void> {
    // 1. Check preferences — skip if inApp is disabled
    const pref = await this.getPreference(input.userId, input.eventType);
    if (pref && !pref.inApp) return;

    // 2. Deduplication: look for an existing unread notification in the grouping window
    if (input.entityId) {
      const existing = await this.findGroupable(input.userId, input.eventType, input.entityId);
      if (existing) {
        await db.update(notifications)
          .set({ body: input.body, metadata: input.metadata, createdAt: new Date() })
          .where(eq(notifications.id, existing.id));
        return;
      }
    }

    // 3. Insert new notification
    await db.insert(notifications).values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      eventType: input.eventType,
      title: input.title,
      body: input.body,
      metadata: input.metadata,
    });

    // 4. Queue email if applicable (async, non-blocking)
    this.queueEmail(input).catch(console.error);
  }

  // ... getPreference, findGroupable, queueEmail methods
}
```

### 2.2 Register Service in Fastify Plugin

File: `apps/api/src/notifications/notifications.plugin.ts`

Decorate the Fastify instance with `fastify.notifications` so routes and other plugins can call `fastify.notifications.create(...)`.

### 2.3 Unit Tests

File: `apps/api/src/notifications/__tests__/notification.service.test.ts`

Test cases:
- Creates notification when inApp preference is true (default)
- Skips insert when inApp preference is false
- Updates existing notification instead of inserting when grouping window applies
- Calls queueEmail for instant-mode preferences

---

## Phase 3: REST API Routes

**Goal:** Expose all eight API endpoints defined in the feature doc.

### 3.1 Route File

File: `apps/api/src/notifications/notifications.routes.ts`

Register under prefix `/api/notifications`. All routes require Clerk auth middleware (`verifySession`).

```
GET    /                          → listNotifications(userId, filters, pagination)
GET    /unread-count              → getUnreadCount(userId)
PATCH  /:id/read                  → markRead(userId, notificationId)
PATCH  /read-all                  → markAllRead(userId)
DELETE /:id                       → deleteNotification(userId, notificationId)
GET    /preferences               → getPreferences(userId)
PUT    /preferences               → replacePreferences(userId, body)
PATCH  /preferences/:event_type   → updatePreference(userId, eventType, body)
```

### 3.2 Input Validation

Use Fastify's built-in JSON Schema validation for all request bodies. Define schemas for:
- `listNotifications` query params: `read` (boolean), `event_type` (string), `limit` (integer, max 50), `cursor` (ISO timestamp)
- `updatePreference` body: `inApp` (boolean), `emailEnabled` (boolean), `emailMode` (enum)

### 3.3 Pagination

Use cursor-based pagination on `createdAt` (ISO timestamp) to avoid offset drift as new notifications are inserted.

### 3.4 Route Unit Tests

File: `apps/api/src/notifications/__tests__/notifications.routes.test.ts`

Test each route: success paths, auth failure (401), not-found (404), validation errors (400).

---

## Phase 4: Event Integration — Hooking Into Existing Features

**Goal:** Emit notifications when domain events occur.

### 4.1 Notification Event Constants

File: `apps/api/src/notifications/events.ts`

```ts
export const NotificationEvents = {
  DRIFT_DETECTED:             'drift.detected',
  TICKET_CREATED:             'ticket.created',
  TICKET_UPDATED:             'ticket.updated',
  CHANGE_PROPOSAL_SUBMITTED:  'change_proposal.submitted',
  CHANGE_PROPOSAL_APPROVED:   'change_proposal.approved',
  CHANGE_PROPOSAL_REJECTED:   'change_proposal.rejected',
  APPROVAL_REQUESTED:         'approval.requested',
  DOCUMENT_SHARED:            'document.shared',
  TEAM_INVITE:                'team.invite',
  SNAPSHOT_CREATED:           'snapshot.created',
  COMMENT_MENTION:            'comment.mention',
} as const;
```

### 4.2 Integration Points

| Location | Event to emit |
|---|---|
| `drift.service.ts` — after drift persisted | `drift.detected` |
| `tickets.service.ts` — after ticket push to GitHub/Jira | `ticket.created` |
| GitHub webhook handler — `issues.closed` | `ticket.updated` |
| `change-proposals.service.ts` — after submit | `change_proposal.submitted` |
| `change-proposals.service.ts` — after approve/reject | `change_proposal.approved/rejected` |
| `documents.service.ts` — after `shareDocument` | `document.shared` |
| `workspaces.service.ts` — after invite sent | `team.invite` |
| `snapshots.service.ts` — after snapshot created | `snapshot.created` |

For each integration: call `fastify.notifications.create(...)` after the primary action succeeds. Do not let notification failures block the primary action — wrap calls in a try/catch or `.catch(console.error)`.

---

## Phase 5: Email Notifications

**Goal:** Send transactional emails via Resend with template rendering.

### 5.1 Install Dependencies

```bash
pnpm --filter @nyx/api add resend @react-email/components
```

### 5.2 Email Service

File: `apps/api/src/notifications/email.service.ts`

```ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export class EmailService {
  async send(to: string, subject: string, template: string, props: Record<string, unknown>) {
    const html = await renderTemplate(template, props);
    const result = await resend.emails.send({
      from: process.env.EMAIL_FROM ?? 'notifications@nyx.io',
      to,
      subject,
      html,
    });
    return result;
  }
}
```

### 5.3 Email Templates

Directory: `apps/api/src/notifications/templates/`

Each template is a React Email component. Start with:
- `drift-detected.tsx`
- `change-proposal.tsx`
- `approval-request.tsx`

Include: SyncDocs logo header, event summary, primary CTA button linking to the relevant app route, footer with unsubscribe link.

### 5.4 Digest Queue

For `daily` and `weekly` email modes, buffer notifications in the `email_delivery_log` table with `status = 'queued'` and process them on a schedule:

```bash
# Cron-style: run daily at 8 AM UTC
pnpm --filter @nyx/api run send-digest
```

The digest script:
1. Queries `email_delivery_log` for `status = 'queued'` rows grouped by user
2. Renders the digest template with all pending notifications
3. Sends via Resend
4. Updates rows to `status = 'sent'` with `sent_at`

### 5.5 Environment Variables

```env
RESEND_API_KEY=re_...
EMAIL_FROM=notifications@nyx.io
```

---

## Phase 6: Frontend — Notification Center

**Goal:** Build the bell icon, notification panel, and settings page.

### 6.1 Components

```
apps/web/src/features/notifications/
  NotificationBell.tsx         # Bell icon with badge count
  NotificationPanel.tsx        # Slide-in panel, filter tabs, list
  NotificationItem.tsx         # Single notification row (read/unread state)
  NotificationPreferences.tsx  # Settings page at /settings/notifications
```

### 6.2 API Client Hooks

File: `apps/web/src/features/notifications/useNotifications.ts`

```ts
// React Query hooks
useUnreadCount()       // polls every 30s
useNotifications()     // paginated list with infinite scroll
useMarkRead()          // mutation
useMarkAllRead()       // mutation
usePreferences()       // fetch + update mutations
```

### 6.3 Badge Polling

Use `useInterval` (or React Query's `refetchInterval`) to hit `GET /api/notifications/unread-count` every 30 seconds. On focus, refetch immediately.

### 6.4 Test IDs

Add `data-testid` attributes consistent with `e2e/fixtures/selectors.ts`:

```ts
// selectors.ts additions
notifications: {
  bell:         '[data-testid="notification-bell"]',
  badge:        '[data-testid="notification-badge"]',
  panel:        '[data-testid="notification-panel"]',
  item:         '[data-testid="notification-item"]',
  markAllRead:  '[data-testid="mark-all-read"]',
  filterAll:    '[data-testid="filter-all"]',
  filterUnread: '[data-testid="filter-unread"]',
}
```

---

## Phase 7: Real-Time Push (WebSocket) — Post-MVP

Track in issue #43. The polling fallback from Phase 6 is sufficient for MVP. When WebSocket support is added:

1. Add `ws` or `@fastify/websocket` plugin to the API
2. Maintain a `Map<userId, WebSocket>` in memory (or use Redis pub/sub for multi-instance)
3. Push a `{ type: 'notification', payload: NotificationRow }` message when `NotificationService.create` inserts a new row
4. Frontend: replace polling with `useWebSocket` hook; fall back to polling if socket disconnects

---

## Phase 8: E2E Tests

**Goal:** Write Playwright tests covering the critical flows defined in the feature doc.

### 8.1 Seed Helpers

File: `e2e/fixtures/notifications.ts`

```ts
export async function seedNotifications(db, userId, count, { read = false } = {}) {
  // Insert N notification rows with optional readAt
}

export async function clearNotifications(db, userId) {
  // Delete all notifications for test user
}
```

### 8.2 Test Files

```
e2e/notifications/
  notification-center.spec.ts
  mark-as-read.spec.ts
  notification-preferences.spec.ts
  drift-notification.spec.ts
```

Each spec uses the `authenticatedPage` fixture and calls seed helpers in `beforeEach`/`afterEach`.

---

## Sequencing Summary

| Phase | What ships | Estimated complexity |
|---|---|---|
| 0 | Prerequisites verified | Trivial |
| 1 | DB schema | Small |
| 2 | Notification service + deduplication | Medium |
| 3 | REST API routes | Medium |
| 4 | Hook into existing domain events | Medium (touches multiple files) |
| 5 | Email via Resend | Medium |
| 6 | Frontend bell + panel + preferences | Large |
| 7 | WebSocket real-time push | Large (post-MVP) |
| 8 | E2E tests | Medium |

Phases 1–4 are fully backend and can be completed before any frontend work begins. Phase 5 (email) can run in parallel with Phase 6 (frontend). Phase 7 is explicitly deferred to post-MVP.

---

## Files Created/Modified Summary

```
New files:
  packages/db/src/schema/notifications.ts
  apps/api/src/notifications/events.ts
  apps/api/src/notifications/notification.service.ts
  apps/api/src/notifications/notifications.plugin.ts
  apps/api/src/notifications/notifications.routes.ts
  apps/api/src/notifications/email.service.ts
  apps/api/src/notifications/templates/drift-detected.tsx
  apps/api/src/notifications/templates/change-proposal.tsx
  apps/api/src/notifications/templates/approval-request.tsx
  apps/api/src/notifications/templates/digest.tsx
  apps/api/src/notifications/__tests__/notification.service.test.ts
  apps/api/src/notifications/__tests__/notifications.routes.test.ts
  apps/web/src/features/notifications/NotificationBell.tsx
  apps/web/src/features/notifications/NotificationPanel.tsx
  apps/web/src/features/notifications/NotificationItem.tsx
  apps/web/src/features/notifications/NotificationPreferences.tsx
  apps/web/src/features/notifications/useNotifications.ts
  e2e/notifications/notification-center.spec.ts
  e2e/notifications/mark-as-read.spec.ts
  e2e/notifications/notification-preferences.spec.ts
  e2e/notifications/drift-notification.spec.ts

Modified files:
  packages/db/src/schema/index.ts          (re-export new tables)
  apps/api/src/app.ts                      (register notifications plugin)
  apps/web/src/components/Navbar.tsx       (add NotificationBell)
  apps/web/src/router.tsx                  (add /settings/notifications route)
  e2e/fixtures/selectors.ts                (add notification selectors)
  e2e/fixtures/test-base.ts               (add notification seed helpers)
  apps/api/src/drift/drift.service.ts      (emit drift.detected)
  apps/api/src/tickets/tickets.service.ts  (emit ticket.created)
  apps/api/src/proposals/proposals.service.ts (emit change_proposal.*)
```
