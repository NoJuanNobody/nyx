# Notifications System

SyncDocs notifies users when things that matter to them change — drift is detected, tickets are created, collaborators make changes, or documents need review. Notifications are delivered in-app (real-time or near-real-time) and via email (transactional or digest).

---

## 1. Notification Events

| Event | Trigger | Audience |
|---|---|---|
| `drift.detected` | GitHub sync finds doc/code divergence | Document owners, workspace admins |
| `ticket.created` | Ticket pushed to GitHub Issues or Jira | Document owners, team members |
| `ticket.updated` | Ticket status changes (open → closed, etc.) | Document owners, assignees |
| `change_proposal.submitted` | Non-dev user edits and submits a change proposal | Document owners, reviewers |
| `change_proposal.approved` | Reviewer approves a change proposal | Proposal author |
| `change_proposal.rejected` | Reviewer rejects a change proposal | Proposal author |
| `approval.requested` | Document owner requests review on a doc branch | Named reviewers |
| `document.shared` | Document or workspace shared with a new user | New recipient |
| `team.invite` | User invited to a workspace | Invitee |
| `snapshot.created` | Named product snapshot published | Workspace members (digest) |
| `comment.mention` | User mentioned in a document comment | Mentioned user |

---

## 2. In-App Notification Center

### 2.1 UI Design

The notification center lives in the top-right navigation bar as a **bell icon** with a numeric badge. Clicking it opens a side panel (not a full-page route) that overlays the current view.

```
[Bell 🔔 (3)]  →  opens  →  ┌─────────────────────────────┐
                             │  Notifications           ✕  │
                             │  ─────────────────────────  │
                             │  [All] [Unread] [Drift] [PR]│
                             │                             │
                             │  ● Drift detected in Auth…  │
                             │    Spec · 2 min ago         │
                             │                             │
                             │  ○ Ticket #47 closed        │
                             │    GitHub · 1 hr ago        │
                             │                             │
                             │  [Mark all as read]         │
                             └─────────────────────────────┘
```

### 2.2 Read/Unread State

- **Unread:** bold title, colored left border accent, filled dot indicator
- **Read:** normal weight, no accent, hollow dot
- Clicking a notification marks it read and navigates to the relevant context (document, ticket, diff view)
- "Mark all as read" bulk action clears the badge and marks every notification read

### 2.3 Badge Count

- Badge shows count of unread notifications, capped at `99+`
- Badge disappears when unread count reaches zero
- Count is refreshed via polling (default: every 30 seconds) or WebSocket push when connected

### 2.4 Filtering

Filter tabs above the list:
- **All** — full chronological feed
- **Unread** — unread only
- **Drift** — `drift.detected` events only
- **Tickets** — `ticket.*` events only
- **Reviews** — `approval.*` and `change_proposal.*` events

Filters persist for the session via local state (not URL params, to avoid polluting browser history).

---

## 3. Email Notifications

### 3.1 Transactional Email Provider

**Resend** (`resend.com`) is the recommended provider. It offers:
- Simple REST API + Node.js SDK
- React Email template rendering
- Generous free tier (3,000 emails/month)
- Strong deliverability and SPF/DKIM setup

Configuration:
```env
RESEND_API_KEY=re_...
EMAIL_FROM=notifications@nyx.io
```

### 3.2 Email Templates

One React Email template per event category (not per event), stored at `apps/api/src/notifications/templates/`:

| Template file | Covers |
|---|---|
| `drift-detected.tsx` | `drift.detected` |
| `ticket-update.tsx` | `ticket.created`, `ticket.updated` |
| `change-proposal.tsx` | `change_proposal.*` |
| `approval-request.tsx` | `approval.requested` |
| `team-invite.tsx` | `team.invite`, `document.shared` |
| `digest.tsx` | Weekly digest rollup |

All templates share a common layout component with SyncDocs branding, one-click unsubscribe link, and a "manage preferences" footer link.

### 3.3 Frequency and Digest Options

Users can choose per-event-type delivery frequency:

| Mode | Behavior |
|---|---|
| **Instant** | Email sent immediately when event fires |
| **Daily digest** | Events batched and sent once per day at 8 AM in the user's timezone |
| **Weekly digest** | Events batched and sent Monday 8 AM |
| **Off** | No email; in-app only |

