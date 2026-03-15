# Jira & Confluence OAuth Flows

Nyx integrates with Jira and Confluence via Atlassian's OAuth 2.0 (3LO) protocol. Because both products share a single Atlassian identity, a single OAuth connection grants access to both. An alternative manual API token flow supports Jira Server / Data Center instances that do not support OAuth.

---

## 1. Overview

| Integration | Protocol | Atlassian product family |
|---|---|---|
| Jira Cloud | OAuth 2.0 (3LO) | Atlassian Cloud |
| Confluence Cloud | OAuth 2.0 (3LO) | Atlassian Cloud (shared identity) |
| Jira Server / Data Center | Personal API token (manual) | Self-hosted |

GitHub OAuth is already implemented. The Jira and Confluence connect buttons currently render a 1.5-second spinner and do nothing; this document specifies the real implementation.

---

## 2. Jira OAuth 2.0 (3LO) Flow

### 2.1 Flow Overview

```
User clicks "Connect Jira"
    │
    ▼
GET /api/integrations/jira/connect
    │  Generates state token, stores in session
    │
    ▼
Redirect → https://auth.atlassian.com/authorize
    │  params: client_id, redirect_uri, scope, state, response_type=code,
    │          prompt=consent, audience=api.atlassian.com
    │
    ▼
User logs in / grants consent on Atlassian
    │
    ▼
Redirect → /api/integrations/jira/callback?code=...&state=...
    │  Validates state token
    │  POST to https://auth.atlassian.com/oauth/token
    │  Fetches accessible resources (cloud IDs)
    │
    ▼
Store integration record in `integrations` table
    │
    ▼
Redirect → /settings/integrations?connected=jira
```

### 2.2 Required Scopes

Request the minimum scopes needed at connect time. Additional scopes require a new consent flow.

| Scope | Purpose |
|---|---|
| `read:jira-user` | Identify the connected user |
| `read:jira-work` | Read issues, projects, and boards |
| `write:jira-work` | Create and update issues |
| `offline_access` | Obtain a refresh token |
| `read:me` | Basic Atlassian profile (shared with Confluence) |

### 2.3 Token Exchange

**Request:**
```
POST https://auth.atlassian.com/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "client_id": "<ATLASSIAN_CLIENT_ID>",
  "client_secret": "<ATLASSIAN_CLIENT_SECRET>",
  "code": "<authorization_code>",
  "redirect_uri": "https://api.nyx.so/api/integrations/jira/callback"
}
```

**Response fields used:**

| Field | Description |
|---|---|
| `access_token` | Short-lived access token (1 hour) |
| `refresh_token` | Long-lived token for silent renewal |
| `expires_in` | Seconds until `access_token` expires (typically 3600) |
| `scope` | Space-separated list of granted scopes |

### 2.4 Fetching Cloud IDs

After token exchange, retrieve the list of Atlassian sites the user has access to:

```
GET https://api.atlassian.com/oauth/token/accessible-resources
Authorization: Bearer <access_token>
```

Returns an array of `{ id, name, url, scopes, avatarUrl }` objects. Store all cloud IDs in the integration record so the user can later select which Jira/Confluence site to use.

### 2.5 Callback Handler

```
GET /api/integrations/jira/callback
```

1. Validate `state` matches the session token (CSRF protection).
2. Exchange `code` for tokens.
3. Fetch accessible resources.
4. Upsert the integration record (see §5).
5. Encrypt `access_token` and `refresh_token` before storing.
6. Redirect to `/settings/integrations?connected=jira`.

If any step fails, redirect to `/settings/integrations?error=jira_oauth_failed`.

---

## 3. Confluence OAuth 2.0 Flow

### 3.1 Shared Atlassian Identity

Confluence Cloud uses the same Atlassian OAuth 2.0 authorization server as Jira. A single OAuth connection grants access to both:

- If the user has already connected Jira, Confluence can reuse the **same access/refresh tokens** — no second OAuth round trip is needed.
- If Confluence is connected first, the same token set covers Jira.

