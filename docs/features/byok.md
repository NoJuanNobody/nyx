# BYOK (Bring Your Own Key) Feature Specification

**Issue:** #6
**Status:** Draft
**Tier availability:** Team & Enterprise plans only

---

## Overview

BYOK allows team admins to supply their own Anthropic (or other AI provider) API key so that all AI-powered features for that team — spec quality analysis, drift detection, ticket generation, document editing, JSX preview generation — are billed directly to the team's account instead of consuming SyncDocs-managed quota.

This aligns with the governance coding convention `ai-provider-abstraction`: "AI features must be built behind provider-agnostic interfaces. No hardcoding to Anthropic, OpenAI, or any single provider. Support BYOK (Bring Your Own Key) pattern."

---

## 1. User Flow

### Where: Team Settings > AI Configuration

1. Team admin navigates to **Settings > AI Configuration** (new tab within the existing team settings page).
2. The page shows the current key status: **SyncDocs-managed** (default) or **Custom key active**.
3. Admin clicks **"Add API Key"**, which opens a modal with:
   - A dropdown to select the AI provider (initially only `Anthropic`, extensible to `OpenAI` etc.).
   - A masked text input for the API key.
   - A **"Validate & Save"** button that calls the provider's lightweight endpoint (e.g., Anthropic `GET /v1/models`) to verify the key before storing it.
4. On successful validation, the key is encrypted and stored. The UI updates to show:
   - Provider name and a masked key preview (last 4 characters).
   - A **"Rotate Key"** button and a **"Remove Key"** button.
5. Non-admin team members see a read-only banner: "This team uses a custom AI key managed by your admin."

### Key Rotation

1. Admin clicks **"Rotate Key"**.
2. Same modal appears, pre-filled with the provider. Admin pastes the new key.
3. On validation success the old key is replaced atomically — there is no window where both keys are active.
4. An audit log entry is created: `ai_key_rotated` with actor, timestamp, and masked key suffix.

### Key Removal

1. Admin clicks **"Remove Key"** and confirms via a destructive-action confirmation dialog.
2. The team falls back to SyncDocs-managed AI. An audit log entry is created: `ai_key_removed`.

---

## 2. Key Storage

### Database Schema

Add new columns to the `teams` table (or a dedicated `team_ai_keys` table):

```sql
-- Option A: dedicated table (preferred for audit trail and multi-provider support)
CREATE TABLE team_ai_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'anthropic',    -- 'anthropic', 'openai', etc.
  encrypted_key TEXT NOT NULL,                        -- AES-256-GCM ciphertext (base64)
  key_iv        TEXT NOT NULL,                        -- initialization vector (base64)
  key_suffix    TEXT NOT NULL,                        -- last 4 chars for display
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ,
  created_by    UUID NOT NULL REFERENCES users(id),
  UNIQUE(team_id, provider)
);
```

### Encryption at Rest

- **Algorithm:** AES-256-GCM (authenticated encryption).
- **Encryption key:** Derived from a `BYOK_ENCRYPTION_SECRET` environment variable via HKDF. This secret is stored in Railway/Render environment variables — never in source code.
- **IV:** A unique 12-byte IV is generated per encryption operation and stored alongside the ciphertext.
- **Decryption:** Only `ai.service.ts` decrypts the key at request time; the plaintext key is never written to logs, responses, or any persistent store beyond the encrypted column.

### Key Rotation Flow (Internal)

1. Generate new IV.
2. Encrypt new key with AES-256-GCM.
3. In a single DB transaction: update `encrypted_key`, `key_iv`, `key_suffix`, and set `rotated_at`.
4. Invalidate any in-memory cached Anthropic client for that team (see Request Routing).

---

## 3. Request Routing

### Current Implementation

In `apps/api/src/services/ai.service.ts`, a single global Anthropic client is created at module load:

```typescript
const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;
```