`drift.detected` and `approval.requested` default to **Instant** for all users. Everything else defaults to **Daily digest**.

---

## 4. User Preferences

Preferences are per-user and stored in the `notification_preferences` table (see Data Model below).

### 4.1 Per-Event-Type Controls

Each event type has two independent toggles:
- **In-app:** show/hide from the notification center
- **Email:** on/off, and if on, which frequency mode

Preferences UI lives at `/settings/notifications`.

### 4.2 Global Overrides

Users can also set:
- **Pause all emails** (holiday/vacation mode) — with optional auto-resume date
- **Email digest day/time** — configures when daily/weekly batches are sent
- **Timezone** — used for digest scheduling; defaults to browser-detected timezone

---

## 5. Data Model

### 5.1 `notifications` Table

```sql
CREATE TABLE notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,           -- e.g. 'drift.detected'
  title         TEXT NOT NULL,
  body          TEXT,
  metadata      JSONB,                   -- entity IDs, links, etc.
  read_at       TIMESTAMPTZ,             -- NULL = unread
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
```

### 5.2 `notification_preferences` Table

```sql
CREATE TABLE notification_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  in_app        BOOLEAN NOT NULL DEFAULT true,
  email_enabled BOOLEAN NOT NULL DEFAULT true,
  email_mode    TEXT NOT NULL DEFAULT 'daily',  -- 'instant' | 'daily' | 'weekly' | 'off'
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_type)
);
```

### 5.3 `email_delivery_log` Table

```sql
CREATE TABLE email_delivery_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES notifications(id),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id     TEXT,                   -- Resend message ID
  status          TEXT NOT NULL,          -- 'queued' | 'sent' | 'failed' | 'bounced'
  sent_at         TIMESTAMPTZ,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 6. Real-Time Delivery

### 6.1 Recommended Approach: Polling with WebSocket Upgrade Path

For the MVP, use **polling** (30-second interval) from the frontend:
- Simple to implement, zero infrastructure overhead
- Acceptable for most notification latency needs

For events where sub-second delivery matters (`drift.detected`, `approval.requested`), plan for **WebSocket push** via a dedicated connection managed by the API server. This is tracked as a separate workstream in issue #43.

WebSocket upgrade path:
1. Client connects to `wss://api.nyx.io/ws` with a JWT auth token
2. Server pushes a `notification` event on the socket when a new notification is created
3. Client increments badge count and prepends the notification to the list without a full refetch

### 6.2 Polling Endpoint

```
GET /api/notifications/unread-count
```
Returns `{ count: number }` — used for lightweight badge refresh without loading the full list.

---

## 7. Grouping and Deduplication

### 7.1 Grouping

Related events within a short window are grouped into a single notification:
- Multiple drift detections on the same document within 10 minutes → one notification ("3 sections drifted in Auth Spec")
- Multiple ticket updates on the same ticket → latest state only

Grouping key: `(user_id, event_type, entity_id)` where `entity_id` is the document or ticket ID.

### 7.2 Deduplication

Before inserting a notification, check for an unread notification with the same `(user_id, event_type, entity_id)` created within the grouping window. If found:
- Update the existing notification's `body` and `metadata` rather than inserting a new row
- Bump `created_at` to keep it at the top of the feed

---

## 8. API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/notifications` | List notifications (paginated, filterable by `read`, `event_type`) |
| `GET` | `/api/notifications/unread-count` | Unread badge count |
| `PATCH` | `/api/notifications/:id/read` | Mark single notification as read |
| `PATCH` | `/api/notifications/read-all` | Mark all notifications as read |
| `DELETE` | `/api/notifications/:id` | Delete a notification |
| `GET` | `/api/notifications/preferences` | Get user preferences |
| `PUT` | `/api/notifications/preferences` | Update user preferences (full replace) |
| `PATCH` | `/api/notifications/preferences/:event_type` | Update single event type preference |

All endpoints are authenticated via Clerk session JWT. Users can only read/write their own notifications.

### Request/Response Examples

**List notifications:**
```
GET /api/notifications?read=false&limit=20&cursor=<iso-timestamp>

200 OK
{
  "items": [
    {
      "id": "uuid",
      "eventType": "drift.detected",
      "title": "Drift detected in Auth Spec",
      "body": "3 sections no longer match the codebase.",
      "metadata": { "documentId": "uuid", "driftSections": 3 },
      "readAt": null,
      "createdAt": "2026-03-14T17:00:00Z"
    }
  ],
  "nextCursor": "2026-03-14T16:55:00Z",
  "unreadCount": 5
}
```

