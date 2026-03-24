# Implementation Plan: GitLab & Bitbucket Integrations

> **Issue:** #236
> **Feature doc:** `docs/features/gitlab-bitbucket-integrations.md`
> **Estimated phases:** 4
> **Dependencies:** Existing GitHub integration, Drizzle ORM schema, Fastify routes

---

## Overview

This plan implements GitLab and Bitbucket as first-class Git hosting integrations in Nyx. The work follows the GitHub integration as a template and is organized into four phases that can be shipped incrementally.

| Phase | Scope | Outcome |
|---|---|---|
| 1 | Schema + provider abstraction | DB ready, shared interfaces defined |
| 2 | Backend: GitLab | GitLab OAuth, webhooks, API service |
| 3 | Backend: Bitbucket | Bitbucket OAuth, webhooks, API service |
| 4 | Frontend | Settings UI, repo selector, connection status |

---

## Phase 1 — Database Schema & Provider Abstraction

### 1.1 Extend Enums

**File:** `apps/api/src/db/schema.ts`

The `integrationTypeEnum` currently covers `['github', 'jira', 'confluence']`. Add the new providers:

```typescript
// Before
export const integrationTypeEnum = pgEnum('integration_type', ['github', 'jira', 'confluence']);

// After
export const integrationTypeEnum = pgEnum('integration_type', [
  'github', 'gitlab', 'bitbucket', 'jira', 'confluence'
]);

// Extend ticketProviderEnum
export const ticketProviderEnum = pgEnum('ticket_provider', ['github', 'gitlab', 'bitbucket', 'jira']);
```

**Migration:** Generate a new Drizzle migration:
```bash
pnpm --filter api exec drizzle-kit generate
```

The migration will produce `ALTER TYPE` statements for both enums. Review before applying.

> **CI note:** CI runs `drizzle-kit push --force`. The new enum values are additive and non-breaking — no data migration required.

### 1.2 Define Shared Provider Interface

**New file:** `apps/api/src/services/git-provider.interface.ts`

Extract the common operations shared by all Git hosting providers behind a TypeScript interface. This enables the drift detection and webhook handling code to remain provider-agnostic.

```typescript
export interface GitRepo {
  id: string | number;
  name: string;
  fullName: string;          // e.g. 'owner/repo'
  defaultBranch: string;
  webUrl: string;
  isPrivate: boolean;
}

export interface GitCommit {
  id: string;
  message: string;
  timestamp: string;
  authorName: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface GitPushEvent {
  ref: string;               // e.g. 'refs/heads/main'
  repoFullName: string;
  commits: GitCommit[];
}

export interface GitFileContent {
  path: string;
  content: string;           // decoded UTF-8
  encoding: 'utf-8';
  webUrl: string;
}

export interface GitTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

export interface GitIssue {
  id: number | string;
  externalId: string;        // issue number/iid as string
  title: string;
  webUrl: string;
}

export interface GitProviderService {
  listRepos(): Promise<GitRepo[]>;
  getFileTree(repoFullName: string, ref: string): Promise<GitTreeEntry[]>;
  getFileContent(repoFullName: string, path: string, ref: string): Promise<GitFileContent>;
  createIssue(repoFullName: string, title: string, body: string): Promise<GitIssue>;
  createWebhook(repoFullName: string, webhookUrl: string, secret: string): Promise<string>;
  deleteWebhook(repoFullName: string, webhookId: string): Promise<void>;
  handlePushWebhook(payload: unknown): GitPushEvent;
}
```

> The existing `GitHubService` does not need to be refactored in this pass. Implement `GitProviderService` on the new service classes; the interface provides documentation and type safety. A future cleanup pass can retrofit GitHub.

### 1.3 Shared Webhook Verification Utility

**New file:** `apps/api/src/lib/webhook-verify.ts`

Move the existing HMAC verification logic from `routes/webhooks.ts` into a shared utility that also covers the GitLab plain-token and Bitbucket HMAC patterns.

```typescript
import { timingSafeEqual, createHmac } from 'crypto';

/**
 * Verify HMAC-SHA256 webhook signature.
 * Used by GitHub and Bitbucket (header value: 'sha256=<hex>').
 */
export function verifyHmacSha256(payload: Buffer, secret: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Verify GitLab webhook token (plain-text header, timing-safe).
 */
export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(providedToken), Buffer.from(secret));
  } catch {
    return false;
  }
}
```

