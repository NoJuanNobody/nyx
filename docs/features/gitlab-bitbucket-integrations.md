# GitLab & Bitbucket Integrations

## Overview

Nyx integrates with GitLab and Bitbucket as first-class Git hosting platforms alongside the existing GitHub integration. Teams that host their code on GitLab (cloud or self-hosted) or Bitbucket (Cloud or Data Center/Server) can connect their repositories to Nyx and get the full suite of features: doc-code drift detection, automatic version syncing, webhook-driven timeline events, and ticket creation.

Both integrations follow the same patterns established by the GitHub integration: OAuth 2.0 for authentication, per-integration webhook secrets, a service class that encapsulates all API calls, and JSONB config storage in the `integrations` table.

---

## Supported Variants

### GitLab

| Variant | Base URL | Notes |
|---|---|---|
| GitLab.com (SaaS) | `https://gitlab.com` | Standard OAuth app registration |
| Self-Managed (CE/EE) | Configurable per team | Requires instance URL at connect time |

### Bitbucket

| Variant | Base URL | Notes |
|---|---|---|
| Bitbucket Cloud | `https://bitbucket.org` | OAuth 2.0 via Atlassian identity |
| Bitbucket Data Center / Server | Configurable per team | OAuth 2.0 or Personal Access Token |

---

## Authentication

### GitLab OAuth 2.0

GitLab uses a standard authorization code grant. Self-managed instances share the same flow but with a user-supplied base URL instead of `https://gitlab.com`.

#### OAuth App Registration

Teams using GitLab.com connect via Nyx's registered GitLab OAuth application. Teams using self-managed GitLab must register their own application in their instance (`Settings > Applications`) and supply the Client ID and Secret to Nyx.

#### Required Scopes

| Scope | Purpose |
|---|---|
| `read_user` | Fetch the authenticated user's profile |
| `read_api` | Read repository content, branches, and tree |
| `api` | Create webhooks, read/write issues |
| `read_repository` | Clone access for file content reads |

> For self-managed deployments with restricted scope policies, `api` can substitute all narrower scopes.

#### Authorization Flow

```
GET {GITLAB_BASE_URL}/oauth/authorize
  ?client_id={GITLAB_CLIENT_ID}
  &redirect_uri={BASE_URL}/api/integrations/gitlab/callback
  &response_type=code
  &state={CSRF_STATE_TOKEN}
  &scope=read_user read_api api read_repository
```

#### Callback Handler

1. Validate the `state` parameter (HMAC-SHA256, same as GitHub).
2. Exchange `code` for tokens:
   ```
   POST {GITLAB_BASE_URL}/oauth/token
   Content-Type: application/x-www-form-urlencoded

   client_id=...&client_secret=...&code=...
   &grant_type=authorization_code
   &redirect_uri=...
   ```
3. Fetch the authenticated user: `GET {GITLAB_BASE_URL}/api/v4/user`.
4. Store tokens and instance URL in `integrations.config` (see Token Storage).
5. Redirect to the Nyx settings page.

#### Token Refresh

GitLab access tokens expire after 2 hours when issued via OAuth. Nyx refreshes proactively with a 5-minute buffer:

```
POST {GITLAB_BASE_URL}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token={STORED_REFRESH_TOKEN}
&client_id=...&client_secret=...
```

A `401` or failed refresh marks the integration as `disconnected` and prompts the user to re-authorize.

#### Personal Access Tokens (Self-Managed Fallback)

Self-managed GitLab instances may disable OAuth apps. In this case, Nyx accepts a GitLab Personal Access Token (PAT) with the same scopes. The PAT is stored in `config.accessToken` and no refresh flow is needed (PATs do not expire unless configured to by the admin).

---

### Bitbucket Cloud OAuth 2.0

Bitbucket Cloud uses Atlassian's identity platform for OAuth 2.0.

#### Required Scopes

| Scope | Purpose |
|---|---|
| `account` | Read user profile information |
| `repository` | Read repositories and file contents |
| `repository:admin` | Create and manage webhooks |
| `issue:write` | Create issues in connected repositories |
| `pullrequest` | Read pull request information |

