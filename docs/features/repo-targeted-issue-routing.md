# Repo-Targeted Issue Routing

## Overview

When a user creates a GitHub issue or Jira ticket from a Nyx document, the system currently has no way to select *which* repository (GitHub) or *which* project (Jira) the ticket should be sent to. The destination is silently hardcoded to the first entry in `selectedRepos` for GitHub, and to the fixed `projectKey` stored in the Jira integration config.

This feature gives users explicit control over ticket routing — at the moment of creation and, optionally, as a persistent default on the document itself.

---

## Problem Statement

### Root Cause

In `apps/api/src/services/ticket.service.ts` (lines 46–47), ticket creation always targets the first connected repo:

```typescript
const owner = cfg.selectedRepos?.[0]?.owner ?? cfg.owner ?? '';
const repo  = cfg.selectedRepos?.[0]?.name  ?? cfg.repo  ?? '';
```

The same hardcoded first-repo logic exists in `syncStatus` (lines 170–171). There is no parameter passed from the UI to select a different destination, nor any per-document default stored in the database.

For Jira, the `projectKey` lives in the integration-level config and cannot be overridden per ticket.

### Impact

- Teams that connect multiple repos (e.g., `frontend`, `backend`, `infra`) cannot route tickets to the right codebase.
- Non-technical users creating tickets from specs have no feedback about where the ticket will land.
- Misfiled GitHub issues must be manually transferred after creation.
- Jira teams with multiple projects (e.g., `FE`, `BE`, `DEVOPS`) cannot target the correct board.

---

## User Stories

| ID   | As a…            | I want to…                                                       | So that…                                              |
|------|------------------|------------------------------------------------------------------|-------------------------------------------------------|
| US-1 | Developer        | Choose a target repo when creating a GitHub issue from a doc     | The issue lands in the right repository automatically |
| US-2 | Non-tech author  | See a pre-selected "default repo" based on the document          | I don't have to think about which repo to use         |
| US-3 | Team admin       | Set a default target repo on a document                          | Ticket routing is consistent across the team          |
| US-4 | Developer        | Choose a Jira project when creating a ticket                     | Issues route to the right board                       |
| US-5 | Developer        | Have previously used repo remembered per document                | Repeat ticket creation is frictionless                |

---

## Scope

### In Scope

- Repo/project selector in `CreateTicketModal` (GitHub and Jira)
- `targetRepo` and `targetProject` fields in ticket creation API
- Per-document default repo/project setting (stored on document, editable in DocumentEditor)
- Status sync aware of the `targetRepo` stored on each ticket
- `BulkTicketReview` support for repo selection

### Out of Scope

- Team-level default routing rules (e.g., route by document stage or label) — future work
- Multi-repo fan-out (create the same issue in N repos at once) — future work
- GitHub Projects v2 targeting — separate feature

---

## Design

### Ticket Creation Flow (New)

```
User opens CreateTicketModal
  ├─ Selects provider: GitHub
  │   └─ Repo dropdown appears (lists all selectedRepos for the integration)
  │       ├─ Pre-selects document's defaultGithubRepo if set
  │       └─ Falls back to first repo if no default
  └─ Selects provider: Jira
      └─ Project dropdown appears (lists all accessible Jira projects)
          └─ Pre-selects integration's default projectKey
```

### Data Flow

```
CreateTicketModal
  └─ POST /api/documents/:documentId/tickets
       { provider, title, body, targetRepo?: { owner, name }, targetProject?: string }
       └─ ticketService.createFromDocument(…, targetRepo, targetProject)
            └─ githubService.createIssue(token, owner, repo, title, body)
                 └─ Stored: tickets.targetOwner, tickets.targetRepo
                       └─ Used by syncStatus to fetch the right repo
```

---

## Database Changes

### `tickets` table — add routing columns

```sql
ALTER TABLE tickets
  ADD COLUMN target_owner text,         -- GitHub: org/user owner
  ADD COLUMN target_repo  text,         -- GitHub: repo name
  ADD COLUMN target_project text;       -- Jira: project key
```

These columns record where the ticket was actually sent. They are used during `syncStatus` so each ticket is synced against the correct repo/project regardless of how the integration config changes over time.

### `documents` table — add default routing columns

```sql
ALTER TABLE documents
  ADD COLUMN default_github_owner   text,
  ADD COLUMN default_github_repo    text,
  ADD COLUMN default_jira_project   text;
```