---

## Phase 2 — GitLab Backend

### 2.1 Environment Variables

**File:** `apps/api/src/lib/config.ts`

Add the following configuration keys:

```typescript
GITLAB_CLIENT_ID: z.string().optional(),
GITLAB_CLIENT_SECRET: z.string().optional(),
// Self-managed instances override this per-integration (stored in config.instanceUrl)
// This env var is used as the default (GitLab.com)
GITLAB_BASE_URL: z.string().default('https://gitlab.com'),
```

Add corresponding entries to `docker-compose.yml` and `.env.example`.

### 2.2 GitLab Service

**New file:** `apps/api/src/services/gitlab.service.ts`

Implement `GitProviderService` for GitLab. Key design decisions:

- Accept `accessToken` and `instanceUrl` as constructor parameters so the same class works for both GitLab.com and self-managed.
- All API calls go to `{instanceUrl}/api/v4/...`.
- Token refresh is handled at the route layer (same pattern as GitHub's `GitHubTokenExpiredError`).

```typescript
export class GitLabTokenExpiredError extends Error {
  constructor() { super('GitLab token expired'); }
}

export class GitLabService implements GitProviderService {
  private baseUrl: string;

  constructor(private accessToken: string, instanceUrl: string) {
    this.baseUrl = `${instanceUrl}/api/v4`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async listRepos(): Promise<GitRepo[]> {
    // GET /api/v4/projects?membership=true&order_by=last_activity_at&per_page=100
    // Handle pagination via X-Next-Page header
  }

  async getFileTree(repoFullName: string, ref: string): Promise<GitTreeEntry[]> {
    // GET /api/v4/projects/{encodedPath}/repository/tree?recursive=true&ref={ref}&per_page=100
    // Encode repoFullName: encodeURIComponent(repoFullName)
  }

  async getFileContent(repoFullName: string, path: string, ref: string): Promise<GitFileContent> {
    // GET /api/v4/projects/{encodedPath}/repository/files/{encodedFilePath}/raw?ref={ref}
    // Returns raw file content (not base64); decode is not needed
  }

  async createIssue(repoFullName: string, title: string, body: string): Promise<GitIssue> {
    // POST /api/v4/projects/{encodedPath}/issues
    // Returns { iid, web_url, title }
  }

  async createWebhook(repoFullName: string, webhookUrl: string, secret: string): Promise<string> {
    // POST /api/v4/projects/{encodedPath}/hooks
    // Body: { url, token: secret, push_events: true, note_events: true, enable_ssl_verification: true }
    // Returns hook ID as string
  }

  async deleteWebhook(repoFullName: string, webhookId: string): Promise<void> {
    // DELETE /api/v4/projects/{encodedPath}/hooks/{webhookId}
  }

  handlePushWebhook(payload: GitLabPushPayload): GitPushEvent {
    return {
      ref: payload.ref,
      repoFullName: payload.project.path_with_namespace,
      commits: payload.commits.map(c => ({
        id: c.id,
        message: c.message,
        timestamp: c.timestamp,
        authorName: c.author.name,
        added: c.added,
        removed: c.removed,
        modified: c.modified,
      })),
    };
  }

  async exchangeCodeForToken(code: string, redirectUri: string, instanceUrl: string) { ... }
  async getAuthenticatedUser() { ... }
}
```

**Error handling:** On any `401` response, throw `GitLabTokenExpiredError`. The route handler catches this and returns `401` to the client with `{ error: 'gitlab_token_expired' }`, mirroring GitHub's pattern.

### 2.3 GitLab OAuth Routes

**File:** `apps/api/src/routes/integrations.ts`

Add two new route handlers following the existing GitHub pattern exactly:

#### `GET /api/integrations/gitlab/connect`

```typescript
server.get('/gitlab/connect', { preHandler: [requireAuth] }, async (request, reply) => {
  const { teamId, instanceUrl: rawInstanceUrl } = request.query as Record<string, string>;
  const instanceUrl = rawInstanceUrl?.trim() || config.GITLAB_BASE_URL;

  const state = await signState({ teamId, instanceUrl }, config.JWT_SECRET);
  const params = new URLSearchParams({
    client_id: config.GITLAB_CLIENT_ID!,
    redirect_uri: `${config.BASE_URL}/api/integrations/gitlab/callback`,
    response_type: 'code',
    scope: 'read_user read_api api read_repository',
    state,
  });
  return reply.redirect(`${instanceUrl}/oauth/authorize?${params}`);
});
```

#### `GET /api/integrations/gitlab/callback`

1. Validate and decode `state` (extracts `teamId` and `instanceUrl`).
2. Exchange `code` for tokens via `GitLabService.exchangeCodeForToken()`.
3. Fetch user info.
4. Generate `webhookSecret` (`randomBytes(32).toString('hex')`).
5. Upsert into `integrations` table with `type='gitlab'`.
6. Redirect to `/settings?gitlabConnected=true`.

### 2.4 GitLab Repo Management Routes

Add the following under the existing `/:id` prefix in `integrations.ts`, mirroring the GitHub repo routes:

| Method | Path | Action |
|---|---|---|
| `GET` | `/:id/gitlab/repos` | List user's GitLab projects |
| `PUT` | `/:id/gitlab/repos` | Save selected repos, register/delete webhooks |
| `GET` | `/:id/gitlab/synced-repos` | Get enriched sync status |
| `DELETE` | `/:id/gitlab/repos/:repoFullPath` | Disconnect a single repo |

**Token refresh middleware:** Before each handler, check `config.tokenExpiresAt`. If within 5 minutes of expiry, call `GitLabService.refreshToken()` and update the stored config before proceeding.

### 2.5 GitLab Webhook Handler

**File:** `apps/api/src/routes/webhooks.ts`

Add `POST /api/webhooks/gitlab`:

```typescript
server.post('/gitlab', async (request, reply) => {
  const rawBody = (request as any).rawBody as Buffer;
  const token = request.headers['x-gitlab-token'] as string;
  const eventType = request.headers['x-gitlab-event'] as string;

  // 1. Find integration by matching webhook secret
  const integration = await findIntegrationByWebhookSecret('gitlab', token);
  if (!integration) return reply.code(401).send({ error: 'invalid_token' });

  if (!verifyGitLabToken(token, integration.config.webhookSecret)) {
    return reply.code(401).send({ error: 'invalid_token' });
  }

  // 2. Dispatch event (fire-and-forget, same pattern as GitHub)
  if (eventType === 'Push Hook') {
    handleGitLabPush(integration, request.body as GitLabPushPayload).catch(console.error);
  }
  // Note Hook (comments) for future Claude insights expansion

  return reply.code(200).send({ ok: true });
});
```

`handleGitLabPush` follows the exact same logic as `handleGitHubPush` in the existing webhook handler: parse the push event, run drift detection for matching documents, record `code_push` timeline events.

### 2.6 Token Refresh for GitLab

**New helper:** `apps/api/src/lib/gitlab-token-refresh.ts`

```typescript
export async function refreshGitLabTokenIfNeeded(integration: Integration): Promise<Integration> {
  const config = integration.config as GitLabIntegrationConfig;
  if (config.authType === 'pat') return integration; // PATs don't expire
  if (!config.refreshToken) return integration;

  const expiresAt = new Date(config.tokenExpiresAt ?? 0);
  const needsRefresh = Date.now() > expiresAt.getTime() - 5 * 60 * 1000;
  if (!needsRefresh) return integration;

  const response = await fetch(`${config.instanceUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: env.GITLAB_CLIENT_ID!,
      client_secret: env.GITLAB_CLIENT_SECRET!,
    }),
  });
  if (!response.ok) throw new GitLabTokenExpiredError();

  const { access_token, refresh_token, expires_in } = await response.json();
  const updatedConfig = {
    ...config,
    accessToken: access_token,
    refreshToken: refresh_token,
    tokenExpiresAt: new Date(Date.now() + expires_in * 1000).toISOString(),
  };
  return await db.update(integrations).set({ config: updatedConfig })
    .where(eq(integrations.id, integration.id))
    .returning()
    .then(rows => rows[0]);
}
```

---

## Phase 3 — Bitbucket Backend

Phase 3 mirrors Phase 2 exactly, substituting Bitbucket's API conventions. Key differences from GitLab are noted.

### 3.1 Environment Variables

**File:** `apps/api/src/lib/config.ts`

```typescript
BITBUCKET_CLIENT_ID: z.string().optional(),
BITBUCKET_CLIENT_SECRET: z.string().optional(),
// Bitbucket Data Center instances override per-integration
BITBUCKET_BASE_URL: z.string().default('https://bitbucket.org'),
```

### 3.2 Bitbucket Service

**New file:** `apps/api/src/services/bitbucket.service.ts`

Key differences from GitLab:

- **API base:** `https://api.bitbucket.org/2.0` for Cloud; `{instanceUrl}/rest/api/1.0` for Data Center.
- **Repo identifier:** `workspace/repo_slug` (not project path).
- **File tree:** The `/src` endpoint returns paginated results; Nyx must follow `next` links.
- **File content:** Returns raw content directly (same as GitLab raw endpoint).
- **Changed files in push webhook:** Not included in the payload — requires a diff fetch via `GET /2.0/repositories/{workspace}/{repo}/diffstat/{commit}`.
- **Webhook signature:** HMAC-SHA256, same format as GitHub (`sha256=...` in `X-Hub-Signature`). Use the shared `verifyHmacSha256` from Phase 1.
- **Workspace concept:** Users may belong to multiple Bitbucket workspaces. `listRepos()` must iterate all workspaces and aggregate results.