#### Authorization Flow

```
GET https://bitbucket.org/site/oauth2/authorize
  ?client_id={BITBUCKET_CLIENT_ID}
  &response_type=code
  &state={CSRF_STATE_TOKEN}
```

#### Callback Handler

1. Validate `state` (HMAC-SHA256).
2. Exchange `code` for tokens:
   ```
   POST https://bitbucket.org/site/oauth2/access_token
   Content-Type: application/x-www-form-urlencoded
   Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)

   grant_type=authorization_code&code=...
   &redirect_uri={BASE_URL}/api/integrations/bitbucket/callback
   ```
3. Fetch the authenticated user: `GET https://api.bitbucket.org/2.0/user`.
4. Store tokens and workspace metadata in `integrations.config`.
5. Redirect to Nyx settings.

#### Token Refresh

Bitbucket Cloud access tokens expire after 1 hour. Refresh using the same endpoint:

```
POST https://bitbucket.org/site/oauth2/access_token
Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)

grant_type=refresh_token&refresh_token={STORED_REFRESH_TOKEN}
```

#### Bitbucket Data Center / Server (PAT)

Bitbucket Data Center (self-hosted) supports OAuth 2.0 with a registered application, or HTTP Basic Auth via Personal Access Tokens. Nyx supports PAT-based auth for Data Center, stored in `config.accessToken`. Webhook creation uses the same REST API as Cloud.

---

## Token Storage

Both integrations extend the existing `integrations` table's JSONB `config` field. No new tables are required.

### GitLab `config` Shape

```typescript
interface GitLabIntegrationConfig {
  accessToken: string;          // OAuth access token (or PAT)
  refreshToken?: string;        // Absent for PAT-based auth
  tokenExpiresAt?: string;      // ISO 8601 timestamp
  instanceUrl: string;          // 'https://gitlab.com' or self-managed base URL
  gitlabUserId: number;         // GitLab numeric user ID
  gitlabUsername: string;
  avatarUrl: string;
  scopes: string[];
  authType: 'oauth' | 'pat';
  selectedRepos: GitLabSelectedRepo[];
  webhookSecret: string;
  webhookIds: Record<string, number>; // repoFullPath → webhook ID
}

interface GitLabSelectedRepo {
  id: number;
  name: string;
  fullPath: string;    // e.g. 'mygroup/myrepo'
  defaultBranch: string;
  webUrl: string;
}
```

### Bitbucket `config` Shape

```typescript
interface BitbucketIntegrationConfig {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  instanceUrl: string;           // 'https://bitbucket.org' or Data Center URL
  workspaceSlug: string;
  bitbucketAccountId: string;
  bitbucketUsername: string;
  avatarUrl: string;
  scopes: string[];
  authType: 'oauth' | 'pat';
  selectedRepos: BitbucketSelectedRepo[];
  webhookSecret: string;
  webhookIds: Record<string, string>; // repoFullName → webhook UUID
}

interface BitbucketSelectedRepo {
  uuid: string;
  name: string;
  fullName: string;   // e.g. 'workspace/repo'
  mainBranch: string;
  links: { html: { href: string } };
}
```

All tokens are encrypted at rest using AES-256-GCM with the `ENCRYPTION_SECRET` environment variable before being stored in the database.

---

## Repository Connection

After OAuth authentication, users select which repositories to connect to Nyx.

### GitLab

