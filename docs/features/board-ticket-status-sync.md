# Board Ticket Status Synchronization

Keep board ticket statuses in sync with external trackers (GitHub Issues, Jira) and allow
manual status changes from within the Nyx board — so tickets always reflect reality without
requiring users to switch tools.

## Problem Statement

Tickets on the Nyx board are mirrors of issues in external trackers. When a developer closes a
GitHub issue or a Jira ticket is moved to "Done", the Nyx board does not update automatically.
Tickets remain stuck in their last-known status (typically "In Progress") until a user manually
clicks **Sync All**. This creates a misleading board state and erodes trust in the tool.

### Root Causes

1. **GitHub webhooks don't handle `issues` events.** The webhook handler
   (`apps/api/src/routes/webhooks.ts`) only processes `push` and `issue_comment` events. When a
   GitHub issue is closed or reopened, GitHub sends an `issues` event with `action: 'closed'` or
   `action: 'reopened'`. That event is currently received, acknowledged, and discarded — so the
   ticket status is never updated automatically.

2. **No "in progress" signal from GitHub.** The GitHub Issues API only exposes two states:
   `open` and `closed`. The current sync code maps `open → open`, never `in_progress`. Teams that
   use GitHub labels like `"in-progress"` to signal work-in-progress have no way to surface that
   on the Nyx board.

3. **Jira webhooks are not registered.** The Atlassian integration connects via OAuth but never
   registers a Jira webhook. Status changes in Jira are completely invisible until the user
   triggers a manual sync.

4. **No manual status control on the board.** The board is read-only. There is no per-card
   control to change status (no drag-and-drop, no dropdown, no "mark complete" button). Users
   cannot reflect reality in Nyx even when they know a ticket's state has changed.

---

## Goals

| # | Goal |
|---|------|
| G1 | Ticket status updates automatically when a GitHub issue is closed or reopened |
| G2 | Ticket status updates automatically when a Jira issue transitions |
| G3 | "In Progress" is reachable from GitHub via label-based signaling |
| G4 | Users can manually update a ticket's status from the Nyx board |
| G5 | Manual status changes are reflected immediately in the UI |
| G6 | Status changes are audited and surfaced in the document timeline |

## Non-Goals

- Building an internal ticket tracker — Nyx delegates issue management to GitHub/Jira
- Two-way sync of all ticket fields (title, body, assignee, etc.)
- Real-time push updates via WebSockets (polling and webhooks are sufficient for MVP)

---

## Feature Design

### Status Model

Nyx uses a three-state model:

| Nyx Status   | DB Value    | Meaning |
|--------------|-------------|---------|
| Open         | `open`      | Ticket exists but work has not started |
| In Progress  | `in_progress` | Work is actively underway |
| Closed       | `closed`    | Work is complete (or issue was closed without implementation) |

### GitHub → Nyx Status Mapping

GitHub issues have two API states (`open`, `closed`). The `in_progress` state is inferred from
labels, because that is the dominant convention in GitHub-native teams.

| GitHub API `state` | GitHub Labels include | Nyx Status |
|--------------------|-----------------------|------------|
| `closed`           | any                   | `closed`   |
| `open`             | `in-progress` or `in progress` | `in_progress` |
| `open`             | (no matching label)   | `open`     |

Label matching is **case-insensitive** and checks for both `in-progress` and `in progress`.

### Jira → Nyx Status Mapping

Jira statuses are workflow-defined and vary between projects. The mapping normalizes common
category names used by Jira's built-in status categories.

| Jira Status Category | Example Status Names | Nyx Status |
|----------------------|----------------------|------------|
| `done`               | Done, Closed, Resolved, Won't Fix | `closed` |
| `indeterminate`      | In Progress, In Review, In Development | `in_progress` |
| `new` / `undefined`  | To Do, Open, Backlog, New | `open` |

The mapping should use Jira's `status.statusCategory.key` field (`new`, `indeterminate`, `done`)
rather than the human-readable status name. This makes the mapping robust against custom workflow
names.

### Manual Status Updates

Users can change a ticket's status directly from the board without leaving Nyx. The board
remains the source of truth for status **only when** the external tracker lacks the concept
(e.g., GitHub "in progress"). When the external tracker is the source of truth, manual changes
are advisory and will be overwritten on the next sync unless a "lock" mechanism is added (see
Future Work).

The UI change is a status dropdown on each `TicketCard`. Selecting a new status immediately
optimistically updates the UI and fires a `PATCH /api/tickets/:id/status` request.

---

## API Changes

### New Endpoint: Manual Status Update

```
PATCH /api/tickets/:id/status
```

**Request body:**
```json
{ "status": "closed" }
```

**Response (200):**
```json
{
  "id": "uuid",
  "status": "closed",
  "updatedAt": "2026-03-24T18:00:00Z"
}
```