These are optional preferences. When set, `CreateTicketModal` pre-selects them. When absent, the UI defaults to the first connected repo/project.

---

## API Changes

### `POST /api/documents/:documentId/tickets`

**Request body — extended:**

```typescript
{
  provider: 'github' | 'jira';
  title: string;
  body: string;
  targetRepo?: {        // GitHub only
    owner: string;
    name: string;
  };
  targetProject?: string;  // Jira only — project key
}
```

**Validation:**
- If `provider === 'github'` and `targetRepo` is provided, verify that `targetRepo` is in `integration.config.selectedRepos`. Return `400` if not found (prevents routing to arbitrary repos).
- If `provider === 'jira'` and `targetProject` is provided, it is passed directly to `jiraService.createIssue`. No extra validation needed (Jira will reject invalid project keys).

**Response** — unchanged. The ticket object already includes `externalId` and `externalUrl`.

### `GET /api/integrations/:id/github/repos` — no changes

Already returns the list of connected repos. The frontend will reuse this to populate the repo dropdown.

### `GET /api/integrations/:id/jira/projects` — new endpoint

```
GET /api/integrations/:id/jira/projects
```

Returns the list of accessible Jira projects from `jiraService.listProjects`. Cached for 5 minutes per integration ID to avoid hammering the Jira API on every modal open.

```typescript
// Response shape
[
  { key: 'FE', name: 'Frontend' },
  { key: 'BE', name: 'Backend' },
  { key: 'OPS', name: 'Infrastructure' },
]
```

### `PATCH /api/documents/:documentId` — extend to include routing defaults

The existing document update endpoint should accept the new default routing fields:

```typescript
{
  defaultGithubOwner?: string;
  defaultGithubRepo?: string;
  defaultJiraProject?: string;
}
```

---

## Frontend Changes

### `CreateTicketModal` — repo/project selector

When `provider === 'github'`:

1. Fetch connected repos from the cache of `fetchSyncedRepos` (already called in Settings, reuse via React Query).
2. Render a `<select>` dropdown labeled **"Target repository"**.
3. Pre-select `document.defaultGithubRepo` if set; otherwise first repo.
4. Pass `{ owner, name }` as `targetRepo` in the `createTicket` API call.

When `provider === 'jira'`:

1. Fetch Jira projects from new `GET /api/integrations/:id/jira/projects`.
2. Render a `<select>` dropdown labeled **"Target project"**.
3. Pre-select integration's default `projectKey`.
4. Pass the selected key as `targetProject` in the `createTicket` API call.

**Edge cases:**
- If only one repo is connected, skip the dropdown and route silently (existing behavior).
- If the integration has no `selectedRepos`, show an inline warning: *"No repositories connected. Go to Settings → Integrations → Manage Repos."*

### `DocumentEditor` — default repo setting

In the document's settings panel (or a new **Routing** section in the editor sidebar):

- **GitHub default repo**: dropdown of `selectedRepos` for the team's GitHub integration.
- **Jira default project**: dropdown of accessible Jira projects.
- Auto-saved on change via `PATCH /api/documents/:documentId`.

### `BulkTicketReview` — per-ticket repo selector

Each ticket suggestion card in `BulkTicketReview` should include a compact repo/project dropdown so users can adjust routing before batch-creating tickets.

---

## Service Layer Changes

### `ticketService.createFromDocument`

New signature:

```typescript
async createFromDocument(
  documentId: string,
  provider: 'github' | 'jira',
  title: string,
  body: string,
  createdById: string,
  targetRepo?: { owner: string; name: string },  // NEW
  targetProject?: string,                         // NEW
)
```

**GitHub branch:**
```typescript
const owner = targetRepo?.owner ?? cfg.selectedRepos?.[0]?.owner ?? cfg.owner ?? '';
const repo  = targetRepo?.name  ?? cfg.selectedRepos?.[0]?.name  ?? cfg.repo  ?? '';
```

Store `owner` and `repo` as `targetOwner` / `targetRepo` on the `tickets` row.

**Jira branch:**
```typescript
const projectKey = targetProject ?? cfg.projectKey;
```

Store as `targetProject` on the `tickets` row.

### `ticketService.syncStatus`

Replace the hardcoded first-repo logic with the stored `targetOwner`/`targetRepo` columns:

```typescript
const owner = ticket.targetOwner ?? config.selectedRepos?.[0]?.owner ?? config.owner;
const repo  = ticket.targetRepo  ?? config.selectedRepos?.[0]?.name  ?? config.repo;
```

For Jira:
```typescript
const issueKey = ticket.externalId; // already fully qualified (e.g. FE-42)
```

No change needed for Jira sync since `externalId` is the full issue key and fetching by key doesn't require a `projectKey`.

---

## Migration

New Drizzle migration file: `drizzle/XXXX_add_ticket_routing.ts`

```typescript
import { sql } from 'drizzle-orm';
import type { MigrationMeta } from 'drizzle-orm/migrator';

export async function up(db): Promise<void> {
  await db.execute(sql`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS target_owner   text,
      ADD COLUMN IF NOT EXISTS target_repo    text,
      ADD COLUMN IF NOT EXISTS target_project text;

    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS default_github_owner  text,
      ADD COLUMN IF NOT EXISTS default_github_repo   text,
      ADD COLUMN IF NOT EXISTS default_jira_project  text;
  `);
}

export async function down(db): Promise<void> {
  await db.execute(sql`
    ALTER TABLE tickets
      DROP COLUMN IF EXISTS target_owner,
      DROP COLUMN IF EXISTS target_repo,
      DROP COLUMN IF EXISTS target_project;

    ALTER TABLE documents
      DROP COLUMN IF EXISTS default_github_owner,
      DROP COLUMN IF EXISTS default_github_repo,
      DROP COLUMN IF EXISTS default_jira_project;
  `);
}
```

Update `apps/api/src/db/schema.ts`:

```typescript
// tickets table
targetOwner:   text('target_owner'),
targetRepo:    text('target_repo'),
targetProject: text('target_project'),

// documents table
defaultGithubOwner:  text('default_github_owner'),
defaultGithubRepo:   text('default_github_repo'),
defaultJiraProject:  text('default_jira_project'),
```

---

## Shared Types

Update `packages/shared/src/types/ticket.ts`:

```typescript
export interface CreateTicketInput {
  provider: 'github' | 'jira';
  title: string;
  body: string;
  targetRepo?: { owner: string; name: string };
  targetProject?: string;
}
```

Update `packages/shared/src/types/document.ts` (or wherever document types live):

```typescript
export interface DocumentRoutingDefaults {
  defaultGithubOwner?: string;
  defaultGithubRepo?: string;
  defaultJiraProject?: string;
}
```

---

## Error Handling

| Scenario | HTTP Status | Error Message |
|---|---|---|
| `targetRepo` not in `selectedRepos` | `400` | `"Repository '{owner}/{name}' is not connected to this team. Add it in Settings → Integrations."` |
| No repos connected at all | `400` | `"No GitHub repositories configured for this team."` (existing) |
| Jira project key invalid (Jira API rejects) | `422` | Jira error message passed through |
| GitHub token expired | `401` | `github_token_expired` (existing) |

---

## Testing Plan

### Unit Tests

- `ticketService.createFromDocument` — assert `targetRepo` overrides `selectedRepos[0]`
- `ticketService.createFromDocument` — assert invalid `targetRepo` throws a validation error
- `ticketService.syncStatus` — assert it reads from `tickets.targetOwner/targetRepo` instead of `selectedRepos[0]`

### E2E Tests (`e2e/`)

| Test | Steps |
|---|---|
| `create-ticket-repo-selector.spec.ts` | Open doc with 2 connected repos, open Create Ticket, verify dropdown renders, select second repo, submit, assert `externalUrl` contains second repo name |
| `document-default-repo.spec.ts` | Set default repo on document, open Create Ticket, verify dropdown pre-selects the default |
| `jira-project-selector.spec.ts` | Open doc with Jira integration, open Create Ticket, verify project dropdown, select different project, submit |

---

## Rollout Considerations

- **Backwards compatible**: `targetRepo` and `targetProject` are optional. Existing tickets without these columns fall back to `selectedRepos[0]` — same behavior as today.
- **No data migration needed**: Existing tickets will fall back gracefully; `syncStatus` will continue to use `selectedRepos[0]` for tickets where `targetRepo` is null.
- **Feature flag**: Not needed. The new dropdown only appears when `selectedRepos.length > 1` (GitHub) or when the Jira project fetch returns more than one project. Single-repo teams see no UI change.
