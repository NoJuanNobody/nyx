# Atlassian Integration: Feature Doc & Implementation Plan

## Table of Contents

1. [Overview](#1-overview)
2. [Current State](#2-current-state)
3. [Architecture](#3-architecture)
4. [External Setup (Prerequisites)](#4-external-setup-prerequisites)
5. [Implementation Plan](#5-implementation-plan)
   - [Phase 1 — Production Hardening](#phase-1--production-hardening)
   - [Phase 2 — Webhook Automation & Validation](#phase-2--webhook-automation--validation)
   - [Phase 3 — Rich Content & ADF](#phase-3--rich-content--adf)
   - [Phase 4 — End-to-End Tests](#phase-4--end-to-end-tests)
   - [Phase 5 — Audit Logging & Rate Limiting](#phase-5--audit-logging--rate-limiting)
6. [Data Model](#6-data-model)
7. [API Reference](#7-api-reference)
8. [Security Model](#8-security-model)
9. [User-Facing Flows](#9-user-facing-flows)
10. [Deployment Checklist](#10-deployment-checklist)
11. [Testing Strategy](#11-testing-strategy)
12. [Open Questions & Future Work](#12-open-questions--future-work)

---

## 1. Overview

Nyx integrates with Atlassian's Jira and Confluence products using OAuth 2.0 (3LO — three-legged OAuth with PKCE). Users connect their Atlassian account once; from that point forward, Nyx can:

- **Jira**: Create issues directly from Nyx spec sections, sync issue status back into Nyx via webhooks or polling.
- **Confluence**: Export Nyx documents to Confluence pages and import existing Confluence pages into Nyx.

### Goals

| Goal | Priority |
|------|----------|
| Users can connect/disconnect their Atlassian account securely | P0 |
| Jira issues can be created from Nyx specs with full field mapping | P0 |
| Issue status flows back into Nyx in real time | P0 |
| Nyx documents can be exported to Confluence | P0 |
| Confluence pages can be imported into Nyx | P0 |
| OAuth tokens are secure at rest and in transit | P0 |
| Multi-instance deployments work correctly (Redis PKCE store) | P1 |
| Webhook registration is automated, not manual | P1 |
| Incoming webhook payloads are verified against a secret | P1 |
| Key derivation uses HKDF instead of raw SHA-256 | P1 |
| Rich ADF conversion (headers, lists, code blocks) | P2 |
| Confluence two-way change detection | P2 |
| Audit log for all Atlassian API calls | P2 |

### Non-Goals

- Multi-site Atlassian support (one cloud site per user connection, for now)
- Bidirectional real-time sync of Confluence content (Nyx is the source of truth)
- Replacing Jira or Confluence — Nyx integrates with them, not replaces them
- Admin-scope Atlassian operations

---

## 2. Current State

The core OAuth plumbing, service layer, database schema, and frontend UI are **already implemented**. The following table summarises what exists and what remains:

| Area | File(s) | Status |
|------|---------|--------|
| DB schema (`atlassian_connections`) | `apps/api/src/db/schema.ts` | ✅ Defined, needs `drizzle-kit push` |
| Environment variable config | `apps/api/src/lib/config.ts` | ✅ Declared, not yet set in deployment |
| Token encryption (AES-256-GCM) | `apps/api/src/lib/encryption.ts` | ✅ Working; SHA-256 key derivation (upgrade to HKDF for prod) |
| Atlassian service | `apps/api/src/services/atlassian.service.ts` | ✅ PKCE, token lifecycle, Jira, Confluence, ADF |
| OAuth + API routes | `apps/api/src/routes/integrations/atlassian.ts` | ✅ All routes registered |
| Frontend component | `apps/web/src/components/AtlassianIntegration.tsx` | ✅ Connect/disconnect, settings UI |
| Shared Zod types | `packages/shared/src/types/atlassian.ts` | ✅ Complete |
| Frontend API client | `apps/web/src/lib/api.ts` | ✅ All client functions |
| Unit tests | `apps/api/src/services/__tests__/atlassian.service.test.ts` | ✅ PKCE, ADF, status mapping |
| Encryption tests | `apps/api/src/lib/__tests__/encryption.test.ts` | ✅ Round-trip, tamper detection |
| PKCE store | In-memory `Map` | ⚠️ Not safe for multi-instance — needs Redis/DB |
| Webhook secret validation | `atlassian.ts` webhook handler | ❌ Not implemented |
| Webhook auto-registration | Not implemented | ❌ Manual only |
| Key derivation | `encryption.ts` (SHA-256) | ⚠️ Upgrade to HKDF for production |
| ADF richness | Plain paragraphs only | ⚠️ No headers, lists, or code blocks |
| E2E tests | Not implemented | ❌ Missing |
| Audit logging | Referenced in spec; not in code | ❌ Missing |
| Rate-limit handling | Not implemented | ❌ Missing |
| External OAuth app | Not registered | ❌ Blocker for any testing |

---

## 3. Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React / Vite)                                  │
│                                                          │
│  ┌─────────────────────────┐                            │
│  │  AtlassianIntegration   │  ← Settings > Integrations │
│  │  .tsx                   │                            │
│  └──────────┬──────────────┘                            │
│             │ fetch/mutate (React Query)                 │
└─────────────┼───────────────────────────────────────────┘
              │ HTTPS
┌─────────────▼───────────────────────────────────────────┐
│  Fastify API (Railway)                                   │
│                                                          │
│  /api/integrations/atlassian/*                           │
│  ┌────────────────────────────┐                         │
│  │  atlassian.ts (routes)     │                         │
│  └──────────┬─────────────────┘                         │
│             │                                            │
│  ┌──────────▼─────────────────┐  ┌──────────────────┐  │
│  │  atlassian.service.ts      │  │  encryption.ts   │  │
│  │  - PKCE store (Map→Redis)  │  │  (AES-256-GCM)   │  │
│  │  - OAuth token lifecycle   │  └──────────────────┘  │
│  │  - Jira API calls          │                         │
│  │  - Confluence API calls    │  ┌──────────────────┐  │
│  │  - ADF conversion          │  │  PostgreSQL       │  │
│  └──────────┬─────────────────┘  │  atlassian_       │  │
│             │                    │  connections      │  │
│             └───────────────────►│  (Drizzle ORM)    │  │
│                                  └──────────────────┘  │
└─────────────────────────────────────────────────────────┘
              │ HTTPS (Atlassian REST APIs)
┌─────────────▼───────────────────────────────────────────┐
│  Atlassian Cloud                                         │
│                                                          │
│  auth.atlassian.com   — OAuth authorize / token          │
│  api.atlassian.com    — accessible-resources             │
│  *.atlassian.net/     — Jira REST API v3                 │
│  *.atlassian.net/wiki — Confluence REST API v2           │
└─────────────────────────────────────────────────────────┘

              Webhook traffic (inbound)
┌─────────────────────────────────────────────────────────┐
│  Atlassian → POST /api/integrations/jira/webhook         │
│  (Jira issue_updated / issue_deleted events)             │
└─────────────────────────────────────────────────────────┘
```

### OAuth 2.0 (3LO) Sequence

```
User          Browser        Nyx API               Atlassian
 │               │               │                     │
 │  Click Connect│               │                     │
 │──────────────►│               │                     │
 │               │ GET /auth     │                     │
 │               │──────────────►│                     │
 │               │               │ generate PKCE       │
 │               │               │ store state+verifier│
 │               │◄──────────────│                     │
 │               │  302 redirect │                     │
 │               │──────────────────────────────────►  │
 │               │               │  /authorize?        │
 │               │               │  client_id,scope,   │
 │               │               │  code_challenge,    │
 │               │               │  state              │
 │               │               │                     │
 │  User consents│               │                     │
 │◄──────────────────────────────────────────────────  │
 │               │◄──────────────────────────────────  │
 │               │  /callback?code=X&state=Y           │
 │               │──────────────►│                     │
 │               │               │ validate state      │
 │               │               │ GET pkce(state)     │
 │               │               │──────────────────►  │
 │               │               │  POST /oauth/token  │
 │               │               │  code + verifier    │
 │               │               │◄──────────────────  │
 │               │               │  access_token,      │
 │               │               │  refresh_token      │
 │               │               │──────────────────►  │
 │               │               │  GET /accessible-   │
 │               │               │  resources          │
 │               │               │◄──────────────────  │
 │               │               │  cloudId, siteUrl   │
 │               │               │                     │
 │               │               │ encrypt + store     │
 │               │               │ tokens in DB        │
 │               │◄──────────────│                     │
 │               │  302 /settings?atlassian=connected  │
```

---

## 4. External Setup (Prerequisites)

These steps must be completed by an administrator before any integration testing can occur. They cannot be automated from within the codebase.

### Step 1 — Register OAuth App in Atlassian Developer Console

1. Go to [https://developer.atlassian.com/console/myapps/](https://developer.atlassian.com/console/myapps/)
2. Click **Create** → **OAuth 2.0 integration**.
3. Name it something like `Nyx (Production)` or `Nyx (Staging)`.
4. Under **Permissions**, add the following APIs and scopes:

   | API | Scope | Purpose |
   |-----|-------|---------|
   | Jira platform REST API | `read:jira-work` | Read issues, projects, metadata |
   | Jira platform REST API | `write:jira-work` | Create and update issues |
   | Confluence REST API | `read:confluence-content.all` | Read pages, spaces |
   | Confluence REST API | `write:confluence-content.all` | Create and update pages |
   | (Implicit) | `offline_access` | Obtain refresh tokens |

5. Under **Authorization**, set the **Callback URL** to:
   - Staging: `https://<staging-api-url>/api/integrations/atlassian/callback`
   - Production: `https://<production-api-url>/api/integrations/atlassian/callback`
6. Copy the **Client ID** and **Client Secret** from the app settings page.

> **Note:** A separate app registration is recommended for each environment (staging, production) to keep secrets isolated.

### Step 2 — Set Environment Variables

On the API server (Railway or Render), set the following environment variables:

```bash
# Atlassian OAuth credentials
ATLASSIAN_CLIENT_ID=<client-id-from-step-1>
ATLASSIAN_CLIENT_SECRET=<client-secret-from-step-1>

# Token encryption key — MUST be 32+ random characters, never reused across environments
# Generate with: openssl rand -hex 32
ENCRYPTION_SECRET=<64-char-hex-string>
```

> **Security:** `ENCRYPTION_SECRET` is used to encrypt OAuth tokens at rest in the database. Changing it after tokens are stored will invalidate all existing connections — users will need to reconnect. Back this up securely (e.g., in 1Password or AWS Secrets Manager).

### Step 3 — Run Database Migration

The `atlassian_connections` table and `atlassian_connection_status` enum are defined in `apps/api/src/db/schema.ts` but do not exist in the database until the schema is pushed.

```bash
# In the repository root, targeting the API package
pnpm --filter api exec drizzle-kit push
```

This is idempotent — re-running it is safe if the table already exists.

---

## 5. Implementation Plan

The remaining work is divided into five phases ordered by priority. Each phase is independently shippable.

---

### Phase 1 — Production Hardening

**Goal:** Make the existing code safe for a multi-instance production deployment.

**Estimated effort:** 1–2 days

#### 1.1 Migrate PKCE Store from In-Memory to Redis

**Why it matters:** The current `pkceStore` is a `Map` in process memory. When the API runs on more than one Railway instance (or restarts), the PKCE state token generated in one instance may not be found by the instance that handles the callback, causing `400 Invalid state` errors for users.

**Files to change:**
- `apps/api/src/services/atlassian.service.ts`
- `apps/api/src/lib/config.ts` (add `REDIS_URL` env var)
- `package.json` of `apps/api` (add `ioredis` dependency)

**Implementation:**

```typescript
// apps/api/src/services/atlassian.service.ts

// Before (in-memory):
const pkceStore = new Map<string, { codeVerifier: string; userId: string; teamId?: string; expiresAt: number }>();

// After (Redis-backed):
import Redis from 'ioredis';
const redis = new Redis(config.REDIS_URL);
const PKCE_TTL_SECONDS = 600; // 10 minutes

async function storePkceData(state: string, data: PkceData): Promise<void> {
  await redis.setex(`pkce:${state}`, PKCE_TTL_SECONDS, JSON.stringify(data));
}

async function getPkceData(state: string): Promise<PkceData | null> {
  const raw = await redis.getdel(`pkce:${state}`);
  return raw ? JSON.parse(raw) : null;
}
```

**Fallback for local dev:** If `REDIS_URL` is not set, fall back to the in-memory Map with a console warning. This avoids breaking local development.

**Config addition:**
```typescript
// apps/api/src/lib/config.ts
REDIS_URL: z.string().url().optional(), // Required in production
```

---

#### 1.2 Upgrade Key Derivation from SHA-256 to HKDF

**Why it matters:** The current `getKey()` function in `encryption.ts` derives the AES encryption key by computing `SHA-256(ENCRYPTION_SECRET)`. SHA-256 is not designed for key derivation — it does not provide domain separation, stretch entropy, or the security guarantees that HKDF (RFC 5869) provides. HKDF is the standard for deriving cryptographic keys from key material.

**Files to change:**
- `apps/api/src/lib/encryption.ts`

**Implementation:**

```typescript
// apps/api/src/lib/encryption.ts
import { hkdfSync } from 'node:crypto';

function getKey(): Buffer {
  const secret = config.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET is not set');

  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'), // IKM: input key material
      Buffer.from('nyx-atlassian-tokens', 'utf8'), // salt
      Buffer.from('atlassian-token-encryption-v1', 'utf8'), // info (domain separation)
      32 // output length: 32 bytes for AES-256
    )
  );
}
```

> **Migration concern:** Changing the key derivation will invalidate all existing encrypted tokens in the database. If tokens already exist in staging/production, plan a migration window where users are prompted to reconnect, or implement a dual-decrypt path that tries HKDF first and falls back to SHA-256 for a one-release transition period.

**Migration path for existing tokens:**
```typescript
function decrypt(ciphertext: string): string {
  // Try HKDF-derived key first (new format)
  try {
    return decryptWithKey(ciphertext, getKeyHkdf());
  } catch {
    // Fall back to legacy SHA-256-derived key for previously stored tokens
    return decryptWithKey(ciphertext, getKeyLegacy());
  }
}
```

Once all tokens have been refreshed (i.e., after users have made at least one API call), the legacy path can be removed.

---

### Phase 2 — Webhook Automation & Validation

**Goal:** Remove the need for manual webhook setup and make incoming Jira events trustworthy.

**Estimated effort:** 1–2 days

#### 2.1 Validate Incoming Jira Webhook Payloads

**Why it matters:** The current webhook handler at `POST /api/integrations/jira/webhook` accepts any request. Without validation, an attacker who discovers the endpoint can forge events — e.g., marking all Nyx tickets as "Done" without them actually being resolved in Jira.

Atlassian signs outgoing webhook payloads using a shared secret that is configured when the webhook is registered. The signature is passed in the `X-Hub-Signature` header (HMAC-SHA256 of the raw request body).

**Files to change:**
- `apps/api/src/routes/integrations/atlassian.ts`
- `apps/api/src/db/schema.ts` (store webhook secret per connection)
- `apps/api/src/services/atlassian.service.ts` (registration helper)

**DB change — add webhook secret column:**
```typescript
// apps/api/src/db/schema.ts
export const atlassianConnections = pgTable('atlassian_connections', {
  // ... existing columns ...
  jiraWebhookId: text('jira_webhook_id'),       // Atlassian webhook registration ID
  jiraWebhookSecret: text('jira_webhook_secret'), // AES-encrypted shared HMAC secret
});
```

**Validation middleware:**
```typescript
// apps/api/src/routes/integrations/atlassian.ts
async function verifyJiraWebhookSignature(
  request: FastifyRequest,
  secret: string
): Promise<boolean> {
  const signature = request.headers['x-hub-signature'] as string | undefined;
  if (!signature) return false;

  const [algo, digest] = signature.split('=');
  if (algo !== 'sha256') return false;

  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(request.body))
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'));
}
```

---

#### 2.2 Automate Jira Webhook Registration

**Why it matters:** Currently, webhook registration in Jira is a manual step. This means every new team connection requires a manual action — a poor onboarding experience and a common source of "why isn't status syncing?" support tickets.

**When to register:** Automatically call the Jira webhook registration API after the user connects their account and selects a Jira project in settings.

**Service function to add:**
```typescript
// apps/api/src/services/atlassian.service.ts

export async function registerJiraWebhook(
  accessToken: string,
  cloudId: string,
  projectKey: string,
  callbackUrl: string
): Promise<{ id: number; secret: string }> {
  // Generate a random secret for HMAC signature verification
  const secret = randomBytes(32).toString('hex');

  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: callbackUrl,
        webhooks: [
          {
            events: ['jira:issue_updated', 'jira:issue_deleted'],
            jqlFilter: `project = ${projectKey}`,
          },
        ],
        secret,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Jira webhook registration failed: ${response.status}`);
  }

  const data = await response.json();
  return { id: data.webhookRegistrationResult[0].createdWebhookId, secret };
}
```

**Trigger point — update preferences route:**
```typescript
// apps/api/src/routes/integrations/atlassian.ts — PUT /preferences
// When defaultJiraProjectKey changes AND jiraStatusSync === 'webhooks':
//   1. Deregister old webhook (if jiraWebhookId exists)
//   2. Register new webhook for the new project
//   3. Store jiraWebhookId + encrypted jiraWebhookSecret in DB
```

**Webhook deregistration on disconnect:**
```typescript
// Call DELETE /rest/api/3/webhook with stored jiraWebhookId before deleting connection row
```

---

### Phase 3 — Rich Content & ADF

**Goal:** Improve the fidelity of content round-tripping between Nyx and Atlassian.

**Estimated effort:** 2–4 days

#### 3.1 Rich Markdown → ADF Conversion

**Why it matters:** The current `textToAdf()` function wraps everything in plain text paragraphs. A Nyx spec section written with markdown headings, bullet lists, numbered lists, and code blocks loses all structure when pushed to Jira or Confluence. This makes the resulting Jira issues and Confluence pages harder to read.

**Recommended approach:** Use the [`@atlaskit/adf-utils`](https://www.npmjs.com/package/@atlaskit/adf-utils) package for ADF manipulation, combined with a markdown parser like `micromark` or `remark` to walk the markdown AST and emit ADF nodes.

**Install:**
```bash
pnpm --filter api add @atlaskit/adf-utils micromark micromark-extension-gfm unist-util-visit
```

**Node mapping table:**

| Markdown element | ADF node type |
|------------------|---------------|
| `# Heading 1` | `heading` level 1 |
| `## Heading 2` | `heading` level 2 |
| `- item` | `bulletList` → `listItem` → `paragraph` |
| `1. item` | `orderedList` → `listItem` → `paragraph` |
| ` ```code``` ` (fenced) | `codeBlock` with language |
| `` `inline` `` | `text` with `code` mark |
| `**bold**` | `text` with `strong` mark |
| `_italic_` | `text` with `em` mark |
| `[text](url)` | `text` with `link` mark |
| `> blockquote` | `blockquote` → `paragraph` |
| `---` | `rule` |
| plain text paragraph | `paragraph` → `text` |

**ADF → Markdown conversion** (for Confluence import) should follow the reverse mapping. The simplified current approach is acceptable for Phase 3 if the primary use-case is Nyx → Jira/Confluence export.

---

#### 3.2 Multi-Site Support (Optional P2)

Currently Nyx uses the first accessible Atlassian Cloud site. Users who have multiple Atlassian sites (e.g., a personal account and a work account) cannot choose which site to connect to.

**Implementation:** After `getAccessibleResources()` returns multiple sites, present a site-selection step during the OAuth callback or as a post-connect modal, rather than auto-selecting the first.

---

### Phase 4 — End-to-End Tests

**Goal:** Cover the full OAuth flow and the primary Jira/Confluence operations with E2E tests.

**Estimated effort:** 2–3 days

#### 4.1 OAuth Flow Tests

Location: `e2e/atlassian-oauth.spec.ts`

These tests use the existing `authenticatedPage` fixture and a mock Atlassian server (MSW or a Playwright route mock).

```typescript
// e2e/atlassian-oauth.spec.ts

import { test, expect } from './fixtures/test-base';

test.describe('Atlassian OAuth', () => {
  test('Connect button redirects to Atlassian authorize URL', async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/settings?tab=integrations');

    const [popup] = await Promise.all([
      authenticatedPage.waitForNavigation(),
      authenticatedPage.click('[data-testid="atlassian-connect-btn"]'),
    ]);

    expect(authenticatedPage.url()).toContain('auth.atlassian.com/authorize');
    expect(authenticatedPage.url()).toContain('code_challenge_method=S256');
    expect(authenticatedPage.url()).toContain('offline_access');
  });

  test('Simulated callback stores connection and shows connected state', async ({ page, request }) => {
    // Seed PKCE state via test helper route
    const { state, codeVerifier } = await seedPkceState(request);

    // Simulate Atlassian callback with mocked token exchange
    await page.route('https://auth.atlassian.com/oauth/token', route =>
      route.fulfill({ json: mockTokenResponse })
    );
    await page.route('https://api.atlassian.com/oauth/token/accessible-resources', route =>
      route.fulfill({ json: [mockAtlassianSite] })
    );

    await page.goto(`/api/integrations/atlassian/callback?code=test_code&state=${state}`);
    await page.waitForURL('/settings?tab=integrations&atlassian=connected');

    await expect(page.locator('[data-testid="atlassian-status-dot"]')).toHaveClass(/green/);
    await expect(page.locator('[data-testid="atlassian-site-name"]')).toContainText('test.atlassian.net');
  });

  test('Invalid state parameter returns 400', async ({ request }) => {
    const response = await request.get('/api/integrations/atlassian/callback?code=x&state=invalid');
    expect(response.status()).toBe(400);
  });
});
```

#### 4.2 Token Lifecycle Tests

```typescript
test('Expired token is refreshed transparently', async ({ request }) => {
  // Store a connection with an expired access token in the test DB
  await seedExpiredAtlassianConnection(request);

  // Mock the refresh endpoint
  // Then call a protected Atlassian endpoint
  // Assert that the refresh was called and the original operation succeeded
});

test('Failed refresh marks connection as disconnected', async ({ authenticatedPage, request }) => {
  await seedExpiredAtlassianConnection(request);
  // Mock refresh to return 401
  // Assert status becomes 'token_expired' and UI shows re-authorize prompt
});
```

#### 4.3 Jira Integration Tests

```typescript
test('Create Jira issue from spec section', async ({ authenticatedPage }) => {
  // Mock GET /jira/*/rest/api/3/project/search
  // Mock POST /jira/*/rest/api/3/issue → returns { id, key, self }

  await authenticatedPage.goto('/documents/test-doc');
  await authenticatedPage.click('[data-testid="section-actions-menu"]');
  await authenticatedPage.click('[data-testid="create-jira-issue-btn"]');

  // Assert issue creation payload matches spec content
  // Assert Jira issue key appears in the UI
});

test('Jira webhook updates ticket status', async ({ request }) => {
  // POST /api/integrations/jira/webhook with valid HMAC signature
  // Assert ticket status in Nyx DB is updated
});
```

#### 4.4 Confluence Integration Tests

```typescript
test('Export Nyx doc to Confluence', async ({ authenticatedPage }) => {
  // Mock GET /confluence/*/wiki/api/v2/spaces
  // Mock POST /confluence/*/wiki/api/v2/pages → returns page ID

  await authenticatedPage.goto('/documents/test-doc');
  await authenticatedPage.click('[data-testid="export-to-confluence-btn"]');
  // Select space, confirm
  // Assert page ID is stored and success toast appears
});

test('Import Confluence page creates Nyx document', async ({ authenticatedPage }) => {
  // Mock GET /confluence/*/wiki/api/v2/pages/{id}?body-format=atlas_doc_format
  // Assert a new Nyx document is created with converted content
});
```

**Selectors to add to `e2e/fixtures/selectors.ts`:**

```typescript
export const AtlassianSelectors = {
  connectBtn: '[data-testid="atlassian-connect-btn"]',
  disconnectBtn: '[data-testid="atlassian-disconnect-btn"]',
  statusDot: '[data-testid="atlassian-status-dot"]',
  siteName: '[data-testid="atlassian-site-name"]',
  jiraProjectSelect: '[data-testid="jira-project-select"]',
  confluenceSpaceSelect: '[data-testid="confluence-space-select"]',
  exportToConfluenceBtn: '[data-testid="export-to-confluence-btn"]',
  createJiraIssueBtn: '[data-testid="create-jira-issue-btn"]',
};
```

---

### Phase 5 — Audit Logging & Rate Limiting

**Goal:** Operational visibility and resilience against Atlassian API rate limits.

**Estimated effort:** 1–2 days

#### 5.1 Audit Logging for Atlassian API Calls

Every Atlassian API call should produce an audit log entry. The existing schema may already have an `auditLogs` table — if not, one needs to be added.

**Audit log schema (if not already present):**

```typescript
// apps/api/src/db/schema.ts
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  action: text('action').notNull(),          // e.g., 'jira.issue.create'
  resourceId: text('resource_id'),            // e.g., 'PROJECT-123'
  resourceType: text('resource_type'),        // e.g., 'jira_issue'
  statusCode: integer('status_code'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').default({}),    // non-sensitive request details
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**Wrapper in atlassian.service.ts:**

```typescript
async function callAtlassianApi<T>(
  accessToken: string,
  action: string,
  resourceId: string | undefined,
  fn: () => Promise<T>,
  userId: string,
  db: Database
): Promise<T> {
  try {
    const result = await fn();
    await db.insert(auditLogs).values({
      userId, action, resourceId, statusCode: 200,
    });
    return result;
  } catch (err) {
    const statusCode = err instanceof AtlassianApiError ? err.statusCode : 500;
    await db.insert(auditLogs).values({
      userId, action, resourceId, statusCode,
      errorMessage: err.message.replace(/Bearer [^\s]+/, 'Bearer [REDACTED]'),
    });
    throw err;
  }
}
```

#### 5.2 Rate-Limit Handling with Exponential Backoff

Atlassian enforces per-product rate limits. When a `429 Too Many Requests` is received, the `Retry-After` header specifies the wait time.

**Retry wrapper:**

```typescript
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === maxRetries) return response;

    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '1', 10);
    const jitter = Math.random() * 1000;
    const delay = retryAfter * 1000 + jitter * (2 ** attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
    attempt++;
  }
  throw new Error('Max retries exceeded');
}
```

---

## 6. Data Model

### `atlassian_connections` Table

```sql
CREATE TYPE atlassian_connection_status AS ENUM (
  'connected',
  'token_expired',
  'disconnected',
  'error'
);

CREATE TABLE atlassian_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id     UUID REFERENCES teams(id) ON DELETE CASCADE,

  -- Encrypted OAuth tokens (AES-256-GCM via encryption.ts)
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  token_expires_at    TIMESTAMPTZ NOT NULL,

  -- Atlassian site metadata
  cloud_id            TEXT NOT NULL,
  site_url            TEXT NOT NULL,
  scopes              TEXT[] NOT NULL DEFAULT '{}',

  -- Status and preferences
  status              atlassian_connection_status NOT NULL DEFAULT 'connected',
  preferences         JSONB NOT NULL DEFAULT '{}',

  -- Webhook tracking (Phase 2)
  jira_webhook_id     TEXT,           -- Atlassian webhook registration ID
  jira_webhook_secret TEXT,           -- AES-encrypted HMAC secret for signature validation

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraint: one active connection per user
CREATE UNIQUE INDEX atlassian_connections_user_id_idx
  ON atlassian_connections (user_id)
  WHERE status != 'disconnected';
```

### `preferences` JSONB Shape

```typescript
interface AtlassianSyncPreferences {
  autoExportOnPublish: boolean;           // default: false
  jiraStatusSync: 'webhooks' | 'polling' | 'disabled'; // default: 'webhooks'
  pollingIntervalMinutes: 5 | 15 | 30 | 60; // default: 15
  confluenceChangeDetection: boolean;     // default: true
  defaultJiraProjectKey?: string;         // set after user selects project
  defaultConfluenceSpaceId?: string;      // set after user selects space
}
```

---

## 7. API Reference

### Authentication

All routes except the OAuth callback and the Jira webhook require a valid Clerk session token in the `Authorization: Bearer {token}` header. Routes are protected via the `authenticate` preHandler on the Fastify route.

### OAuth Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/integrations/atlassian/auth` | Required | Start OAuth flow — returns 302 to Atlassian |
| `GET` | `/api/integrations/atlassian/callback` | None (public) | OAuth callback handler |
| `DELETE` | `/api/integrations/atlassian/connection` | Required | Disconnect and revoke tokens |
| `GET` | `/api/integrations/atlassian/status` | Required | Get connection status |
| `PUT` | `/api/integrations/atlassian/preferences` | Required | Update sync preferences |

### Jira Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/integrations/atlassian/jira/projects` | Required | List accessible Jira projects |
| `POST` | `/api/integrations/atlassian/jira/issues` | Required | Create a Jira issue from a spec |
| `POST` | `/api/integrations/jira/webhook` | HMAC signature | Handle Jira webhook events |

**`POST /api/integrations/atlassian/jira/issues` body:**

```typescript
{
  projectKey: string;          // e.g., "MYPROJ"
  summary: string;             // max 255 chars
  description: string;         // will be converted to ADF
  issueType?: 'Task' | 'Story' | 'Bug' | 'Epic'; // default: Task
  labels?: string[];
  priority?: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
  assigneeAccountId?: string;
  specUrl?: string;            // appended as link in ADF description
}
```

### Confluence Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/integrations/atlassian/confluence/spaces` | Required | List accessible Confluence spaces |
| `POST` | `/api/integrations/atlassian/confluence/export` | Required | Export a Nyx doc to Confluence |
| `POST` | `/api/integrations/atlassian/confluence/import` | Required | Import a Confluence page into Nyx |

**`POST /api/integrations/atlassian/confluence/export` body:**

```typescript
{
  spaceId: string;             // Confluence space ID
  title: string;               // page title
  content: string;             // Nyx document content (markdown or internal format)
  parentPageId?: string;       // optional parent page for nesting
  existingPageId?: string;     // if provided, updates instead of creates
}
```

---

## 8. Security Model

### Threat Model

| Threat | Mitigation |
|--------|------------|
| CSRF during OAuth flow | PKCE `state` token validated on callback; one-time use |
| Token theft from DB | AES-256-GCM encryption at rest; decrypted only in memory |
| Token leakage via logs | Tokens never logged; audit log redacts Bearer headers |
| Forged webhook events | HMAC-SHA256 signature validated with timing-safe comparison (Phase 2) |
| Stale sessions after disconnect | Token revoked at Atlassian + DB row deleted |
| Replay of OAuth code | PKCE `code_verifier` consumed on first use; TTL 10 min |
| Multi-instance PKCE race | Redis store with atomic `GETDEL` ensures single-use (Phase 1) |

### Token Encryption

**Current (acceptable for pre-launch):**
- Key = `SHA-256(ENCRYPTION_SECRET)`
- IV = random 12 bytes per encryption
- Algorithm = AES-256-GCM (provides authenticated encryption)

**Target (Phase 1):**
- Key = `HKDF(SHA-256, ENCRYPTION_SECRET, salt="nyx-atlassian-tokens", info="atlassian-token-encryption-v1", length=32)`
- IV = random 12 bytes per encryption
- Algorithm = AES-256-GCM

### Scope Principle of Least Privilege

Nyx requests only the five scopes listed in Section 4. No admin scopes. Atlassian's API enforces per-scope ACLs — if a user doesn't have permission to write a particular project, the API returns 403 which Nyx surfaces as an error.

---

## 9. User-Facing Flows

### Flow 1: Connect Atlassian Account

```
Settings > Integrations > Atlassian
→ Click "Connect Atlassian"
→ Redirect to auth.atlassian.com (consent screen)
→ User approves scopes
→ Redirect back to Nyx settings with ?atlassian=connected
→ Status indicator turns green
→ Jira project and Confluence space dropdowns become visible
```

**Error states:**
- User denies consent → redirect with `?error=access_denied`, show "Authorization was cancelled" message
- Missing env vars → show "Integration not configured" state (not a user error)
- Token exchange fails → show "Could not complete connection, please try again"

### Flow 2: Create a Jira Issue from a Spec Section

```
Document editor > Select a section > Actions menu > "Create Jira Issue"
→ Modal: confirm project, issue type, summary (pre-filled from section title)
→ Click "Create"
→ POST /api/integrations/atlassian/jira/issues
→ Jira issue key returned (e.g., PROJ-42)
→ Section shows linked Jira issue badge
→ Status syncs automatically via webhook
```

### Flow 3: Export Document to Confluence

```
Document > Actions > "Export to Confluence"
→ Sidebar: select target space, optional parent page
→ Click "Export"
→ POST /api/integrations/atlassian/confluence/export
→ Confluence page ID returned
→ Document shows "Synced to Confluence" badge with link
```

### Flow 4: Import Confluence Page

```
Documents > New > "Import from Confluence"
→ Browse connected Confluence spaces and pages
→ Select page → click "Import"
→ POST /api/integrations/atlassian/confluence/import
→ New Nyx document created, linked back to source page
```

### Flow 5: Disconnect Atlassian Account

```
Settings > Integrations > Atlassian > "Disconnect"
→ Confirmation dialog: "This will remove your Atlassian connection and stop all syncing. This cannot be undone."
→ Confirm → DELETE /api/integrations/atlassian/connection
→ Token revoked at Atlassian
→ DB row deleted
→ Status indicator turns gray
```

---

## 10. Deployment Checklist

Use this checklist for each environment (staging first, then production).

### Pre-Deployment

- [ ] Register OAuth app in Atlassian Developer Console (one per environment)
- [ ] Set `ATLASSIAN_CLIENT_ID` in environment
- [ ] Set `ATLASSIAN_CLIENT_SECRET` in environment
- [ ] Set `ENCRYPTION_SECRET` (32+ chars, unique per environment, stored in secrets manager)
- [ ] Set `REDIS_URL` (required when Phase 1 is merged)
- [ ] Callback URL whitelisted in Atlassian app settings

### Database

- [ ] Run `pnpm --filter api exec drizzle-kit push` to create `atlassian_connections` table
- [ ] Verify table exists: `SELECT * FROM atlassian_connections LIMIT 1;`
- [ ] Verify enum exists: `SELECT enum_range(NULL::atlassian_connection_status);`

### Smoke Tests

- [ ] Navigate to Settings > Integrations — "Connect Atlassian" button visible
- [ ] Click "Connect" — redirected to `auth.atlassian.com`
- [ ] Complete OAuth flow — settings page shows green connected indicator
- [ ] Jira project dropdown populates
- [ ] Confluence space dropdown populates
- [ ] Create a Jira issue — issue appears in Jira, key shown in Nyx
- [ ] Export a document — Confluence page created
- [ ] Disconnect — status returns to gray, DB row deleted

### Monitoring

- [ ] API errors on `/api/integrations/atlassian/*` routes are surfaced in Railway/Render logs
- [ ] Set alert for spike in `atlassianTokenExpiredError` (indicates mass refresh token expiry)
- [ ] (Phase 5) Audit log table receiving entries for Atlassian API calls

---

## 11. Testing Strategy

### Unit Tests (existing + extensions)

| Test file | Coverage |
|-----------|----------|
| `atlassian.service.test.ts` | PKCE generation, ADF conversion, status mapping |
| `encryption.test.ts` | Round-trip, tamper detection, HKDF (Phase 1) |
| `atlassian.routes.test.ts` (new) | Route handler logic with mocked service layer |

### E2E Tests (Phase 4)

| Test file | Coverage |
|-----------|----------|
| `e2e/atlassian-oauth.spec.ts` | Connect, callback, invalid state, disconnect |
| `e2e/atlassian-tokens.spec.ts` | Token refresh, refresh failure, re-auth prompt |
| `e2e/atlassian-jira.spec.ts` | Issue creation, webhook status sync, project selection |
| `e2e/atlassian-confluence.spec.ts` | Export, import, update existing page |

### Mock Strategy

E2E tests should mock Atlassian's external APIs at the network layer using Playwright's `page.route()` or a `beforeAll`-level MSW server. This avoids:
- Flaky tests due to Atlassian API unavailability
- Accidentally creating real Jira issues or Confluence pages in CI
- Rate-limit exhaustion in CI pipelines

A test helper module (`e2e/helpers/atlassian-mocks.ts`) should export reusable route mocks for each Atlassian endpoint.

---

## 12. Open Questions & Future Work

| Item | Status | Notes |
|------|--------|-------|
| Multi-site support | Future | Users with multiple Atlassian cloud sites can't choose which one |
| Jira issue updates | Future | Nyx can create issues but not update them after creation |
| Confluence two-way conflict resolution UI | Future | Spec defines the UX; needs implementation |
| Jira issue type metadata | Future | Currently hardcoded; should fetch from `GET /issue/createmeta` |
| Attachment support | Future | Nyx images → Jira/Confluence attachments |
| Rate limit backoff (Phase 5) | Planned | Exponential backoff with jitter |
| Audit log retention policy UI | Future | Admins can configure 30/60/90 day retention |
| Atlassian Connect app (alternative) | Investigated | Adds complexity; not needed for current scope |
| Jira webhook expiry | Known issue | Atlassian webhooks expire after 30 days if unused; need auto-renewal logic |

> **Jira webhook expiry:** Atlassian automatically deletes registered webhooks that have not fired in 30 days. Nyx should implement a periodic job (or use the preferences polling path as a fallback) to re-register webhooks before they expire. Webhooks can be refreshed by calling `POST /rest/api/3/webhook` again; Atlassian deduplicates by JQL filter + URL.
