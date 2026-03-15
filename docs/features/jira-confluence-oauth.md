# Jira & Confluence OAuth Integration

## Overview

Nyx integrates with Atlassian's Jira and Confluence products using OAuth 2.0 (3LO — three-legged OAuth). This allows users to connect their Atlassian account to Nyx so that specs can be pushed as Jira issues and exported as Confluence pages, while changes in those external systems flow back into Nyx.

The integration covers:

- **Jira**: Creating and syncing issues from Nyx specs, with real-time status updates via webhooks.
- **Confluence**: Exporting Nyx documents to Confluence pages and importing existing Confluence content into Nyx.

All communication with Atlassian APIs is authenticated via user-scoped OAuth tokens stored encrypted in the database.

---

## OAuth 2.0 Flow

Nyx uses the [Atlassian OAuth 2.0 (3LO) authorization code grant](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) with PKCE support.

### Endpoints

| Purpose       | URL                                          |
| ------------- | -------------------------------------------- |
| Authorization | `https://auth.atlassian.com/authorize`       |
| Token         | `https://auth.atlassian.com/oauth/token`     |
| Revocation    | `https://auth.atlassian.com/oauth/revoke`    |

### Required Scopes

| Scope                              | Purpose                                    |
| ---------------------------------- | ------------------------------------------ |
| `read:jira-work`                   | Read Jira issues, projects, and metadata   |
| `write:jira-work`                  | Create and update Jira issues              |
| `read:confluence-content.all`      | Read Confluence pages and spaces           |
| `write:confluence-content.all`     | Create and update Confluence pages         |
| `offline_access`                   | Obtain a refresh token for long-lived access |

### Authorization Request

```
GET https://auth.atlassian.com/authorize
  ?audience=api.atlassian.com
  &client_id={ATLASSIAN_CLIENT_ID}
  &scope=read:jira-work write:jira-work read:confluence-content.all write:confluence-content.all offline_access
  &redirect_uri={BASE_URL}/api/integrations/atlassian/callback
  &state={CSRF_STATE_TOKEN}
  &response_type=code
  &prompt=consent
  &code_challenge={PKCE_CODE_CHALLENGE}
  &code_challenge_method=S256
```

### PKCE Support

Nyx generates a cryptographically random `code_verifier` (minimum 43 characters) for each authorization request. The `code_challenge` is the Base64-URL-encoded SHA-256 hash of the verifier. The verifier is stored server-side (keyed by the `state` parameter) and sent in the token exchange request.

### Redirect URI

```
/api/integrations/atlassian/callback
```

The callback handler:

1. Validates the `state` parameter against the stored CSRF token.
2. Exchanges the authorization `code` for access and refresh tokens using the stored PKCE `code_verifier`.
3. Calls `https://api.atlassian.com/oauth/token/accessible-resources` to retrieve the user's Atlassian Cloud site IDs.
4. Stores the tokens and site metadata in the database (see Token Management).
5. Redirects the user back to the Nyx settings page with a success indicator.

---

## Token Management

### Storage

Tokens are stored in the `atlassian_connections` table:

| Column              | Type        | Description                                |
| ------------------- | ----------- | ------------------------------------------ |
| `id`                | `uuid`      | Primary key                                |
| `user_id`           | `uuid`      | FK to `users` table                        |
| `organization_id`   | `uuid`      | FK to `organizations` table                |
| `access_token`      | `text`      | AES-256-GCM encrypted access token         |
| `refresh_token`     | `text`      | AES-256-GCM encrypted refresh token        |
| `token_expires_at`  | `timestamp` | Access token expiry time                   |
| `cloud_id`          | `text`      | Atlassian Cloud site identifier            |
| `site_url`          | `text`      | Atlassian site URL                         |
| `scopes`            | `text[]`    | Granted scopes                             |
| `created_at`        | `timestamp` | Connection creation time                   |
| `updated_at`        | `timestamp` | Last token refresh time                    |

All token values are encrypted at rest using AES-256-GCM with a key derived from the `ENCRYPTION_SECRET` environment variable. The initialization vector (IV) is stored alongside the ciphertext.

### Refresh Token Rotation

Atlassian access tokens expire after approximately 1 hour. Nyx handles this transparently:

1. Before each Atlassian API call, check whether `token_expires_at` is within a 5-minute buffer window.
2. If the token is about to expire or has expired, send a refresh request:
   ```
   POST https://auth.atlassian.com/oauth/token
   Content-Type: application/json

   {
     "grant_type": "refresh_token",
     "client_id": "{ATLASSIAN_CLIENT_ID}",
     "client_secret": "{ATLASSIAN_CLIENT_SECRET}",
     "refresh_token": "{STORED_REFRESH_TOKEN}"
   }
   ```