```typescript
export class BitbucketTokenExpiredError extends Error {
  constructor() { super('Bitbucket token expired'); }
}

export class BitbucketService implements GitProviderService {
  private apiBase: string;

  constructor(private accessToken: string, instanceUrl: string) {
    // Cloud: https://api.bitbucket.org/2.0
    // DC: {instanceUrl}/rest/api/1.0 (different path structure)
    this.apiBase = instanceUrl === 'https://bitbucket.org'
      ? 'https://api.bitbucket.org/2.0'
      : `${instanceUrl}/rest/api/1.0`;
  }

  async listRepos(): Promise<GitRepo[]> {
    // 1. GET /2.0/workspaces → get workspace slugs
    // 2. For each workspace: GET /2.0/repositories/{workspace}?role=member&pagelen=100
    // 3. Follow 'next' pagination links
  }

  async getFileTree(repoFullName: string, ref: string): Promise<GitTreeEntry[]> {
    // GET /2.0/repositories/{workspace}/{repo}/src/{ref}/?pagelen=100&max_depth=10
    // Follow 'next' pagination. Filter type='commit_file' for blobs.
  }

  async getFileContent(repoFullName: string, path: string, ref: string): Promise<GitFileContent> {
    // GET /2.0/repositories/{workspace}/{repo}/src/{ref}/{path}
    // Returns raw text content
  }

  async getDiffStat(repoFullName: string, commit: string): Promise<Array<{status: string, path: string}>> {
    // GET /2.0/repositories/{workspace}/{repo}/diffstat/{commit}
    // Maps status: 'added'|'removed'|'modified'
  }

  handlePushWebhook(payload: BitbucketPushPayload): GitPushEvent {
    // Note: changed files are NOT in the payload. Set added/removed/modified to []
    // and let the caller fetch diffstat separately if needed.
    const change = payload.push.changes[0];
    return {
      ref: `refs/heads/${change?.new?.name ?? 'unknown'}`,
      repoFullName: payload.repository.full_name,
      commits: (change?.commits ?? []).map(c => ({
        id: c.hash,
        message: c.message,
        timestamp: c.date,
        authorName: c.author.raw,
        added: [], removed: [], modified: [],
      })),
    };
  }
  // ... createIssue, createWebhook, deleteWebhook, exchangeCodeForToken, etc.
}
```

