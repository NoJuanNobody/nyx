# Direct Ticket Creation from Documents

**Issue:** #76
**Status:** Ready for implementation
**Scope:** Frontend-heavy; backend API already exists

---

## Overview

Users need a fast, AI-free path from a spec document to a trackable work item. Today, every ticket creation flow in SyncDocs involves AI: either through Change Proposals (AI analyzes version history) or Ticket Suggestions (AI recommends tickets from content). This feature adds a direct "Create Ticket" button that bypasses AI entirely — users write a title and description themselves, pick a provider, and push immediately.

---

## Current State

### What already exists

The backend is complete. No new API routes, schema migrations, or services are required.

| Layer | File | Status |
|---|---|---|
| API route | `apps/api/src/routes/tickets.ts` — `POST /api/documents/:documentId/tickets` | ✅ Done |
| Service | `apps/api/src/services/ticket.service.ts` — `createFromDocument()` | ✅ Done |
| GitHub integration | `apps/api/src/services/github.service.ts` — `createIssue()` | ✅ Done |
| Jira integration | `apps/api/src/services/jira.service.ts` — `createIssue()` | ✅ Done |
| Timeline event | Route fires `timelineService.create({ type: 'ticket_created', ... })` | ✅ Done |
| Audit event | Service fires `auditService.recordEvent({ eventType: 'ticket_created', ... })` | ✅ Done |
| DB schema | `apps/api/src/db/schema.ts` — `tickets` table | ✅ Done |

### What is missing

All missing work is in the frontend (`apps/web`).

| Layer | What's needed |
|---|---|
| API client | `createDocumentTicket()` function in `apps/web/src/lib/api.ts` |
| API client | `fetchDocumentTickets()` function in `apps/web/src/lib/api.ts` |
| UI component | `CreateTicketModal` component |
| UI entrypoint | "Create Ticket" button in `DocumentEditor` toolbar |
| UI panel | "Tickets" panel in `DocDrawer` (lists linked tickets, shows external links) |
| E2E test | Direct ticket creation flow in `e2e/tickets.spec.ts` |

---

## UX Flow

```
Document Editor
    │
    ├── [Create Ticket] button (document toolbar, next to "Save Version")
    │
    └── CreateTicketModal opens
            │
            ├── Title      — pre-filled from document title (editable)
            ├── Description — pre-filled with first 500 chars of document content (editable, markdown textarea)
            ├── Provider   — dropdown: GitHub | Jira (only shows connected integrations)
            ├── Labels     — optional text input (comma-separated)
            │
            └── [Create] clicked
                    │
                    ├── POST /api/documents/:id/tickets
                    ├── Success → toast notification + DocDrawer tickets tab refreshes
                    └── Error   → inline error message in modal
```

### Empty-state handling

- If no integrations are connected, the modal shows a message: _"No integrations connected. Go to Settings → Integrations to connect GitHub or Jira."_ with a link to `/settings`.
- The Create button is disabled until a provider is selected and a title is entered.

---

## Implementation Plan

### 1. API client additions (`apps/web/src/lib/api.ts`)

Add two functions after the existing ticket section (line 481):

```ts
export function fetchDocumentTickets(documentId: string): Promise<Ticket[]> {
  return request<Ticket[]>(`/documents/${documentId}/tickets`);
}

export function createDocumentTicket(
  documentId: string,
  data: { provider: 'github' | 'jira'; title: string; body: string },
): Promise<Ticket> {
  return request<Ticket>(`/documents/${documentId}/tickets`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
```

### 2. `CreateTicketModal` component (`apps/web/src/components/CreateTicketModal.tsx`)

Props:

```ts
interface CreateTicketModalProps {
  open: boolean;
  onClose: () => void;
  documentId: string;
  documentTitle: string;
  documentContent: string;
  teamId: string;
}
```

Behaviour:
- Fetches connected integrations via `fetchIntegrations(teamId)` on open (cached via React Query).
- Filters to `type === 'github'` or `type === 'jira'` to build the provider dropdown.
- Pre-fills title from `documentTitle`.
- Pre-fills description with the first 500 characters of `documentContent`, stripped of leading `<!-- ... -->` seeding comments.
- On submit, calls `createDocumentTicket()` via a `useMutation`.
- On success: calls `onClose()`, invalidates `['document-tickets', documentId]` query, shows a success toast.
- Reuses the existing `Modal` component (`apps/web/src/components/Modal.tsx`).