The Nyx UI should surface this: when one Atlassian product is connected, the other shows a "Use existing Atlassian connection" prompt instead of a separate OAuth button.

### 3.2 Additional Scopes for Confluence

If Confluence access was not included in the initial Jira consent, an incremental authorization is required. Add to the scope list:

| Scope | Purpose |
|---|---|
| `read:confluence-space.summary` | List spaces |
| `read:confluence-content.all` | Read pages and blog posts |
| `write:confluence-content` | Create and update pages |
| `read:confluence-props` | Read page properties |

Incremental authorization is handled by repeating the OAuth flow with the expanded scope list and `prompt=consent`.

### 3.3 Confluence API Base URL

```
https://api.atlassian.com/ex/confluence/{cloudId}/rest/api
```

The `cloudId` comes from the accessible-resources call (§2.4). Store it in the integration's `config` JSONB alongside the Jira cloud ID.

---

## 4. Manual API Token Configuration (Jira Server / Data Center)

Users on self-hosted Jira who cannot use OAuth can authenticate with a personal API token or basic auth credentials.

### 4.1 Configuration Form Fields

| Field | Type | Notes |
|---|---|---|
| `base_url` | URL | e.g. `https://jira.yourcompany.com` |
| `username` | string | Jira username / email |
| `api_token` | password | Jira API token (generated at id.atlassian.com) |
| `project_key` | string (optional) | Default project for ticket creation |

### 4.2 Validation

On save, the API performs a test request:

```
GET {base_url}/rest/api/2/myself
Authorization: Basic base64(username:api_token)
```

If the response is not `200 OK`, return a validation error to the UI.

### 4.3 Storage

Store credentials in the integration record's `config` JSONB. Encrypt `api_token` with the workspace encryption key (same pattern as OAuth tokens). Set `auth_method = 'token'` on the record.

---

## 5. Integration Record & `config` JSONB Schema

### 5.1 `integrations` Table

```sql
CREATE TABLE integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,          -- 'jira' | 'confluence' | 'github'
  auth_method     TEXT NOT NULL,          -- 'oauth' | 'token'
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'error' | 'expired' | 'disconnected'
  config          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);
```

### 5.2 OAuth `config` Shape

```jsonc
{
  // Encrypted tokens (stored as encrypted strings, decrypted in-memory only)
  "accessToken": "<encrypted>",
  "refreshToken": "<encrypted>",
  "tokenExpiresAt": "2026-03-15T11:00:00Z",   // ISO-8601 UTC
  "scopes": ["read:jira-work", "write:jira-work", "offline_access", "read:me"],

  // Atlassian site metadata (from accessible-resources)
  "cloudResources": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "name": "My Company",
      "url": "https://mycompany.atlassian.net",
      "avatarUrl": "https://..."
    }
  ],

  // Active site selection (user-configurable after connect)
  "selectedJiraCloudId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "selectedConfluenceCloudId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",

  // Jira-specific defaults
  "defaultProjectKey": "ENG",             // optional
  "defaultIssueType": "Task",             // optional

  // Confluence-specific defaults
  "defaultSpaceKey": "DOCS"               // optional
}
```

### 5.3 Manual Token `config` Shape

```jsonc
{
  "baseUrl": "https://jira.yourcompany.com",
  "username": "user@company.com",
  "apiToken": "<encrypted>",
  "defaultProjectKey": "ENG"             // optional
}
```

### 5.4 Encryption

All secrets (`accessToken`, `refreshToken`, `apiToken`) are encrypted with AES-256-GCM using a per-workspace key derived from `ENCRYPTION_MASTER_KEY`. Never store plaintext tokens in the database.

```
ENCRYPTION_MASTER_KEY=<32-byte hex>   # set in environment
```

---

## 6. Settings UI

### 6.1 Integration Cards

The `/settings/integrations` page shows one card per provider:

```
┌─────────────────────────────────────────────┐
│  🔵 Jira                         [Connected] │
│  Connected to: My Company (mycompany.atl…)   │
│  Account: user@company.com                   │
│  Scopes: read, write                         │
│                     [Configure]  [Disconnect]│
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  🔷 Confluence           [Use Jira connection]│
│  ✓ Enabled via existing Atlassian connection │
│                                   [Configure]│
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  ⚪ Jira Server / Data Center   [Not connected]│
│  Use personal API token instead of OAuth    │
│                              [Configure →]  │
└─────────────────────────────────────────────┘
```