- `GET /api/v4/projects?membership=true&order_by=last_activity_at` — list all projects the user is a member of.
- For self-managed instances, the same endpoint is used against `{instanceUrl}/api/v4`.
- Supports both personal projects and group projects.
- Projects are identified by their numeric `id` and `path_with_namespace` (equivalent to GitHub's `full_name`).

### Bitbucket

- `GET https://api.bitbucket.org/2.0/repositories/{workspace}?role=member` — list repositories in the workspace.
- Nyx fetches all workspaces the user belongs to via `GET /2.0/workspaces` and allows selection across multiple workspaces.
- Repositories are identified by `full_name` (`workspace/slug`).

### Webhook Registration on Selection

When a user saves their repo selection, Nyx immediately registers a push webhook for each newly selected repo and deletes webhooks for any deselected repos.

#### GitLab Webhook Registration

```
POST {GITLAB_BASE_URL}/api/v4/projects/{id}/hooks
Authorization: Bearer {ACCESS_TOKEN}

{
  "url": "{WEBHOOK_BASE_URL}/api/webhooks/gitlab",
  "token": "{PER_INTEGRATION_WEBHOOK_SECRET}",
  "push_events": true,
  "note_events": true,
  "enable_ssl_verification": true
}
```

#### Bitbucket Webhook Registration

```
POST https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}/hooks
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "description": "Nyx drift detection",
  "url": "{WEBHOOK_BASE_URL}/api/webhooks/bitbucket",
  "active": true,
  "secret": "{PER_INTEGRATION_WEBHOOK_SECRET}",
  "events": ["repo:push", "issue:comment_created"]
}
```

---

## Webhook Handling

### GitLab Push Webhooks

**Endpoint:** `POST /api/webhooks/gitlab`

**Signature Verification:**

GitLab sends the webhook secret in the `X-Gitlab-Token` header as a plain-text value (not HMAC). Nyx performs a timing-safe string comparison against the stored per-integration secret.

```typescript
const providedToken = request.headers['x-gitlab-token'];
const isValid = timingSafeEqual(
  Buffer.from(providedToken),
  Buffer.from(integration.config.webhookSecret),
);
```

**Supported Events:**

| GitLab Event Header (`X-Gitlab-Event`) | Action |
|---|---|
| `Push Hook` | Trigger drift detection, record `code_push` timeline event |
| `Note Hook` | Process comments for Claude insights (same as GitHub `issue_comment`) |

**Push Payload Extraction:**

```typescript
interface GitLabPushPayload {
  ref: string;                    // e.g. 'refs/heads/main'
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  project: {
    id: number;
    path_with_namespace: string;
  };
}
```

---

### Bitbucket Push Webhooks

**Endpoint:** `POST /api/webhooks/bitbucket`

**Signature Verification:**

Bitbucket Cloud signs the payload with HMAC-SHA256 using the webhook secret. The signature is in the `X-Hub-Signature` header (same format as GitHub's `X-Hub-Signature-256` but using SHA-256). Nyx verifies using a timing-safe comparison.

> **Note:** Bitbucket Data Center uses `X-Hub-Signature` with HMAC-SHA256 as well, making the verification logic identical.

**Supported Events:**

| Bitbucket Event (`X-Event-Key`) | Action |
|---|---|
| `repo:push` | Trigger drift detection, record `code_push` timeline event |
| `issue:comment_created` | Process comments for Claude insights |

**Push Payload Extraction:**

```typescript
interface BitbucketPushPayload {
  push: {
    changes: Array<{
      new: { name: string; type: 'branch' } | null;
      commits: Array<{
        hash: string;
        message: string;
        date: string;
        author: { raw: string };
      }>;
      diff_stat?: Array<{
        status: 'added' | 'removed' | 'modified';
        path: string;
      }>;
    }>;
  };
  repository: {
    full_name: string;
  };
}
```

> Bitbucket push webhooks do not include changed file lists in the base payload. Nyx fetches the diff via `GET /2.0/repositories/{workspace}/{repo}/diffstat/{commit}` for the head commit of each change.

---

## Documentation Syncing & Drift Detection

Once a repository is connected and a webhook fires, Nyx runs the same drift detection pipeline as with GitHub. The `ai.service.ts` `detectDrift()` method is provider-agnostic — it receives file content strings regardless of source platform. The provider-specific work is fetching those file contents.

### File Content Retrieval

#### GitLab

```
GET {GITLAB_BASE_URL}/api/v4/projects/{id}/repository/files/{encoded_path}/raw
  ?ref={COMMIT_SHA}
Authorization: Bearer {ACCESS_TOKEN}
```

#### Bitbucket

```
GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/src/{commit}/{path}
Authorization: Bearer {ACCESS_TOKEN}
```

### File Tree Retrieval

#### GitLab

```
GET {GITLAB_BASE_URL}/api/v4/projects/{id}/repository/tree
  ?recursive=true&ref={BRANCH}
Authorization: Bearer {ACCESS_TOKEN}
```

#### Bitbucket

```
GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/src/{branch}/?pagelen=100&max_depth=10
Authorization: Bearer {ACCESS_TOKEN}
```

---

## Issue / Ticket Creation

Both platforms support creating issues from Nyx spec sections, following the same pattern as GitHub Issues.

### GitLab Issues

```
POST {GITLAB_BASE_URL}/api/v4/projects/{id}/issues
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "title": "{SECTION_TITLE}",
  "description": "{SECTION_BODY}\n\n---\n_Linked spec: {NYX_DOC_URL}_",
  "labels": ["{SPEC_NAME}"],
  "assignee_ids": [{GITLAB_USER_ID}]
}
```

The GitLab issue `iid` (project-scoped number) and `web_url` are stored in the `tickets` table alongside `provider='gitlab'`.

### Bitbucket Issues

> Bitbucket issues are only available for repositories with Issues enabled (not all repos have this feature active). Nyx checks the repository metadata and surfaces a warning if the repo's issue tracker is disabled.

```
POST https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/issues
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "title": "{SECTION_TITLE}",
  "content": { "raw": "{SECTION_BODY}\n\n---\n_Linked spec: {NYX_DOC_URL}_" },
  "kind": "task",
  "priority": "normal"
}
```

The Bitbucket issue `id` and `links.html.href` are stored with `provider='bitbucket'`.

---

## Branch & Version Management

### Default Branch Detection

- **GitLab:** `project.default_branch` from the project metadata response.
- **Bitbucket:** `repository.mainbranch.name` from the repository resource.

Both are stored in the `selectedRepos` config array and used when fetching file trees for the onboarding codebase scan.

### Branch Listing

Used in the Nyx UI to let users select which branches to monitor for drift:

- **GitLab:** `GET /api/v4/projects/{id}/repository/branches`
- **Bitbucket:** `GET /2.0/repositories/{workspace}/{repo}/refs/branches`

### Webhook Branch Filtering

Drift detection runs only when the push targets a monitored branch (configurable per repo, defaults to the default branch). The `ref` field in the push payload is compared against the monitored branch list before triggering drift analysis.

---

## Settings UI

### Connection Flow

The UI follows the same pattern as the GitHub integration in `apps/web/src/pages/Repositories.tsx`.

1. **Settings > Integrations** shows cards for GitHub, GitLab, and Bitbucket.
2. Each card has a **Connect** button that initiates the OAuth flow.
3. For self-managed instances, clicking Connect opens a modal prompting for the instance base URL before redirecting to OAuth.
4. After auth, the user sees a repo selector (same `RepoSelector` component, parameterized by provider).

### Connection Status Indicators

| State | Indicator |
|---|---|
| Connected | Green dot, username, instance URL (if self-managed) |
| Token expired / PAT revoked | Yellow dot, "Re-authorize" |
| Disconnected | Gray dot, "Connect" button |
| Error (e.g., webhook failure) | Red dot with error message |

### Self-Managed Instance Configuration

A secondary settings panel appears for GitLab and Bitbucket Data Center connections, showing:

- **Instance URL** — editable after connection (triggers re-authentication)
- **Auth type** — OAuth or PAT
- **SSL verification** — toggle (for instances with self-signed certificates; default on)

### Sync Status

The `SyncedRepos` view shows per-repo sync status identical to the GitHub experience:
- Last push date
- Active webhook indicator
- Linked document count
- Drift score if a recent push triggered analysis

---

## Security Considerations

### Webhook Secret per Integration

Each integration record gets its own randomly generated `webhookSecret` (32 bytes, hex-encoded). This prevents a compromised secret from affecting other teams or integrations.

### Signature Verification Summary

| Platform | Header | Algorithm |
|---|---|---|
| GitHub | `X-Hub-Signature-256` | HMAC-SHA256 (hex) |
| GitLab | `X-Gitlab-Token` | Plain text (timing-safe compare) |
| Bitbucket Cloud | `X-Hub-Signature` | HMAC-SHA256 (sha256=...) |
| Bitbucket DC | `X-Hub-Signature` | HMAC-SHA256 (sha256=...) |

### Token Encryption

OAuth tokens and PATs are encrypted with AES-256-GCM before persistence (same `ENCRYPTION_SECRET` as used for Atlassian tokens). The IV is stored alongside the ciphertext.

### Scope Minimization

- GitLab: `read_api` + `api` are broad; document that Nyx uses only the endpoints listed in this spec and does not perform write operations on the repository itself (only issues and webhooks).
- Bitbucket: `repository:admin` is requested solely for webhook management; all other access uses `repository`.

### Self-Managed SSL

For self-managed instances, SSL verification is enabled by default. Teams may disable it for internal instances with self-signed certificates via the settings panel, but Nyx logs a warning to the audit trail when SSL verification is disabled.

### Rate Limits

| Platform | Limit | Nyx Handling |
|---|---|---|
| GitLab.com | 2,000 req/min per user | Exponential backoff + `Retry-After` header |
| GitLab Self-Managed | Admin-configurable | Same backoff strategy |
| Bitbucket Cloud | 1,000 req/hour per user | Exponential backoff + `Retry-After` header |
| Bitbucket DC | Unlimited by default | Standard backoff on `429` |

---

## E2E Test Spec

Tests follow the established pattern in `e2e/` using the `authenticatedPage` fixture with mocked provider API responses.

### GitLab OAuth Tests

| Test | Assertion |
|---|---|
| Connect (GitLab.com) redirects correctly | Clicking Connect navigates to `gitlab.com/oauth/authorize` with correct `client_id`, `scope`, `state`, and `redirect_uri`. |
| Connect (self-managed) prompts for instance URL | A modal collects the instance URL before redirecting to `{instanceUrl}/oauth/authorize`. |
| Callback stores tokens | Simulated callback with valid `code` and `state` stores tokens and shows connected state. |
| Invalid state rejected | Callback with mismatched `state` returns `400` and no tokens are stored. |
| Token refresh transparent | API call with expired token triggers refresh and completes the operation. |
| PAT auth connects without OAuth | Submitting a valid PAT stores it and shows connected state without an OAuth redirect. |

### Bitbucket OAuth Tests

| Test | Assertion |
|---|---|
| Connect redirects correctly | Clicking Connect navigates to `bitbucket.org/site/oauth2/authorize` with correct params. |
| Callback stores tokens and workspace | Simulated callback stores tokens and the workspace slug. |
| Multi-workspace selection | User can select repos from multiple workspaces they belong to. |

### Webhook Tests

| Test | Assertion |
|---|---|
| GitLab push triggers drift detection | POST to `/api/webhooks/gitlab` with valid `X-Gitlab-Token` fires drift check; invalid token returns `401`. |
| Bitbucket push triggers drift detection | POST to `/api/webhooks/bitbucket` with valid `X-Hub-Signature` fires drift check; invalid signature returns `401`. |
| Push to non-monitored branch skipped | A push to a branch not in the monitored list does not trigger drift detection. |

### Repository Management Tests

| Test | Assertion |
|---|---|
| GitLab repo list loads | After connecting, the repo selector shows the user's GitLab projects. |
| Repo selection registers webhook | Saving a GitLab/Bitbucket repo selection calls the respective webhook registration endpoint. |
| Repo deselection deletes webhook | Removing a repo from the selection deletes the corresponding webhook. |
| Disconnect removes integration | Clicking Disconnect deletes the integration row and revokes webhooks. |