All AI methods (`analyzeSpecQuality`, `detectDrift`, `generateDocument`, etc.) call `requireClient()` which returns this singleton.

### BYOK-Aware Routing

Replace the singleton with a resolver function:

```typescript
async function resolveClient(teamId?: string): Promise<Anthropic> {
  // 1. If teamId is provided, check for a team-level BYOK key
  if (teamId) {
    const teamKey = await getDecryptedTeamKey(teamId, 'anthropic');
    if (teamKey) {
      return getOrCreateCachedClient(teamId, teamKey);
    }
  }

  // 2. Fall back to SyncDocs-managed key
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('No AI key available. Configure ANTHROPIC_API_KEY or add a team key.');
  }
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
}
```

**Client caching:** Team-specific Anthropic clients are cached in a `Map<string, Anthropic>` with a TTL of 5 minutes. On key rotation, the cache entry for that team is invalidated.

**Every AI service method** gains an optional `teamId` parameter. Route handlers pass the team ID from the authenticated request context.

### Decision Logic Summary

```
Request arrives with teamId
  |
  +-- team has active BYOK key for provider?
  |     YES --> decrypt key, use team client
  |     NO  --> use SyncDocs-managed client (config.ANTHROPIC_API_KEY)
  |
  +-- neither available?
        --> throw descriptive error
```

---

## 4. Usage Tracking

### Per-Team Token Usage

Each AI request records usage metadata:

```sql
CREATE TABLE ai_usage_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  operation   TEXT NOT NULL,          -- 'analyze_quality', 'detect_drift', 'generate_doc', etc.
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  key_source  TEXT NOT NULL,          -- 'syncdocs' | 'byok'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Usage Display (Settings > AI Configuration)

- **Current billing period** summary: total input tokens, total output tokens, estimated cost (calculated using published per-token pricing).
- **Daily bar chart** showing token usage over the last 30 days.
- **Per-operation breakdown** table (quality analysis, drift detection, document generation, etc.).
- **Key source indicator:** Whether usage was billed to the team's BYOK key or to SyncDocs.

### Aggregation API

```
GET /api/teams/:id/ai-usage?period=30d
```

Returns aggregated usage data. Accessible to team admins and owners only.

---

## 5. Error Handling

| Scenario | Detection | Behavior |
|---|---|---|
| **Invalid key** | Anthropic returns `401 Unauthorized` on validation or first use | Save is rejected with message: "The API key is invalid. Please check and try again." If detected during a request, the response returns a `422` with `{ error: 'team_key_invalid', message: '...' }`. |
| **Rate limited** | Anthropic returns `429 Too Many Requests` | Retry with exponential backoff (up to 3 attempts). If still rate-limited, return `429` to the client with `retryAfter` header. Do NOT fall back to SyncDocs key — the team chose to use their own key and should manage their own limits. |
| **Expired/revoked key** | Anthropic returns `401` on a previously-valid key | Mark the key as `is_active = false` in the database. Notify the team admin via in-app notification: "Your AI key is no longer valid. AI features will use SyncDocs defaults until you add a new key." Fall back to SyncDocs-managed key. |
| **Quota exceeded** | Anthropic returns `400` with quota error | Return `402` to the client with a message directing the admin to check their Anthropic account billing. |
| **Network error** | Request timeout or DNS failure | Retry once. If persistent, return `503` with a generic service unavailable message. |
| **Decryption failure** | AES-GCM auth tag mismatch | Log error (without key material). Fall back to SyncDocs key. Alert ops. |

### Fallback Policy

- **Explicit choice:** When a team has an active BYOK key, AI requests always use that key. There is no silent fallback to SyncDocs for rate limits or quota — that would obscure billing.
- **Implicit fallback:** Only occurs when the key is detected as invalid/revoked (401), at which point the key is deactivated and the team is notified.
- **No key at all:** Teams without a BYOK key use the SyncDocs-managed key, subject to plan-level usage quotas.

---

## 6. Settings UI Design

### AI Configuration Tab (`/settings/ai`)

```
+---------------------------------------------------------------+
| AI Configuration                                    [Team plan]|
+---------------------------------------------------------------+
|                                                                 |
|  API Key Status                                                 |
|  +---------------------------------------------------------+   |
|  | Provider:  Anthropic                                     |   |
|  | Key:       ****...xK7f                                   |   |
|  | Added:     2026-01-15 by alejandro@example.com           |   |
|  | Last used: 2026-03-15                                    |   |
|  |                                                          |   |
|  | [Rotate Key]  [Remove Key]                               |   |
|  +---------------------------------------------------------+   |
|                                                                 |
|  --- or, when no key is configured: ---                         |
|                                                                 |
|  +---------------------------------------------------------+   |
|  | Using SyncDocs-managed AI                                |   |
|  | Your team's AI requests use the platform's shared key.   |   |
|  | Usage counts against your plan's AI quota.               |   |
|  |                                                          |   |
|  | [Add Your Own API Key]                                   |   |
|  +---------------------------------------------------------+   |
|                                                                 |
|  Usage This Period (last 30 days)                               |
|  +---------------------------------------------------------+   |
|  | Input tokens:   1,234,567                                |   |
|  | Output tokens:     456,789                               |   |
|  | Est. cost:         $18.42                                |   |
|  | Key source:        BYOK                                  |   |
|  |                                                          |   |
|  | [Daily usage chart - 30 day bar chart]                   |   |
|  |                                                          |   |
|  | Operation Breakdown:                                     |   |
|  |   Spec analysis     432,100 tokens                      |   |
|  |   Drift detection   289,300 tokens                      |   |
|  |   Doc generation    512,800 tokens                      |   |
|  |   Ticket generation 456,156 tokens                      |   |
|  +---------------------------------------------------------+   |
|                                                                 |
|  Audit Log                                                      |
|  +---------------------------------------------------------+   |
|  | 2026-03-10  ai_key_rotated   by alejandro   ****xK7f    |   |
|  | 2026-01-15  ai_key_added     by alejandro   ****aB3d    |   |
|  +---------------------------------------------------------+   |
+---------------------------------------------------------------+
```

### Add/Rotate Key Modal

```
+-------------------------------------------+
| Add API Key                          [X]  |
+-------------------------------------------+
|                                           |
|  Provider:  [Anthropic        v]          |
|                                           |
|  API Key:   [________________________]    |
|             Paste your full API key.      |
|             It will be encrypted and      |
|             never shown again.            |
|                                           |
|  [Cancel]              [Validate & Save]  |
+-------------------------------------------+
```

---

## 7. Security Considerations

### Key Protection

- **Never exposed in frontend:** The API key plaintext is never returned in any API response. Only the `key_suffix` (last 4 chars) is sent to the client.
- **Encrypted at rest:** AES-256-GCM with a per-deployment encryption secret (`BYOK_ENCRYPTION_SECRET`).
- **Decrypted only in-process:** The key is decrypted inside `ai.service.ts` at request time and held only in memory for the duration of the API call.
- **No logging:** The plaintext key must never appear in application logs, error reports, or monitoring systems. Logging middleware must redact any field named `apiKey`, `encrypted_key`, or matching `sk-ant-*` patterns.

### Audit Trail

Every key lifecycle event is logged to an `audit_log` table:

| Event | Fields Logged |
|---|---|
| `ai_key_added` | actor user ID, team ID, provider, key suffix, timestamp |
| `ai_key_rotated` | actor user ID, team ID, provider, old key suffix, new key suffix, timestamp |
| `ai_key_removed` | actor user ID, team ID, provider, key suffix, timestamp |
| `ai_key_deactivated` | system, team ID, provider, reason (e.g., "401 from provider"), timestamp |

### Access Control

- Only `admin` and `owner` roles can add, rotate, or remove keys (enforced via `requireRole({ minimumRole: 'admin', source: 'team' })` — matching the existing pattern in `apps/api/src/routes/teams.ts`).
- `viewer`, `editor`, and `developer` roles see the key status (active/inactive, provider, masked suffix) but cannot modify it.

### Encryption Key Management

- The `BYOK_ENCRYPTION_SECRET` must be at least 32 bytes of cryptographically random data.
- Rotation of the encryption secret itself requires a migration script that re-encrypts all stored keys — this should be documented as a runbook.

---

## 8. Tier Gating

| Plan | AI Access | BYOK |
|---|---|---|
| **Free** | Limited SyncDocs-managed AI (quota-capped) | Not available |
| **Pro** | SyncDocs-managed AI (higher quota) | Not available |
| **Team** | SyncDocs-managed AI + BYOK option | Available |
| **Enterprise** | SyncDocs-managed AI + BYOK option | Available |

### Enforcement

- The `POST /api/teams/:id/ai-key` endpoint checks the team's subscription tier before accepting a key. Returns `403` with message: "BYOK is available on Team and Enterprise plans."
- The Settings UI conditionally renders the "Add API Key" button. On Free/Pro plans, the section shows an upgrade prompt instead.
- Tier checking should use the existing Stripe subscription data to determine plan level.

---

## 9. API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/teams/:id/ai-key` | admin+ | Validate and store an encrypted API key |
| `GET` | `/api/teams/:id/ai-key` | viewer+ | Get key status (provider, suffix, active, dates) — never the key itself |
| `PUT` | `/api/teams/:id/ai-key` | admin+ | Rotate (replace) the key |
| `DELETE` | `/api/teams/:id/ai-key` | admin+ | Remove the key, revert to SyncDocs-managed |
| `GET` | `/api/teams/:id/ai-usage` | admin+ | Get aggregated token usage for the team |