### 6.2 Connect Flow

1. User clicks **Connect Jira** → navigates to `/api/integrations/jira/connect`.
2. After OAuth, page reloads with `?connected=jira` query param.
3. UI shows a success toast: "Jira connected to [site name]".
4. Card updates to "Connected" state.

### 6.3 Status Indicators

| Status | Visual | Trigger |
|---|---|---|
| `active` | Green badge "Connected" | Successful OAuth or token validation |
| `error` | Red badge "Error" + message | API call failed with non-401 error |
| `expired` | Yellow badge "Token expired" | Refresh token rejected by Atlassian |
| `disconnected` | Grey badge "Not connected" | User disconnected or record deleted |

### 6.4 Disconnect Flow

1. User clicks **Disconnect**.
2. Confirmation dialog: "This will remove Nyx's access to Jira. Any documents linked to Jira tickets will lose their sync."
3. On confirm: `DELETE /api/integrations/jira` — revokes token at Atlassian (`POST https://auth.atlassian.com/oauth/token/revoke`) and deletes the integration record.
4. Card returns to "Not connected" state.

### 6.5 Error States

- **OAuth denied by user:** redirect from Atlassian includes `error=access_denied`. Show: "Jira authorization was cancelled."
- **Token exchange failed:** show: "Could not connect to Jira. Please try again."
- **No accessible resources:** user authenticated but has no Atlassian sites. Show: "No Jira or Confluence sites found on this account."
- **Manual token invalid:** show inline form validation: "Could not authenticate. Check your username and API token."

---

## 7. Token Refresh and Expiry Handling

### 7.1 Proactive Refresh

Access tokens expire after 1 hour. Refresh proactively before making API calls:

```
if (tokenExpiresAt - now() < 5 minutes) {
  refresh()
}
```

### 7.2 Refresh Request

```
POST https://auth.atlassian.com/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "client_id": "<ATLASSIAN_CLIENT_ID>",
  "client_secret": "<ATLASSIAN_CLIENT_SECRET>",
  "refresh_token": "<stored_refresh_token>"
}
```

On success: update `config.accessToken`, `config.refreshToken`, `config.tokenExpiresAt`, and `integrations.updated_at`.

### 7.3 Refresh Failure

If the refresh request returns `400 invalid_grant`:
1. Set `integrations.status = 'expired'`.
2. Fire a `integration.token_expired` internal event.
3. Optionally notify the workspace admin via in-app notification (see notifications feature doc).
4. Return a `401 Unauthorized` to any caller that triggered the refresh attempt.

### 7.4 Retry Policy

Wrap every Atlassian API call with a single automatic refresh attempt on `401`. If the refreshed call also fails, surface the error to the caller and mark the integration as `expired`. Do not retry indefinitely.

---

## 8. Atlassian App Permissions