### 3. "Create Ticket" button in `DocumentEditor` (`apps/web/src/pages/DocumentEditor.tsx`)

Add state:

```ts
const [createTicketOpen, setCreateTicketOpen] = useState(false);
```

Add button to the toolbar (after the "Save Version" button, around line 276):

```tsx
<button
  type="button"
  data-testid="create-ticket-btn"
  onClick={() => setCreateTicketOpen(true)}
  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
>
  Create Ticket
</button>
```

Add modal at the bottom of the component (after the Save Version Modal):

```tsx
<CreateTicketModal
  open={createTicketOpen}
  onClose={() => setCreateTicketOpen(false)}
  documentId={id!}
  documentTitle={title}
  documentContent={content}
  teamId={doc.teamId}
/>
```

### 4. Tickets panel in `DocDrawer`

Add `'tickets'` to the `DrawerPanel` union type in `apps/web/src/components/DocDrawer.tsx`:

```ts
export type DrawerPanel = 'history' | 'timeline' | 'proposals' | 'audit' | 'ai' | 'jsx-preview' | 'tickets';
```

Add a `DocumentTickets` component (`apps/web/src/components/DocumentTickets.tsx`) that:
- Fetches `fetchDocumentTickets(documentId)` via React Query.
- Renders each ticket as a row: provider badge, title (linked to `externalUrl`), status badge, creation date.
- Shows an empty state with a "Create Ticket" button that opens the modal when no tickets exist.

Add the panel entry to the `PANELS` array in `DocDrawer.tsx` (ticket/tag SVG icon, label "Tickets").

### 5. E2E test (`e2e/tickets.spec.ts`)

Add a test block:

```
describe('direct ticket creation', () => {
  test('creates a ticket from document toolbar without AI', async ({ authenticatedPage }) => {
    // Navigate to a document
    // Click "Create Ticket" button
    // Verify modal opens with pre-filled title
    // Fill in description, select provider (mocked integration)
    // Click Create
    // Verify ticket appears in DocDrawer tickets panel
    // Verify timeline shows ticket_created event
  });
});
```

The test uses `mock AI` fixture — no LLM calls are made by this feature.

---

## API Reference

### `POST /api/documents/:documentId/tickets`

**Auth:** Bearer token required
**Params:** `documentId` — UUID of the document

**Request body:**
```json
{
  "provider": "github",
  "title": "Implement authentication flow",
  "body": "## Context\n\nFrom the Authentication spec..."
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "documentId": "uuid",
  "provider": "github",
  "externalId": "42",
  "externalUrl": "https://github.com/owner/repo/issues/42",
  "title": "Implement authentication flow",
  "status": "open",
  "createdById": "uuid",
  "createdAt": "2026-03-13T22:00:00Z",
  "updatedAt": "2026-03-13T22:00:00Z"
}
```

**Error (400/404/500):**
```json
{ "error": "No github integration configured for this team" }
```

**Side effects:**
- Creates a `ticket_created` timeline event on the document.
- Creates a `ticket_created` audit trail entry for the team.
- The ticket row is linked to the document in the `tickets` table.

---

## Acceptance Criteria

- [ ] "Create Ticket" button is visible in the document editor toolbar
- [ ] Modal opens with title pre-filled from document title
- [ ] Modal pre-fills description from document content (first ~500 chars)
- [ ] Provider dropdown only shows connected integrations (GitHub and/or Jira)
- [ ] Clicking Create calls `POST /api/documents/:id/tickets` — no LLM call
- [ ] Created ticket appears in the DocDrawer Tickets panel
- [ ] Timeline records a `ticket_created` event visible in the Timeline panel
- [ ] Empty integrations state shows a helpful message with link to Settings
- [ ] E2E test covers the happy path end-to-end

---

## Out of Scope

- Repository/project selector within the modal (the ticket service already uses the first configured repo; a repo picker can be added as a follow-up)
- Labels field sending to the external provider (GitHub Issues API supports labels; Jira requires label IDs — deferring to a follow-up)
- Bulk ticket creation from a document
- Any AI-assisted pre-filling (this feature is intentionally AI-free)
