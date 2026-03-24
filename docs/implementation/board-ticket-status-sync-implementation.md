# Board Ticket Status Sync — Implementation Plan

Execution plan for the feature defined in
[`docs/features/board-ticket-status-sync.md`](../features/board-ticket-status-sync.md).

Work is split into four phases. Phases 1–3 fix the core bug (tickets not updating). Phase 4
adds the manual-control UI and Jira webhook automation.

---

## Phase 0: Prerequisites

Before any code changes, confirm:

- [ ] The `ticket_status` enum in Drizzle schema has `open`, `in_progress`, `closed` — ✅ already in `apps/api/src/db/schema.ts` line 6
- [ ] `POST /api/tickets/:id/sync` endpoint exists — ✅ `apps/api/src/routes/tickets.ts` line 106
- [ ] `POST /api/webhooks/github` endpoint exists — ✅ `apps/api/src/routes/webhooks.ts` line 37
- [ ] GitHub integration registers webhooks at setup time — ✅ `apps/api/src/routes/integrations.ts`

---

## Phase 1: Fix GitHub Status Sync (Closes Core Bug)

**Goal:** Tickets tied to GitHub issues update their status automatically when issues are closed
or reopened, and reflect "In Progress" when the `in-progress` label is present.

### 1.1 Update `syncStatus` — Add Label-Based `in_progress` for GitHub

**File:** `apps/api/src/services/ticket.service.ts`

The current implementation (lines 183–186) only checks `state`:
```ts
newStatus = data.state === 'closed' ? 'closed' : 'open';
```

Replace with label-aware logic:

```ts
const data = (await res.json()) as { state: string; labels: Array<{ name: string }> };
if (data.state === 'closed') {
  newStatus = 'closed';
} else {
  const inProgressLabel = data.labels.some((l) =>
    ['in-progress', 'in progress'].includes(l.name.toLowerCase())
  );
  newStatus = inProgressLabel ? 'in_progress' : 'open';
}
```

The GitHub API already returns `labels` in the issue response — no extra API call is needed.

### 1.2 Update `syncStatus` — Use Jira `statusCategory` Instead of Name

**File:** `apps/api/src/services/ticket.service.ts`

The current Jira mapping (lines 204–211) matches hard-coded status names. Replace with the
`statusCategory.key` field, which is stable across all Jira workflows:

```ts
// Before
const statusName = issue.fields.status.name.toLowerCase();
if (statusName === 'done' || statusName === 'closed' || statusName === 'resolved') {
  newStatus = 'closed';
} else if (statusName === 'in progress') {
  newStatus = 'in_progress';
} else {
  newStatus = 'open';
}
```

```ts
// After
const categoryKey = issue.fields.status.statusCategory?.key ?? 'new';
if (categoryKey === 'done') {
  newStatus = 'closed';
} else if (categoryKey === 'indeterminate') {
  newStatus = 'in_progress';
} else {
  newStatus = 'open';
}
```

**Note:** Jira's `statusCategory.key` values are: `new`, `indeterminate`, `done`. Verify that
`jiraService.getIssue` fetches `fields.status.statusCategory` — if not, update the Jira API
call to include it (it is returned by default in the Jira REST API v3 response).

### 1.3 Handle GitHub `issues` Webhook Event

**File:** `apps/api/src/routes/webhooks.ts`

The handler currently ignores all non-`push`, non-`issue_comment` events. Add a branch for
`issues` events after the existing `issue_comment` handler:

```ts
if (event === 'issues') {
  const body = request.body as {
    action?: string;
    issue?: {
      number: number;
      state: string;
      labels: Array<{ name: string }>;
    };
    repository?: { owner?: { login?: string }; name?: string };
  };

  const action = body.action;
  // Only process state/label changes that affect status
  if (
    (action === 'closed' || action === 'reopened' || action === 'labeled' || action === 'unlabeled') &&
    body.issue &&
    body.repository
  ) {
    const issueNumber = String(body.issue.number);
    const state = body.issue.state;
    const labels = body.issue.labels ?? [];

    let newStatus: 'open' | 'in_progress' | 'closed';
    if (state === 'closed') {
      newStatus = 'closed';
    } else {
      const isInProgress = labels.some((l) =>
        ['in-progress', 'in progress'].includes(l.name.toLowerCase())
      );
      newStatus = isInProgress ? 'in_progress' : 'open';
    }

    // Fire-and-forget: update matching tickets
    setImmediate(async () => {
      try {
        const owner = body.repository!.owner?.login ?? '';
        const repo = body.repository!.name ?? '';

        // Find all GitHub tickets matching this issue number
        // (externalId stores the issue number as a string)
        const { tickets: ticketsTable } = await import('../db/schema.js');
        const { eq } = await import('drizzle-orm');
        const matchingTickets = await db
          .select()
          .from(ticketsTable)
          .where(eq(ticketsTable.externalId, issueNumber));

        for (const ticket of matchingTickets) {
          if (ticket.provider !== 'github') continue;
          if (!ticket.externalUrl.includes(`${owner}/${repo}`)) continue;

          if (ticket.status !== newStatus) {
            await db
              .update(ticketsTable)
              .set({ status: newStatus, updatedAt: new Date() })
              .where(eq(ticketsTable.id, ticket.id));

            // Audit event (best-effort)
            try {
              const [doc] = await db
                .select({ teamId: documents.teamId })
                .from(documents)
                .where(eq(documents.id, ticket.documentId));
              if (doc) {
                await auditService.recordEvent({
                  teamId: doc.teamId,
                  eventType: 'ticket_updated',
                  ticketId: ticket.id,
                  metadata: {
                    previousStatus: ticket.status,
                    newStatus,
                    source: 'webhook',
                    provider: 'github',
                  },
                });
              }
            } catch { /* best-effort */ }
          }
        }
      } catch (err) {
        request.log.error({ err }, 'Failed to handle issues webhook');
      }
    });
  }

  return { ok: true, event };
}
```

**Important:** The GitHub webhook integration must be updated to subscribe to `issues` events in
addition to `push` and `issue_comment`. Update the webhook registration call in
`apps/api/src/routes/integrations.ts` (where `githubService.createWebhook` is called) to
include `issues` in the events array:

```ts
// Before
events: ['push', 'issue_comment'],

// After
events: ['push', 'issue_comment', 'issues'],
```

Existing webhooks will need to be re-registered (or updated via the GitHub API) to pick up the
new event subscription. Add a migration path: on the next OAuth re-connect or on a manual
"Update Webhook" action, update the events list.

### 1.4 Add `ticket_updated` to Audit Event Type Enum

**File:** `apps/api/src/db/schema.ts`

The `audit_event_type` enum (line 9) already includes `'ticket_updated'` — no change needed.

### Phase 1 Tests

**File:** `apps/api/src/__tests__/services/ticket.service.test.ts`

Add or update test cases for:
- `syncStatus` with GitHub issue state `'open'` and no labels → `'open'`
- `syncStatus` with GitHub issue state `'open'` and label `'in-progress'` → `'in_progress'`
- `syncStatus` with GitHub issue state `'closed'` and any labels → `'closed'`
- `syncStatus` with Jira status category `'done'` → `'closed'`
- `syncStatus` with Jira status category `'indeterminate'` → `'in_progress'`
- `syncStatus` with Jira status category `'new'` → `'open'`

**File:** `apps/api/src/__tests__/routes/webhooks.test.ts`

Add test cases for:
- `POST /api/webhooks/github` with `x-github-event: issues`, `action: 'closed'` → ticket updated to `closed`
- `POST /api/webhooks/github` with `x-github-event: issues`, `action: 'reopened'` → ticket updated to `open`
- `POST /api/webhooks/github` with `x-github-event: issues`, `action: 'labeled'`, label `'in-progress'` → ticket updated to `in_progress`

---

## Phase 2: Manual Status Updates from the Board

**Goal:** Users can change a ticket's status directly from the board.

### 2.1 Add `PATCH /api/tickets/:id/status` Endpoint

**File:** `apps/api/src/routes/tickets.ts`

Add after the existing `POST /api/tickets/:id/sync` handler (line 117):