**Update preferences:**
```
PATCH /api/notifications/preferences/drift.detected
{
  "inApp": true,
  "emailEnabled": true,
  "emailMode": "instant"
}

204 No Content
```

---

## 9. E2E Testing

### 9.1 Critical User Flows

1. **Drift triggers in-app notification** — drift is detected on a connected GitHub repo; the user opens the notification center and sees a new unread drift notification; clicking it navigates to the drift diff view.
2. **Email sent for new change proposal** — a non-dev user submits a change proposal; the document owner receives an email and clicking the CTA opens the proposal review page.
3. **Mark-all-as-read flow** — user has 5+ unread notifications; clicks "Mark all as read"; badge clears and all items render as read.
4. **User opts out of email for an event type** — user sets `ticket.created` email to Off; a ticket is created; no email is queued in the delivery log.
5. **Notification deduplication** — two drift events fire on the same document within the grouping window; only one notification appears in the center.

### 9.2 Test Scenarios (Given/When/Then)

**Scenario 1: Drift notification appears in-app**
```
Given: A document is connected to a GitHub repo
  And: The user is logged in with notifications enabled
When: The GitHub sync job detects a drift
Then: A new notification with eventType=drift.detected appears in the center
  And: The unread badge count increments by 1
  And: The notification title contains the document name
```

**Scenario 2: Mark single notification as read**
```
Given: The user has at least one unread notification
When: The user clicks the notification
Then: The notification's readAt field is set
  And: The notification styling changes to "read" state
  And: The badge count decrements by 1
```

**Scenario 3: Mark all as read**
```
Given: The user has 3 unread notifications
When: The user clicks "Mark all as read"
Then: All notifications show read state
  And: The badge disappears (count = 0)
  And: GET /api/notifications/unread-count returns { count: 0 }
```

**Scenario 4: Email preference respected**
```
Given: The user sets ticket.created email preference to "off"
When: A ticket is created from a document change
Then: No row is inserted in email_delivery_log for this user and event
  And: An in-app notification is still created (if inApp = true)
```

### 9.3 Integration Boundaries

| External Service | Test Strategy |
|---|---|
| Resend (email) | Mock the Resend SDK in all E2E tests; assert that `email_delivery_log` rows are created with correct status |
| GitHub webhook (drift trigger) | Use a test HTTP client to POST a fake webhook payload to `/webhooks/github` |
| WebSocket push | Mock the WS server; test polling fallback in E2E |
| Clerk auth | Use the existing `authenticatedPage` fixture |

### 9.4 Test Data Requirements

- **Seed user:** standard test user with default notification preferences (provided by `authenticatedPage` fixture)
- **Fixture document:** a document connected to a test GitHub repo with known drift
- **Workspace:** at least one other workspace member to test `document.shared` and `team.invite` events
- **Seeded notifications:** factory helper to insert N notifications with controlled `read_at` values for badge/read-state tests

### 9.5 Playwright Test File Locations

```
e2e/
  notifications/
    notification-center.spec.ts       # In-app center: open, close, filter, read/unread
    mark-as-read.spec.ts              # Single read, mark-all-as-read flows
    notification-preferences.spec.ts  # Settings page, per-event toggles, digest options
    drift-notification.spec.ts        # End-to-end: webhook → in-app notification
    email-delivery.spec.ts            # Email queuing and delivery log assertions
```

### 9.6 CI Considerations

- **Environment variables required:** `RESEND_API_KEY` (set to a test/sandbox key or empty string with Resend mocked), `DATABASE_URL` (test database)
- **No real email sending in CI:** Resend calls must be intercepted. Use a Fastify hook or the Resend SDK's `baseURL` override to point to a local mock server, or inject a mock via dependency injection.
- **Database:** use `drizzle-kit push --force` to apply the notifications schema before tests run (consistent with existing CI setup in `ci.yml`)
- **WebSocket tests:** if testing real-time push, run the API server as a service container in CI; otherwise mock the WS and rely on polling
- **Isolation:** each test file should seed and clean up its own notification rows to prevent cross-test interference