**Diffstat enrichment:** In `handleBitbucketPush()` (the route-level handler), after parsing the push event, fetch the diffstat for the head commit and merge the file lists into the commit object before passing to drift detection. This keeps the diffstat fetch lazy (only when drift detection will actually run).

### 3.3 Bitbucket OAuth Routes

Add to `integrations.ts`:

#### `GET /api/integrations/bitbucket/connect`

```typescript
// instanceUrl query param for Data Center instances (optional)
const state = await signState({ teamId, instanceUrl }, config.JWT_SECRET);
const params = new URLSearchParams({
  client_id: config.BITBUCKET_CLIENT_ID!,
  response_type: 'code',
  state,
});
return reply.redirect(`${instanceUrl}/site/oauth2/authorize?${params}`);
```

#### `GET /api/integrations/bitbucket/callback`

Same structure as GitLab callback. Token exchange uses Basic auth:

```
POST https://bitbucket.org/site/oauth2/access_token
Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=...&redirect_uri=...
```

### 3.4 Bitbucket Repo Management Routes

Identical structure to GitLab routes:

| Method | Path | Action |
|---|---|---|
| `GET` | `/:id/bitbucket/repos` | List workspace repositories |
| `PUT` | `/:id/bitbucket/repos` | Save selection, register/delete webhooks |
| `GET` | `/:id/bitbucket/synced-repos` | Get enriched sync status |
| `DELETE` | `/:id/bitbucket/repos/:repoFullName` | Disconnect repo |