---

## 10. E2E Testing

### Test File Locations

- `e2e/byok-settings.spec.ts` — Admin key management flows
- `e2e/byok-ai-routing.spec.ts` — AI requests use correct key source
- `e2e/fixtures/test-base.ts` — Extended with BYOK-related fixtures

### Critical User Flows

#### Flow 1: Admin Adds a BYOK Key

```gherkin
Given the team admin is on the Settings > AI Configuration page
  And the team is on a Team or Enterprise plan
  And no custom API key is configured
When the admin clicks "Add Your Own API Key"
  And selects "Anthropic" as the provider
  And enters a valid API key
  And clicks "Validate & Save"
Then the key validation endpoint is called
  And the key is encrypted and stored
  And the UI shows "Custom key active" with the masked key suffix
  And an audit log entry "ai_key_added" is created
```

#### Flow 2: AI Request Uses Team Key

```gherkin
Given the team has an active BYOK key
When any team member triggers an AI operation (e.g., "Analyze Spec Quality")
Then the AI request is made using the team's decrypted BYOK key
  And the usage is logged with key_source = 'byok'
  And the response is returned normally
```

#### Flow 3: Admin Rotates a Key

```gherkin
Given the team has an active BYOK key
When the admin clicks "Rotate Key"
  And enters a new valid API key
  And clicks "Validate & Save"
Then the old key is replaced atomically
  And the cached AI client for the team is invalidated
  And an audit log entry "ai_key_rotated" is created
  And the UI shows the new masked key suffix
```

#### Flow 4: Invalid Key Handling

```gherkin
Given the admin is adding a new API key
When they enter an invalid key and click "Validate & Save"
Then the validation call returns an error
  And the UI shows "The API key is invalid. Please check and try again."
  And no key is stored
```

#### Flow 5: Key Becomes Invalid During Use

```gherkin
Given the team has an active BYOK key that has been revoked on the provider side
When a team member triggers an AI operation
Then the AI request fails with 401 from the provider
  And the key is marked as is_active = false
  And the admin receives an in-app notification about the invalid key
  And subsequent AI requests fall back to the SyncDocs-managed key
```