```ts
// PATCH /api/tickets/:id/status — manually update ticket status
app.patch('/tickets/:id/status', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { status } = request.body as { status?: string };

  const validStatuses = ['open', 'in_progress', 'closed'] as const;
  if (!status || !validStatuses.includes(status as (typeof validStatuses)[number])) {
    reply.code(400);
    return { error: `status must be one of: ${validStatuses.join(', ')}` };
  }

  const [existing] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!existing) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  const [updated] = await db
    .update(tickets)
    .set({ status: status as typeof validStatuses[number], updatedAt: new Date() })
    .where(eq(tickets.id, id))
    .returning();

  // Fire-and-forget: audit event
  setImmediate(async () => {
    try {
      const [doc] = await db
        .select({ teamId: documents.teamId })
        .from(documents)
        .where(eq(documents.id, existing.documentId));
      if (doc) {
        await auditService.recordEvent({
          teamId: doc.teamId,
          eventType: 'ticket_updated',
          actorId: request.user.id,
          ticketId: id,
          metadata: {
            previousStatus: existing.status,
            newStatus: status,
            source: 'manual',
          },
        });
      }
    } catch { /* best-effort */ }
  });

  return updated;
});
```

### 2.2 Add `updateTicketStatus` to Frontend API Client

**File:** `apps/web/src/lib/api.ts`

```ts
export async function updateTicketStatus(
  ticketId: string,
  status: 'open' | 'in_progress' | 'closed',
): Promise<Ticket> {
  const res = await apiClient.patch(`/tickets/${ticketId}/status`, { status });
  return res.data;
}
```

### 2.3 Add Status Dropdown to `TicketCard`

**File:** `apps/web/src/pages/Board.tsx`

Convert `TicketCard` to accept a `onStatusChange` callback and render a `<select>` in the card
footer. Use an optimistic update so the ticket moves columns immediately:

```tsx
function TicketCard({
  ticket,
  onStatusChange,
}: {
  ticket: Ticket;
  onStatusChange: (ticketId: string, status: ColumnStatus) => void;
}) {
  // ... existing JSX ...

  // Add status selector at bottom of card
  return (
    <div className="...">
      {/* existing content */}
      <div className="mt-2 flex items-center justify-between">
        <select
          value={ticket.status}
          onChange={(e) => onStatusChange(ticket.id, e.target.value as ColumnStatus)}
          className="rounded text-[10px] border border-slate-200 px-1 py-0.5 text-slate-500 bg-transparent hover:border-slate-400 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="closed">Closed</option>
        </select>
        <a href={ticket.externalUrl} target="_blank" rel="noopener noreferrer" ...>
          Open externally →
        </a>
      </div>
    </div>
  );
}
```

In `Board`, wire up the optimistic mutation:

```tsx
const statusMutation = useMutation({
  mutationFn: ({ ticketId, status }: { ticketId: string; status: ColumnStatus }) =>
    updateTicketStatus(ticketId, status),
  onMutate: async ({ ticketId, status }) => {
    await queryClient.cancelQueries({ queryKey: ['tickets', currentTeamId] });
    const snapshot = queryClient.getQueryData<Ticket[]>(['tickets', currentTeamId, providerFilter]);
    queryClient.setQueryData<Ticket[]>(
      ['tickets', currentTeamId, providerFilter],
      (old) => old?.map((t) => (t.id === ticketId ? { ...t, status } : t)) ?? [],
    );
    return { snapshot };
  },
  onError: (_err, _vars, ctx) => {
    if (ctx?.snapshot) {
      queryClient.setQueryData(['tickets', currentTeamId, providerFilter], ctx.snapshot);
    }
  },
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: ['tickets', currentTeamId] });
  },
});
```

Pass `onStatusChange` down:
```tsx
<TicketCard
  key={ticket.id}
  ticket={ticket}
  onStatusChange={(ticketId, status) => statusMutation.mutate({ ticketId, status })}
/>
```

### Phase 2 Tests

**File:** `apps/api/src/__tests__/routes/tickets.test.ts`

- `PATCH /api/tickets/:id/status` with valid status → 200, ticket updated
- `PATCH /api/tickets/:id/status` with invalid status → 400
- `PATCH /api/tickets/:id/status` with unknown id → 404

**E2E test:** `e2e/board-status.spec.ts` (new file)

```ts
test('manual status change moves ticket to correct column', async ({ authenticatedPage }) => {
  const page = authenticatedPage;
  await page.goto('/board');
  // ... find a ticket in "In Progress", change its status dropdown to "Closed"
  // assert it appears in the "Closed" column
});
```

---

## Phase 3: Jira Webhook Integration