### 3.5 Bitbucket Webhook Handler

**File:** `apps/api/src/routes/webhooks.ts`

Add `POST /api/webhooks/bitbucket`:

```typescript
server.post('/bitbucket', async (request, reply) => {
  const rawBody = (request as any).rawBody as Buffer;
  const signature = request.headers['x-hub-signature'] as string;
  const eventKey = request.headers['x-event-key'] as string;

  // Find integration by attempting HMAC verification against all active Bitbucket integrations
  // (same lookup strategy as GitHub)
  const integration = await findIntegrationByHmac('bitbucket', rawBody, signature);
  if (!integration) return reply.code(401).send({ error: 'invalid_signature' });

  if (eventKey === 'repo:push') {
    handleBitbucketPush(integration, request.body as BitbucketPushPayload).catch(console.error);
  }

  return reply.code(200).send({ ok: true });
});
```

**Integration lookup strategy:** To avoid brute-force HMAC checks across all integrations, the webhook URL can include the integration ID as a path segment: `/api/webhooks/bitbucket/{integrationId}`. This is the same approach used by GitHub — the integration ID is embedded in the webhook URL at registration time, making lookup O(1).

### 3.6 Bitbucket Token Refresh

Same structure as `gitlab-token-refresh.ts` but using the Bitbucket token endpoint with Basic auth. Extract into `apps/api/src/lib/bitbucket-token-refresh.ts`.

---

## Phase 4 — Frontend

### 4.1 API Client Functions

**File:** `apps/web/src/lib/api.ts`

Add functions mirroring the existing GitHub helpers:

```typescript
// GitLab
export async function fetchGitLabRepos(integrationId: string): Promise<GitLabRepo[]>
export async function saveSelectedGitLabRepos(integrationId: string, repos: GitLabRepo[]): Promise<void>
export async function fetchSyncedGitLabRepos(integrationId: string): Promise<SyncedRepo[]>
export async function disconnectGitLabRepo(integrationId: string, repoFullPath: string): Promise<void>

// Bitbucket
export async function fetchBitbucketRepos(integrationId: string): Promise<BitbucketRepo[]>
export async function saveSelectedBitbucketRepos(integrationId: string, repos: BitbucketRepo[]): Promise<void>
export async function fetchSyncedBitbucketRepos(integrationId: string): Promise<SyncedRepo[]>
export async function disconnectBitbucketRepo(integrationId: string, repoFullName: string): Promise<void>
```

Both `GitLabTokenExpiredError` and `BitbucketTokenExpiredError` should be defined alongside `GitHubTokenExpiredError` and caught at the API call site to trigger the re-authorization prompt.

### 4.2 Provider-Agnostic Repo Selector

**File:** `apps/web/src/components/RepoSelector.tsx` (extend existing or parameterize)

The current `RepoSelector` component is GitHub-specific. Refactor it to accept a `provider` prop and call the appropriate API functions:

```typescript
interface RepoSelectorProps {
  provider: 'github' | 'gitlab' | 'bitbucket';
  integrationId: string;
  onSave: () => void;
}
```

Internally, the component maps `provider` → API functions. The rendered UI is identical across providers.

If a full refactor introduces risk, an alternative is to create `GitLabRepoSelector` and `BitbucketRepoSelector` as thin wrappers that share the same JSX structure, passing different API functions. Choose the simpler path.

### 4.3 Integration Settings UI

**File:** `apps/web/src/pages/Repositories.tsx` (or the Settings/Integrations page)