3. Store the new access token, refresh token, and updated expiry.
4. Retry the original API call with the fresh token.

If a refresh fails with a `401` or `400` status, the connection is marked as `disconnected` and the user is prompted to re-authorize.

### Revocation Flow

When a user disconnects their Atlassian account from Nyx:

1. Call the revocation endpoint for the access token:
   ```
   POST https://auth.atlassian.com/oauth/revoke
   Content-Type: application/json

   {
     "client_id": "{ATLASSIAN_CLIENT_ID}",
     "token": "{ACCESS_TOKEN}"
   }
   ```
2. Delete the `atlassian_connections` row for the user.
3. Remove any cached Atlassian metadata (projects, spaces).
4. Log the disconnection event in the audit log.

---

## Jira Integration

### Creating Issues from Nyx Specs

When a user creates a ticket from a Nyx spec section, the following mapping is used:

| Nyx Field            | Jira Field       | Notes                                       |
| -------------------- | ---------------- | ------------------------------------------- |
| Section title        | `summary`        | Truncated to 255 characters                 |
| Section body         | `description`    | Converted to Atlassian Document Format (ADF) |
| Spec name            | `labels`         | Added as a label for traceability           |
| Nyx spec URL         | `description`    | Appended as a link at the bottom            |
| Priority (if set)    | `priority`       | Maps to Jira priority IDs                   |
| Assignee (if set)    | `assignee`       | Matched by Atlassian account ID             |

### Supported Issue Types

Nyx supports creating the following Jira issue types (configurable per project):

- **Task** (default)
- **Story**
- **Bug**
- **Epic** (when a full spec is converted)

The available issue types are fetched dynamically from the target Jira project's metadata via `GET /rest/api/3/issue/createmeta`.

### Syncing Issue Status

Nyx tracks the lifecycle of issues it created:

| Jira Status Category | Nyx Status      |
| -------------------- | --------------- |
| `To Do`              | `pending`       |
| `In Progress`        | `in_progress`   |
| `Done`               | `completed`     |

Status is updated via webhooks (preferred) or periodic polling as a fallback.

### Webhook Setup

Nyx registers a Jira webhook when a project is first connected:

```
POST /rest/api/3/webhook
{
  "url": "{BASE_URL}/api/integrations/jira/webhook",
  "webhooks": [
    {
      "events": [
        "jira:issue_updated",
        "jira:issue_deleted"
      ],
      "jqlFilter": "project = {PROJECT_KEY}"
    }
  ]
}
```

Incoming webhook payloads are validated using the webhook secret and processed asynchronously via a background job queue.

---

## Confluence Integration

### Exporting Nyx Documents to Confluence

Users can export a Nyx document to a Confluence space as a new page or update an existing linked page.

**Export flow:**

1. User selects a target Confluence space and optional parent page.
2. Nyx converts the document from its internal format to Atlassian Document Format (ADF).
3. The page is created or updated via the Confluence REST API:
   ```
   POST /wiki/api/v2/pages
   {
     "spaceId": "{SPACE_ID}",
     "status": "current",
     "title": "{DOCUMENT_TITLE}",
     "parentId": "{PARENT_PAGE_ID}",
     "body": {
       "representation": "atlas_doc_format",
       "value": "{ADF_JSON}"
     }
   }
   ```
4. The Confluence page ID is stored in Nyx for future updates.

### Importing Confluence Pages

Users can import an existing Confluence page into Nyx:

1. User browses their Confluence spaces and selects a page.
2. Nyx fetches the page content via `GET /wiki/api/v2/pages/{id}?body-format=atlas_doc_format`.
3. The ADF content is converted to Nyx's internal document format.
4. A new Nyx document is created with a link back to the source Confluence page.

### Two-Way Sync Considerations

Full two-way sync between Nyx and Confluence is complex due to concurrent editing. Nyx takes the following approach:

- **Nyx is the source of truth.** Edits made in Nyx are pushed to Confluence on demand or on a configurable schedule.
- **Confluence edits are treated as suggestions.** When Nyx detects that a linked Confluence page has been modified externally (via version number comparison), it surfaces a notification to the user with a diff view rather than auto-merging.
- **Conflict resolution** is always manual. The user chooses to accept the Confluence changes, overwrite with the Nyx version, or merge manually.

---

## Settings UI

The Atlassian integration settings are available at **Settings > Integrations > Atlassian**.

### Connect / Disconnect

- **Connect button**: Initiates the OAuth 2.0 flow, redirecting the user to Atlassian's consent screen.
- **Disconnect button**: Triggers the revocation flow and removes the stored connection. Requires confirmation.