**Goal:** Jira status changes propagate to Nyx automatically without manual sync.

### 3.1 Register Jira Webhook During Integration Setup

**File:** `apps/api/src/routes/integrations/atlassian.ts`

When a Jira integration is saved (after OAuth completes), call the Jira Webhooks REST API to
register a webhook for `jira:issue_updated` events:

```ts
// After saving integration to DB:
const webhookSecret = crypto.randomBytes(32).toString('hex');
const webhookUrl = `${config.API_BASE_URL}/api/webhooks/jira`;

await jiraService.registerWebhook(
  jiraBaseUrl,
  atlassianAccessToken,
  webhookUrl,
  webhookSecret,
);

// Store secret in integration config for later verification
await db.update(integrations)
  .set({ config: { ...existingConfig, webhookSecret } })
  .where(eq(integrations.id, integrationId));
```

Add `registerWebhook` to `apps/api/src/services/jira.service.ts`:

```ts
async registerWebhook(
  baseUrl: string,
  accessToken: string,
  callbackUrl: string,
  secret: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/rest/api/3/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: callbackUrl,
      webhooks: [{
        events: ['jira:issue_updated'],
        filters: {
          'issue-related-events-section': '',
        },
      }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to register Jira webhook: ${res.status} ${await res.text()}`);
  }
}
```

**Note:** Jira's dynamic webhooks API (`/rest/api/3/webhook`) requires Jira Cloud and the OAuth
app to have the `WRITE:WEBHOOK:JIRA` scope. Verify scope coverage in the Atlassian app manifest.

### 3.2 Add Jira Webhook Handler

**File:** `apps/api/src/routes/webhooks.ts` (new route plugin) or a separate
`apps/api/src/routes/webhooks-jira.ts`.

```ts
// POST /api/webhooks/jira
app.post('/jira', async (request, reply) => {
  // Jira sends a JSON body; verify with HMAC-SHA256 if secret is stored
  const body = request.body as {
    webhookEvent?: string;
    issue?: {
      key: string;
      fields?: {
        status?: {
          statusCategory?: { key: string };
          name?: string;
        };
      };
    };
    changelog?: {
      items?: Array<{ field: string; toString: string; fromString: string }>;
    };
  };

  if (body.webhookEvent !== 'jira:issue_updated') {
    return { ok: true };
  }

  // Only act on status field changes
  const statusChange = body.changelog?.items?.find((item) => item.field === 'status');
  if (!statusChange || !body.issue) {
    return { ok: true };
  }

  const issueKey = body.issue.key;
  const categoryKey = body.issue.fields?.status?.statusCategory?.key ?? 'new';

  let newStatus: 'open' | 'in_progress' | 'closed';
  if (categoryKey === 'done') newStatus = 'closed';
  else if (categoryKey === 'indeterminate') newStatus = 'in_progress';
  else newStatus = 'open';

  setImmediate(async () => {
    try {
      const matchingTickets = await db
        .select()
        .from(tickets)
        .where(eq(tickets.externalId, issueKey));

      for (const ticket of matchingTickets) {
        if (ticket.provider !== 'jira' || ticket.status === newStatus) continue;

        await db.update(tickets)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(tickets.id, ticket.id));

        // Audit event (best-effort)
        const [doc] = await db.select({ teamId: documents.teamId })
          .from(documents)
          .where(eq(documents.id, ticket.documentId));
        if (doc) {
          await auditService.recordEvent({
            teamId: doc.teamId,
            eventType: 'ticket_updated',
            ticketId: ticket.id,
            metadata: {
              previousStatus: ticket.status,
              newStatus,
              source: 'webhook',
              provider: 'jira',
            },
          });
        }
      }
    } catch (err) {
      request.log.error({ err }, 'Failed to handle Jira webhook');
    }
  });

  return { ok: true };
});
```

Register this route in `apps/api/src/app.ts` (or wherever webhook routes are registered):

```ts
app.register(webhookRoutes, { prefix: '/api/webhooks' });
```

---

## Phase 4: Observability & Polish

### 4.1 Timeline Event for Status Changes

**File:** `apps/api/src/services/ticket.service.ts`

After every successful status update (in `syncStatus` and the new `PATCH` handler), fire a
`ticket_updated` timeline event using `timelineService.create`. This surfaces status transitions
in the document timeline view.

```ts
await timelineService.create({
  documentId: ticket.documentId,
  type: 'ticket_updated',
  payload: {
    ticketId: ticket.id,
    previousStatus: ticket.status,
    newStatus,
    source,
  },
});
```

### 4.2 Error Handling in `syncAllForTeam`

**File:** `apps/api/src/services/ticket.service.ts` (lines 128–140)

The current implementation silently swallows all errors. Add structured logging so failures are
observable:

```ts
} catch (err) {
  // Best-effort sync — log for observability
  console.error('[ticket] syncStatus failed for ticket', ticket.id, err instanceof Error ? err.message : err);
}
```

### 4.3 Re-register Webhooks for Existing GitHub Integrations

For existing GitHub integrations whose webhooks were registered before the `issues` event was
added, provide a one-time migration. This can be:

- A manual admin action (API route or script)
- An automatic upgrade triggered on the next OAuth token refresh
- A background job that checks webhook event subscriptions and patches them via the GitHub API

**GitHub API call to update an existing webhook:**
```
PATCH /repos/{owner}/{repo}/hooks/{hook_id}
body: { "add_events": ["issues"] }
```

---

## Rollout Checklist

### Backend
- [ ] Update `syncStatus` label logic for GitHub (Phase 1.1)
- [ ] Update `syncStatus` Jira statusCategory mapping (Phase 1.2)
- [ ] Add `issues` event handler in GitHub webhook route (Phase 1.3)
- [ ] Update webhook registration to include `issues` event (Phase 1.3)
- [ ] Add `PATCH /api/tickets/:id/status` endpoint (Phase 2.1)
- [ ] Register Jira webhook during integration setup (Phase 3.1)
- [ ] Add `POST /api/webhooks/jira` handler (Phase 3.2)
- [ ] Add timeline events for status changes (Phase 4.1)
- [ ] Add error logging in `syncAllForTeam` (Phase 4.2)

### Frontend
- [ ] Add `updateTicketStatus` function to `apps/web/src/lib/api.ts` (Phase 2.2)
- [ ] Add status dropdown to `TicketCard` component (Phase 2.3)
- [ ] Add optimistic update / rollback mutation in `Board` (Phase 2.3)

### Tests
- [ ] Unit tests for updated `syncStatus` logic (Phase 1 tests)
- [ ] Integration tests for `issues` webhook handler (Phase 1 tests)
- [ ] Unit tests for `PATCH /api/tickets/:id/status` (Phase 2 tests)
- [ ] E2E test for manual status change on board (Phase 2 tests)

### Infrastructure
- [ ] Verify Atlassian OAuth app has `WRITE:WEBHOOK:JIRA` scope (Phase 3.1)
- [ ] Ensure `API_BASE_URL` env var is set in Railway/Render (Phase 3.1)
- [ ] Re-register existing GitHub webhooks to include `issues` event (Phase 4.3)

---

## File Map

| File | Change Type | Phase |
|------|-------------|-------|
| `apps/api/src/services/ticket.service.ts` | Modify `syncStatus` | 1.1, 1.2 |
| `apps/api/src/routes/webhooks.ts` | Add `issues` event handler | 1.3 |
| `apps/api/src/routes/integrations.ts` | Update webhook events list | 1.3 |
| `apps/api/src/routes/tickets.ts` | Add `PATCH /:id/status` | 2.1 |
| `apps/web/src/lib/api.ts` | Add `updateTicketStatus` | 2.2 |
| `apps/web/src/pages/Board.tsx` | Add status dropdown + mutation | 2.3 |
| `apps/api/src/services/jira.service.ts` | Add `registerWebhook` | 3.1 |
| `apps/api/src/routes/integrations/atlassian.ts` | Register Jira webhook on setup | 3.1 |
| `apps/api/src/routes/webhooks.ts` (or new file) | Add Jira webhook handler | 3.2 |
| `apps/api/src/__tests__/services/ticket.service.test.ts` | New/updated tests | 1, 2 |
| `apps/api/src/__tests__/routes/webhooks.test.ts` | New tests | 1, 3 |
| `apps/api/src/__tests__/routes/tickets.test.ts` | New tests | 2 |
| `e2e/board-status.spec.ts` | New E2E test | 2 |