Add integration cards for GitLab and Bitbucket alongside the existing GitHub card. Each card:

- Shows provider logo and name.
- Displays connection status (green/yellow/gray dot).
- Shows connected username and instance URL (if self-managed).
- Has a **Connect** / **Re-authorize** / **Disconnect** button.

**Self-managed instance modal:**

For GitLab and Bitbucket, the Connect button opens a small modal before redirecting:

```
┌─────────────────────────────────────────────┐
│  Connect GitLab                             │
│                                             │
│  Instance URL                               │
│  [ https://gitlab.com                     ] │
│  Leave as-is for GitLab.com. Change for     │
│  self-managed instances.                    │
│                                             │
│  [ Cancel ]          [ Connect with OAuth ] │
└─────────────────────────────────────────────┘
```

On submit, redirect to `/api/integrations/gitlab/connect?teamId={teamId}&instanceUrl={encodedUrl}`.

### 4.4 Repositories Page Updates

The `Repositories.tsx` page shows synced repos from the connected GitHub integration. Extend it to show GitLab and Bitbucket repos in separate sections (or a tabbed view if the team has multiple providers connected).

```typescript
// Tab labels
const PROVIDER_LABELS = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
} as const;
```

The per-repo `SyncStatus` component and `ConnectRepoModal` are already provider-agnostic in structure and need only minor label changes.

### 4.5 TypeScript Types

**New file:** `apps/web/src/types/integrations.ts`

Define shared types for the frontend:

```typescript
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

export interface SyncedRepo {
  name: string;
  fullName: string;
  webUrl: string;
  defaultBranch: string;
  syncStatus: 'active' | 'disconnected';
  lastPushAt: string | null;
  linkedDocCount: number;
  provider: GitProvider;
}
```

---

## Testing Plan

### Unit Tests (Vitest)

**New files:**

- `apps/api/src/services/gitlab.service.test.ts` — unit tests for `GitLabService` with mocked fetch responses.
- `apps/api/src/services/bitbucket.service.test.ts` — unit tests for `BitbucketService`.
- `apps/api/src/lib/webhook-verify.test.ts` — unit tests for `verifyHmacSha256` and `verifyGitLabToken`.

Key cases to cover:
- Correct API URL construction (especially path encoding for GitLab project IDs).
- Pagination handling in `listRepos()` and `getFileTree()`.
- `GitLabTokenExpiredError` / `BitbucketTokenExpiredError` thrown on `401` responses.
- `handlePushWebhook()` correctly parses each provider's payload format.
- `verifyGitLabToken()` rejects mismatched secrets without timing side-channels.
- `verifyHmacSha256()` rejects tampered signatures.

### E2E Tests (Playwright)

**New file:** `e2e/gitlab-bitbucket-integrations.spec.ts`

Implement the test cases listed in the feature doc using the `authenticatedPage` fixture. Mock all provider API responses with Playwright's `page.route()` to intercept:
- `**/gitlab.com/oauth/authorize**` — validate redirect params
- `**/api.bitbucket.org/2.0/**` — return fixture data
- `**/api/webhooks/gitlab**` and `**/api/webhooks/bitbucket**` — test webhook validation

Follow the existing E2E pattern for timing: use `waitFor({ state: 'visible' })` for UI state changes and `page.waitForResponse()` for API calls.

### Manual QA Checklist

Before shipping each phase:

**Phase 2 (GitLab):**
- [ ] Connect to GitLab.com via OAuth — tokens stored, UI shows connected.
- [ ] Connect to a self-managed GitLab instance — instance URL saved, OAuth flow uses correct base URL.
- [ ] Connect via PAT — no OAuth redirect, connected state shown.
- [ ] Select repos — webhooks registered in GitLab.
- [ ] Deselect repos — webhooks deleted from GitLab.
- [ ] Simulate a push webhook — drift detection fires for documents linked to the repo.
- [ ] Disconnect integration — webhooks cleaned up, integration row deleted.

**Phase 3 (Bitbucket):**
- [ ] Connect to Bitbucket Cloud — tokens stored, workspace slug saved.
- [ ] Multi-workspace repo selector — repos from all workspaces shown.
- [ ] Select repos — webhooks registered.
- [ ] Simulate a push webhook with diffstat fetch — drift detection fires.