#### Flow 6: Tier Gating Enforcement

```gherkin
Given the team is on a Free or Pro plan
When the admin navigates to Settings > AI Configuration
Then the "Add Your Own API Key" button is not shown
  And an upgrade prompt is displayed instead
```

#### Flow 7: Non-Admin Cannot Manage Keys

```gherkin
Given a team member with "editor" role is on Settings > AI Configuration
When they view the AI key status
Then they see the key status (active/provider/suffix) as read-only
  And the "Rotate Key" and "Remove Key" buttons are not visible
```

### Integration Boundaries

| Component | Test Strategy |
|---|---|
| Anthropic API (key validation) | **Mock** — intercept HTTP calls to `api.anthropic.com` and return controlled 200/401/429 responses. Use Playwright `route.fulfill()`. |
| Encryption/decryption | **Live** — use real AES-256-GCM with a test encryption secret. Verify round-trip: encrypt then decrypt returns original key. |
| Database (key storage) | **Live** — use the test database. Verify encrypted value is stored (not plaintext). |
| Stripe (tier checking) | **Mock** — stub the subscription lookup to return controlled plan levels. |
| AI service routing | **Mock** — verify that `resolveClient()` returns different clients based on team key presence. Unit test via Vitest in `apps/api/src/services/__tests__/ai.service.test.ts`. |

### Test Data Requirements

- A test team on the "Team" plan (BYOK-eligible).
- A test team on the "Free" plan (BYOK-ineligible).
- A test admin user (owner/admin role on the team).
- A test viewer user (viewer role on the team).
- A valid-format test API key: `sk-ant-test-xxxxxxxxxxxxxxxxxxxx` (never hits real Anthropic).
- A `BYOK_ENCRYPTION_SECRET` test value set in the test environment.

### CI Considerations

- The `BYOK_ENCRYPTION_SECRET` for CI is set as a GitHub Actions secret and injected into the test environment.
- All Anthropic API calls are mocked — no real API keys are needed in CI.
- Test cleanup: after each BYOK test, delete any `team_ai_keys` rows created during the test to avoid cross-test contamination.
- Tests should use the `authenticatedPage` fixture from `e2e/fixtures/test-base.ts` and extend it with BYOK-specific setup (team plan, key state).

---

## 11. Implementation Sequence

1. **Database:** Add `team_ai_keys` and `ai_usage_log` tables via Drizzle migration.
2. **Encryption service:** Create `apps/api/src/services/encryption.service.ts` with AES-256-GCM encrypt/decrypt utilities.
3. **API routes:** Add BYOK endpoints to `apps/api/src/routes/teams.ts` (or a new `apps/api/src/routes/ai-keys.ts`).
4. **AI service refactor:** Update `ai.service.ts` to accept `teamId`, implement `resolveClient()` with caching.
5. **Usage logging:** Add token logging after each AI response in `ai.service.ts`.
6. **Frontend:** Build the AI Configuration settings tab and Add Key modal in `apps/web/`.
7. **Tier gating:** Wire up Stripe plan checks in the API and conditional rendering in the UI.
8. **E2E tests:** Write Playwright tests for all flows above.
9. **Unit tests:** Vitest tests for encryption round-trip, client resolution logic, and usage aggregation.

---

## References

- `apps/api/src/lib/config.ts` — Current `ANTHROPIC_API_KEY` loading via Zod env schema
- `apps/api/src/services/ai.service.ts` — Current singleton AI client and all AI methods
- `apps/api/src/routes/teams.ts` — Team management routes and `requireRole` pattern
- `apps/api/src/db/schema.ts` — Current `teams` and `teamMembers` table definitions
- `.agentpolicy/governance.json` — Coding convention `ai-provider-abstraction` requiring BYOK support