**Error responses:**
- `400` — invalid `status` value
- `404` — ticket not found

### Modified Endpoint: Single Ticket Sync

`POST /api/tickets/:id/sync` already exists. The `syncStatus` service method must be updated to
use the new label-based GitHub mapping and the Jira `statusCategory` mapping.

### Webhook: GitHub `issues` Event

The existing `POST /api/webhooks/github` handler is extended to process `issues` events:

```
event: issues
action: closed | reopened | labeled | unlabeled
```

On `closed` or `reopened`, the handler looks up the matching Nyx ticket by `(externalId,
provider='github')` and updates its status without a full round-trip API call (the event payload
already contains the issue state and labels).

On `labeled` or `unlabeled`, it re-evaluates the `in_progress` label logic and updates status
accordingly.

### Webhook: Jira Issue Updated

A new Jira webhook endpoint receives status-change events from Jira:

```
POST /api/webhooks/jira
```

Jira webhook payloads include `issue_updated` events with a `changelog` showing the field that
changed. The handler filters for `status` field changes and updates the matching Nyx ticket.

GitHub webhooks are registered automatically at integration setup time (existing behavior). Jira
webhooks must also be registered automatically during Jira integration setup.

---

## Database Changes

No schema changes are required. The existing `ticket_status` enum already supports `open`,
`in_progress`, and `closed`. The `updatedAt` column records when the status last changed.

Optional (Phase 2): add a `statusLockedAt` nullable timestamp to tickets so that manually-set
statuses are not overwritten by the next sync.

---

## Frontend Changes

### Board: Status Dropdown on TicketCard

Each `TicketCard` gets a status selector — a compact dropdown anchored to the bottom-left of the
card. It shows the current status with a colored dot and allows selection of any of the three
states.

- Selecting a new status fires an optimistic update via React Query's `useMutation`
- On success, the ticket moves to the new column immediately
- On failure, the optimistic update is rolled back and an inline error toast is shown
- The dropdown should not be shown for users without write access

### Board: Auto-Refresh After Sync

The "Sync All" button already invalidates the React Query cache on success. No polling is added
for MVP — users trigger syncs manually or rely on incoming webhooks to keep the board fresh.

---

## Audit & Timeline Events

Status changes — whether triggered by a webhook, sync, or manual update — are recorded as
`ticket_updated` audit events. The document timeline shows status transitions so PMs and leads
can see work progression without leaving Nyx.

**Audit event payload:**
```json
{
  "eventType": "ticket_updated",
  "ticketId": "uuid",
  "provider": "github",
  "previousStatus": "in_progress",
  "newStatus": "closed",
  "source": "webhook" | "sync" | "manual"
}
```

---

## Security Considerations

- **Webhook authentication:** GitHub webhooks are verified via HMAC-SHA256 (already in place).
  Jira webhooks must use a secret token in the `Authorization` header or a signed JWT — the
  registration step should generate and store a per-integration secret.
- **Authorization on PATCH endpoint:** Only team members with `developer`, `admin`, or `owner`
  roles can change a ticket's status. Viewers and editors cannot.
- **Rate limiting:** The Jira and GitHub REST APIs have rate limits. The `syncAllForTeam` method
  loops through all tickets synchronously — for teams with many tickets this could exhaust rate
  limits. Phase 2 should add per-provider batching and backoff.

---

## Future Work

| Item | Description |
|------|-------------|
| Status lock | Allow users to "lock" a manual status so it is not overwritten by the next sync |
| Jira custom status mapping | Let teams define their own Jira status → Nyx status mappings in settings |
| Real-time push | Use SSE or WebSockets to push status changes to all connected clients without a page refresh |
| Bulk status update | Select multiple tickets on the board and update them in one action |
| PR-based status | Auto-transition GitHub tickets to `closed` when a linked PR is merged |
| Closed reason | Distinguish `won't fix` / `duplicate` from `done` in the status model |
| Jira labels for `in_progress` | Apply the same label-inference logic to Jira as GitHub |

---

## Acceptance Criteria

- [ ] Closing a GitHub issue automatically moves the board ticket to **Closed** (via webhook, without manual sync)
- [ ] Reopening a GitHub issue automatically moves the board ticket back to **Open**
- [ ] Adding the `in-progress` label to a GitHub issue moves the board ticket to **In Progress**
- [ ] Completing a Jira ticket (status category: `done`) automatically moves the board ticket to **Closed**
- [ ] Moving a Jira ticket to an active status (category: `indeterminate`) automatically moves the board ticket to **In Progress**
- [ ] A user can change a ticket's status from the board using a dropdown
- [ ] Manual status changes are reflected in the board immediately (optimistic UI)
- [ ] All status changes (webhook, sync, manual) are recorded as `ticket_updated` audit events
- [ ] Status changes appear in the document's timeline view