The Nyx Atlassian OAuth app must be registered at [developer.atlassian.com](https://developer.atlassian.com) with:

| Setting | Value |
|---|---|
| App type | OAuth 2.0 (3LO) |
| Redirect URI | `https://api.nyx.so/api/integrations/jira/callback` |
| Granular scopes | (see §2.2 and §3.2) |
| Distribution | Enabled (for workspaces outside dev account) |

**Environment variables required:**

```
ATLASSIAN_CLIENT_ID=<from developer.atlassian.com>
ATLASSIAN_CLIENT_SECRET=<from developer.atlassian.com>
ATLASSIAN_REDIRECT_URI=https://api.nyx.so/api/integrations/jira/callback
```

For local development, register a separate app with `redirect_uri=http://localhost:3001/api/integrations/jira/callback` and use a `.env.local` override.

---

## 9. How This Unblocks Confluence Integration (#33)

Issue #33 (Confluence integration) is blocked on authentication. Once this OAuth flow is implemented:

- The `selectedConfluenceCloudId` in the integration config provides the `cloudId` needed for all Confluence API calls.
- Confluence API requests use the same access token and refresh logic as Jira.
- The Confluence feature implementation (#33) can assume `GET /api/integrations/confluence/config` returns a ready-to-use cloud ID and bearer token.

---

## 10. API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/integrations/jira/connect` | Initiate OAuth flow (redirects to Atlassian) |
| `GET` | `/api/integrations/jira/callback` | OAuth callback handler |
| `GET` | `/api/integrations/:provider/status` | Get integration status for the workspace |
| `GET` | `/api/integrations/:provider/config` | Get non-secret config (cloud IDs, defaults) |
| `PATCH` | `/api/integrations/:provider/config` | Update defaults (project key, space key, etc.) |
| `DELETE` | `/api/integrations/:provider` | Disconnect and revoke tokens |
| `POST` | `/api/integrations/jira/token` | Save manual API token (Jira Server) |
| `POST` | `/api/integrations/:provider/refresh` | Manually trigger token refresh |

All endpoints require a Clerk session JWT. Only workspace `admin` or `owner` roles may connect or disconnect integrations.

---

## 11. E2E Testing

### 11.1 Critical User Flows

1. **Jira OAuth connect flow** — user clicks Connect Jira, completes Atlassian OAuth consent, and lands back on the settings page with Jira showing "Connected".
2. **Confluence enabled via Jira connection** — after Jira is connected, the Confluence card automatically shows "Enabled via existing Atlassian connection" without a separate OAuth step.
3. **Token refresh on expiry** — access token is expired; the next Jira API call silently refreshes the token and succeeds.
4. **Token refresh failure → integration marked expired** — the refresh token is revoked; the integration status updates to "Token expired" and a notification is shown.
5. **Disconnect and reconnect** — user disconnects Jira, confirms the dialog, card reverts to "Not connected"; user reconnects and Jira is active again.
6. **Manual API token connect (Jira Server)** — user fills the manual token form with valid credentials, form validates, integration is saved as `auth_method=token`.
7. **Manual API token validation failure** — user enters wrong credentials; inline error message appears without saving the record.

### 11.2 Test Scenarios (Given/When/Then)

**Scenario 1: Jira OAuth happy path**
```
Given: The workspace has no Jira integration
  And: The user is a workspace admin
When: The user clicks "Connect Jira"
  And: Completes Atlassian OAuth consent
Then: The integrations table has a new row with provider='jira' and status='active'
  And: The settings page shows "Connected" with the Atlassian site name
  And: A success toast appears
```

**Scenario 2: Confluence auto-enabled after Jira connect**
```
Given: The workspace Jira integration is 'active'
  And: The granted scopes include Confluence scopes
When: The user views the Integrations settings page
Then: The Confluence card shows "Use existing Atlassian connection" (not an OAuth button)
  And: No separate OAuth flow is required for Confluence
```

**Scenario 3: Silent token refresh**
```
Given: The Jira integration's tokenExpiresAt is in the past (< 5 min remaining)
When: Any server-side code calls the Jira API
Then: The API first calls /oauth/token with grant_type=refresh_token
  And: The new access token is stored in the integration config
  And: The original API call proceeds with the new token
  And: The caller receives a successful response
```

**Scenario 4: Token refresh failure**
```
Given: The Jira integration's refresh token has been revoked in Atlassian
When: The system attempts to refresh the token
Then: The Atlassian token endpoint returns 400 invalid_grant
  And: integrations.status is set to 'expired'
  And: The caller receives 401 Unauthorized
  And: An in-app notification is sent to workspace admins
```

**Scenario 5: Disconnect Jira**
```
Given: The workspace has an active Jira integration
When: The user clicks "Disconnect" and confirms the dialog
Then: DELETE /api/integrations/jira is called
  And: Token revocation is sent to Atlassian
  And: The integrations row is deleted
  And: The card shows "Not connected"
  And: Confluence card reverts to showing an OAuth connect button
```

**Scenario 6: Manual API token — valid credentials**
```
Given: The user selects "Jira Server / Data Center" configuration
When: The user enters a valid base_url, username, and api_token
  And: Clicks "Save"
Then: The API validates credentials via GET /rest/api/2/myself
  And: The integration is saved with auth_method='token' and status='active'
  And: The settings card shows "Connected (API token)"
```

**Scenario 7: Manual API token — invalid credentials**
```
Given: The user is on the Jira Server configuration form
When: The user enters an incorrect api_token
  And: Clicks "Save"
Then: The API returns a validation error
  And: The form shows "Could not authenticate. Check your username and API token."
  And: No integration record is created or modified
```

### 11.3 Integration Boundaries

| External Service | Test Strategy |
|---|---|
| Atlassian OAuth (`auth.atlassian.com`) | Mock with a local HTTP interceptor (e.g. `msw` or a Fastify test server). Intercept `/authorize`, `/oauth/token`, and `/oauth/token/accessible-resources`. |
| Atlassian API (`api.atlassian.com`) | Mock all API calls in E2E; test the real API only in optional manual smoke tests. |
| Token revocation endpoint | Mock; assert that revocation is called on disconnect. |
| Jira Server (self-hosted) | Use a stub HTTP server that returns `{ accountId, displayName }` for valid credentials and `401` for invalid. |
| Clerk auth | Use the existing `authenticatedPage` fixture. |

### 11.4 Test Data Requirements

- **Workspace with admin user:** the `authenticatedPage` fixture user must be a workspace `admin` or `owner` (required to connect integrations).
- **Mock Atlassian authorization server:** a local server fixture (`e2e/fixtures/atlassian-mock-server.ts`) that:
  - Accepts the `/authorize` redirect and immediately redirects back with a valid `code` and `state`.
  - Handles `/oauth/token` (authorization_code and refresh_token grants) and returns controlled token responses.
  - Handles `/oauth/token/accessible-resources` and returns a fixture cloud resource list.
  - Handles `/oauth/token/revoke`.
- **Expired token fixture:** a helper that writes an integration row with `tokenExpiresAt` in the past to simulate refresh scenarios.
- **Revoked refresh token fixture:** configure the mock Atlassian server to return `400 invalid_grant` for a specific refresh token value.

### 11.5 Playwright Test File Locations

```
e2e/
  integrations/
    jira-oauth-connect.spec.ts        # OAuth happy path, connect/disconnect flows
    confluence-shared-auth.spec.ts    # Confluence auto-enable after Jira connect
    token-refresh.spec.ts             # Silent refresh, refresh failure, expiry state
    jira-manual-token.spec.ts         # Manual API token form: valid, invalid, disconnect
    integration-status-ui.spec.ts     # Status badges, error states, UI transitions
  fixtures/
    atlassian-mock-server.ts          # Local mock of Atlassian OAuth endpoints
    integration-helpers.ts            # Seed/teardown helpers for integration records
```

### 11.6 CI Considerations

**Environment variables required in CI:**

```
ATLASSIAN_CLIENT_ID=test-client-id
ATLASSIAN_CLIENT_SECRET=test-client-secret
ATLASSIAN_REDIRECT_URI=http://localhost:3001/api/integrations/jira/callback
ENCRYPTION_MASTER_KEY=<32-byte test key>
DATABASE_URL=<test database>
```

- **No real Atlassian calls in CI:** all Atlassian OAuth and API traffic must go through the `atlassian-mock-server.ts` fixture. Inject the mock server's base URL via `ATLASSIAN_BASE_URL` environment variable (the production code should honor this override when set).
- **Database:** use `drizzle-kit push --force` to apply the `integrations` table schema before tests run (consistent with existing CI setup).
- **Port isolation:** the mock Atlassian server should bind to a random port to avoid conflicts; the fixture should pass the port to the test via `baseURL`.
- **Test isolation:** each spec file should create its own integration records via `integration-helpers.ts` and delete them in `afterEach`/`afterAll` to prevent cross-test state leakage.
- **Parallel-safe:** integration records are scoped to a per-test workspace ID to avoid row conflicts when Playwright runs tests in parallel workers.