**Phase 4 (Frontend):**
- [ ] GitLab card shows in Integrations settings.
- [ ] Bitbucket card shows in Integrations settings.
- [ ] Self-managed instance modal works for both providers.
- [ ] Repositories page tabs/sections show repos from all connected providers.
- [ ] Token expiry banner shown for expired GitLab/Bitbucket tokens.

---

## Rollout & Feature Flags

Introduce a `ENABLE_GITLAB_INTEGRATION` and `ENABLE_BITBUCKET_INTEGRATION` environment variable (boolean, default `false`) to gate the new routes and UI at the infrastructure level. This allows the feature to be deployed to production before being enabled for users, enabling a gradual rollout.

```typescript
// config.ts
ENABLE_GITLAB_INTEGRATION: z.coerce.boolean().default(false),
ENABLE_BITBUCKET_INTEGRATION: z.coerce.boolean().default(false),
```

The frontend reads these flags via a `/api/config` endpoint (or environment injection at build time) and conditionally renders the provider cards.

Remove the flags once the integrations are stable (typically after 1–2 weeks of production traffic).

---

## File Inventory

### New Files

| File | Purpose |
|---|---|
| `apps/api/src/services/git-provider.interface.ts` | Shared provider interface |
| `apps/api/src/services/gitlab.service.ts` | GitLab API service |
| `apps/api/src/services/bitbucket.service.ts` | Bitbucket API service |
| `apps/api/src/lib/webhook-verify.ts` | Shared webhook verification utilities |
| `apps/api/src/lib/gitlab-token-refresh.ts` | GitLab token refresh helper |
| `apps/api/src/lib/bitbucket-token-refresh.ts` | Bitbucket token refresh helper |
| `apps/api/src/services/gitlab.service.test.ts` | GitLab service unit tests |
| `apps/api/src/services/bitbucket.service.test.ts` | Bitbucket service unit tests |
| `apps/api/src/lib/webhook-verify.test.ts` | Webhook verification unit tests |
| `e2e/gitlab-bitbucket-integrations.spec.ts` | E2E test spec |
| `apps/web/src/types/integrations.ts` | Shared frontend types |

### Modified Files

| File | Change |
|---|---|
| `apps/api/src/db/schema.ts` | Extend `integrationTypeEnum`, `ticketProviderEnum` |
| `apps/api/src/lib/config.ts` | Add `GITLAB_*`, `BITBUCKET_*`, feature flag env vars |
| `apps/api/src/routes/integrations.ts` | Add GitLab and Bitbucket OAuth and repo routes |
| `apps/api/src/routes/webhooks.ts` | Add GitLab and Bitbucket webhook handlers; extract to `webhook-verify.ts` |
| `apps/web/src/lib/api.ts` | Add GitLab and Bitbucket API client functions |
| `apps/web/src/pages/Repositories.tsx` | Add multi-provider sections/tabs |
| `docker-compose.yml` | Add new environment variables |
| `apps/api/drizzle/` | New migration for enum changes |

---

## Open Questions

1. **Webhook URL strategy:** Should the webhook URL embed the integration ID (e.g., `/api/webhooks/gitlab/{integrationId}`) to make lookup O(1)? This is the cleanest approach but requires updating registered webhooks if the integration ID ever changes (it shouldn't for UUID PKs). Recommend: yes, embed the integration ID.

2. **Bitbucket Data Center API version:** The DC REST API (`/rest/api/1.0`) has different endpoint paths from Cloud (`/2.0`). The `BitbucketService` constructor should branch on this. Confirm whether Bitbucket DC webhook signature verification uses the same `X-Hub-Signature` header as Cloud.

3. **GitLab group-level webhooks:** For organizations using GitLab groups, it may be preferable to register a single group-level webhook rather than per-project webhooks. This requires `owner` scope on the group. Defer to Phase 2 follow-up unless specifically requested.

4. **Encryption key:** Confirm that the same `ENCRYPTION_SECRET` used for Atlassian tokens will be used for GitLab/Bitbucket tokens, or if a separate key is desired.

5. **Self-managed SSL certificate handling:** For self-managed instances with self-signed certs, Nyx's `fetch` calls will fail by default. This requires either a custom `https.Agent` with `rejectUnauthorized: false` (discouraged in production) or a configurable CA certificate path per integration.