### Connection Status Indicator

| State          | Indicator                              |
| -------------- | -------------------------------------- |
| Connected      | Green dot with site name and user info |
| Token expired  | Yellow dot with "Re-authorize" prompt  |
| Disconnected   | Gray dot with "Connect" button         |
| Error          | Red dot with error message             |

### Project and Space Selection

Once connected, the user can configure:

- **Jira project**: Dropdown populated from `GET /rest/api/3/project/search`. Determines which project receives issues created from Nyx.
- **Confluence space**: Dropdown populated from `GET /wiki/api/v2/spaces`. Determines the default target space for document exports.

### Sync Preferences

| Setting                     | Options                           | Default       |
| --------------------------- | --------------------------------- | ------------- |
| Auto-export on publish      | Enabled / Disabled                | Disabled      |
| Jira status sync            | Webhooks / Polling / Disabled     | Webhooks      |
| Polling interval (fallback) | 5 min / 15 min / 30 min / 1 hour | 15 min        |
| Confluence change detection | Enabled / Disabled                | Enabled       |

---

## Security Considerations

### Token Encryption at Rest

- All OAuth tokens (access and refresh) are encrypted using AES-256-GCM before being stored in the database.
- The encryption key is derived from the `ENCRYPTION_SECRET` environment variable using HKDF.
- Initialization vectors are unique per encryption operation and stored alongside the ciphertext.
- Tokens are decrypted only in memory at the moment they are needed for an API call and are never logged.

### Scope Minimization

- Nyx requests only the scopes necessary for its documented functionality.
- No admin-level scopes are requested. Nyx operates within the permissions of the connecting user's Atlassian account.
- If a user lacks permission for a particular Jira project or Confluence space, the Atlassian API returns a `403` and Nyx surfaces a clear error message.

### Audit Logging

All Atlassian API interactions are recorded in the audit log:

| Field            | Description                                    |
| ---------------- | ---------------------------------------------- |
| `timestamp`      | Time of the API call                           |
| `user_id`        | Nyx user who triggered the action              |
| `action`         | Operation type (e.g., `jira.issue.create`)     |
| `resource`       | Target resource (e.g., Jira issue key)         |
| `status_code`    | HTTP response status from Atlassian            |
| `error_message`  | Error details, if any (tokens are redacted)    |

Audit logs are retained for 90 days by default and are accessible to organization admins in the Nyx dashboard.

### Rate Limiting

Nyx respects Atlassian's rate limits and implements exponential backoff with jitter. If a `429 Too Many Requests` response is received, the request is retried after the duration specified in the `Retry-After` header.

---

## E2E Test Spec

The following end-to-end tests validate the Atlassian integration. Tests use mocked Atlassian API responses via the `authenticatedPage` fixture and a stubbed OAuth flow.

### OAuth Flow Tests

| Test                                | Assertion                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| OAuth redirect initiates correctly  | Clicking "Connect" navigates to `auth.atlassian.com/authorize` with correct query params (client ID, scopes, PKCE challenge, state). |
| Callback exchanges code for tokens  | Simulated callback with valid `code` and `state` results in tokens stored in the database and the UI showing a connected state. |
| Invalid state is rejected           | Callback with a mismatched `state` parameter returns a `400` error and no tokens are stored. |

### Token Management Tests

| Test                                | Assertion                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Token refresh works when expired    | An API call with an expired access token triggers a refresh request, stores the new tokens, and completes the original operation. |
| Refresh failure marks disconnected  | A failed refresh (simulated `401` from Atlassian) updates the connection status to "disconnected" and prompts re-authorization. |
| Disconnect revokes tokens           | Clicking "Disconnect" sends a revocation request and removes the connection row from the database. |

### Jira Integration Tests

| Test                                | Assertion                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Jira issue creation from spec       | Creating a ticket from a spec section sends a `POST /rest/api/3/issue` request with correct summary, description (ADF), and labels. |
| Issue status sync via webhook       | A simulated webhook payload for `jira:issue_updated` updates the corresponding Nyx spec section status. |
| Project selection persists          | Selecting a Jira project in settings saves the selection and uses it for subsequent issue creation. |

### Confluence Integration Tests

| Test                                | Assertion                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Confluence export produces correct page | Exporting a Nyx document sends a `POST /wiki/api/v2/pages` request with correctly converted ADF content and the selected space ID. |
| Confluence import creates document  | Importing a Confluence page fetches its content and creates a new Nyx document with the converted content. |
| External edit detection             | When a linked Confluence page has a newer version, Nyx displays a notification with a diff view. |
