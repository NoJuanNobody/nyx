# Slack Integration — Implementation Execution Plan

This document provides a sequenced, task-level plan for completing and hardening the Slack integration defined in [`docs/features/slack-integration.md`](../features/slack-integration.md).

The integration already has a working OAuth flow, event endpoints, and a functional frontend component. Work here focuses on closing the critical gaps that prevent the feature from being considered production-ready: wiring the message pipeline, securing the token store, adding outbound notification sending, and filling in operational gaps.

---

## Current State Summary

| Layer | Status |
|-------|--------|
| DB schema (`slack_connections`) | ✅ Complete |
| OAuth install/callback endpoints | ✅ Complete |
| Events API endpoint | ✅ Complete |
| Slash command endpoint | ✅ Complete |
| Connection CRUD endpoints | ✅ Complete |
| Frontend `SlackIntegration` component | ✅ Complete |
| Request signature verification | ✅ Complete |
| `processSlackMessage()` — intake wiring | ❌ Placeholder only |
| Outbound `sendSlackMessage()` for notifications | ❌ Missing |
| Token encryption at rest | ❌ Plain text |
| Channel picker UI | ❌ Manual channel ID only |
| Error logging and retry | ❌ Silent failures |
| `.env.example` documentation | ❌ Missing |
| Audit log entries | ❌ Missing |
| Rate limiting | ❌ Missing |

---

## Phase 0: Prerequisites

Before any work begins, verify:

- [ ] `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` are provisioned in the Slack app dashboard and available as secrets in the deployment environment (Railway/Render).
- [ ] The Slack app's Redirect URL is set to `{BASE_URL}/api/slack/callback`.
- [ ] The Events API Request URL is set to `{BASE_URL}/api/slack/events` and Slack has verified it (the `url_verification` challenge handler is already in place).
- [ ] The `/nyx` slash command Request URL is set to `{BASE_URL}/api/slack/command`.
- [ ] The `slack_connections` migration (`0011_slack_connections.sql`) has been applied to the target database.

---

## Phase 1: Environment Variable Documentation

**Goal:** Ensure every developer can set up Slack locally without reverse-engineering env vars from the config schema.

### 1.1 Update `.env.example`

File: `.env.example`

Add a `# Slack Integration` section with the three required variables and brief inline comments:

```bash
# Slack Integration
# Create a Slack app at https://api.slack.com/apps and copy credentials from Basic Information
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
```

**Acceptance criteria:** A new developer can follow `.env.example` to set up a working local Slack integration without reading source code.

---

## Phase 2: Wire `processSlackMessage()` to the Intake Pipeline

**Goal:** Slack messages actually create intake sessions in Nyx instead of being silently discarded.

### 2.1 Identify the Intake Entry Point

Locate the function or service that other intake channels (e.g., the web UI's manual intake form) call to create a new intake session. It will likely be in `apps/api/src/services/` or `apps/api/src/routes/intake*`. This is the target we wire Slack to.

### 2.2 Update `processSlackMessage()`

File: `apps/api/src/services/slack.service.ts`

Replace the placeholder implementation with a real call to the intake service:

```ts
import { intakeService } from './intake.service.js'; // adjust import

export async function processSlackMessage(
  text: string,
  teamId: string,
  userId: string,
  channelId: string,
): Promise<{ summary: string; source: string }> {
  if (!text.trim()) {
    return { summary: 'Empty message, skipped.', source: 'slack' };
  }

  const session = await intakeService.createSession({
    teamId,
    source: 'slack',
    sourceUserId: userId,
    sourceChannelId: channelId,
    rawContent: text,
  });

  return {
    summary: session.title ?? `Intake session ${session.id} created`,
    source: 'slack',
  };
}
```

The exact API depends on the intake service's interface. Adjust field names to match.

### 2.3 Handle Empty Text Gracefully

Ensure the reaction-trigger pathway (which sends `[Reaction trigger: :emoji:]` as the text) produces a meaningful intake entry or is handled separately with additional context fetching (e.g., fetching the original message text via the Slack Web API using the bot token).

**Acceptance criteria:**
- Sending `/nyx hello world` creates a new intake session in the Nyx database.
- Reacting with `:nyx:` on a message creates an intake session linked to the original message.
- Empty or whitespace-only inputs are gracefully skipped without error.

---

## Phase 3: Encrypt the Bot Token at Rest

**Goal:** Bot tokens must not be stored as plain text in the database.

### 3.1 Review Existing Encryption Pattern

Read `apps/api/src/services/` or `apps/api/src/lib/` for any existing encryption utilities (e.g., used for `teamAiKeys` or Jira/Confluence tokens). If an `encrypt(value: string): string` / `decrypt(value: string): string` pair already exists, reuse it.

### 3.2 Add Encryption on Write, Decryption on Read

Wrap the `slackBotToken` field whenever it is written or read:

**On write** (in `GET /api/slack/callback`):
```ts
slackBotToken: encrypt(tokenData.access_token),
```

**On read** (wherever `connection.slackBotToken` is used for API calls):
```ts
const rawToken = decrypt(connection.slackBotToken);
```

### 3.3 Migration for Existing Tokens

If there are any existing rows in `slack_connections` (e.g., in staging), write a one-time migration script to re-encrypt them. Do **not** handle this in application code — use a standalone Drizzle migration or a script in `scripts/`.

### 3.4 Environment Variable for Encryption Key

Add `ENCRYPTION_KEY` (or reuse whatever key name the existing pattern uses) to `.env.example`.

**Acceptance criteria:**
- `slack_bot_token` column contains encrypted ciphertext, not a plain `xoxb-*` token.
- Encryption/decryption round-trips correctly verified by a unit test.
- A developer rotating the encryption key can do so without invalidating existing connections (if key rotation is supported by the existing pattern).

---

## Phase 4: Add Outbound Notification Sending

**Goal:** Nyx can proactively send messages to a Slack channel when key events occur.

### 4.1 Add `sendSlackMessage()` to the Service

File: `apps/api/src/services/slack.service.ts`

```ts
/**
 * Send a message to a Slack channel using the bot token.
 */
export async function sendSlackMessage(
  botToken: string,
  channelId: string,
  message: { text?: string; blocks?: unknown[] },
): Promise<void> {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, ...message }),
  });

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }
}
```

Update `slackService` export to include this function.

### 4.2 Define Notification Events

Identify the events that should trigger Slack notifications. Candidates (confirm with product):

| Event | Default Slack Message |
|-------|-----------------------|
| Document lifecycle stage change | "📄 *{doc title}* moved to **{stage}** by {user}" |
| Spec drift detected | "⚠️ Drift detected between *{doc}* and `{repo}/{path}`" |
| Ticket created from spec | "🎟 Ticket #{id} created: {title}" |
| Document comment / mention | "{user} mentioned you in *{doc title}*" |

### 4.3 Add Notification Channel Field to `slack_connections`

Add a `notificationChannelId` column to the `slack_connections` table and a Drizzle migration:

```sql
ALTER TABLE slack_connections
  ADD COLUMN notification_channel_id TEXT;
```

Drizzle schema update in `apps/api/src/db/schema.ts`:
```ts
notificationChannelId: text('notification_channel_id'),
```

### 4.4 Expose Notification Channel in the Settings UI

File: `apps/web/src/components/SlackIntegration.tsx`

Add a field below the monitored channels section:

```tsx
{/* Notification Channel */}
<div>
  <h4 className="text-xs font-semibold text-slate-700">Notification Channel</h4>
  <p className="text-[11px] text-slate-400 mt-0.5">
    Nyx will post alerts and status updates to this channel.
  </p>
  {/* Input for channel ID — same pattern as monitored channels */}
</div>
```

### 4.5 Hook Notifications into Event Emitters

Wire `sendSlackMessage()` into the services that fire the notification events (document lifecycle service, drift detection service, etc.). Retrieve the bot token and notification channel from `slackConnections` by `teamId`. Decrypt the token before use (Phase 3).

**Acceptance criteria:**
- When a document is approved, a Slack message is posted to the configured notification channel.
- If no notification channel is configured, the send is silently skipped.
- Slack API errors do not crash the originating request — they are logged and retried asynchronously.

---

## Phase 5: Add Error Logging and Structured Failure Handling

**Goal:** Silent `catch {}` blocks are replaced with actionable logging so that failures are observable.

### 5.1 Replace Silent Catch Blocks

In `apps/api/src/routes/slack.ts`, the fire-and-forget `setImmediate` blocks currently swallow all errors:

```ts
// Before
setImmediate(async () => {
  try {
    await slackService.processSlackMessage(...);
  } catch {
    // Best-effort
  }
});
```

Replace with structured logging:

```ts
// After
setImmediate(async () => {
  try {
    await slackService.processSlackMessage(...);
  } catch (err) {
    app.log.error({ err, teamId: connection.teamId, channelId }, 'slack: processSlackMessage failed');
    // TODO (Phase 6): enqueue for retry
  }
});
```

### 5.2 Log OAuth Errors

In the `GET /api/slack/callback` handler, log `tokenData.error` before returning a 400:

```ts
if (!tokenData.ok || ...) {
  app.log.warn({ slackError: tokenData.error }, 'slack: OAuth token exchange failed');
  reply.code(400);
  return { error: tokenData.error ?? 'Failed to complete Slack OAuth' };
}
```

**Acceptance criteria:**
- All Slack processing errors appear in structured logs with `teamId` and `channelId` context.
- No `catch {}` (empty catch) blocks remain in Slack-related code.

---

## Phase 6: Rate Limiting on Slack Endpoints

**Goal:** Prevent high-volume abuse of the public-facing Slack endpoints.

### 6.1 Add a Rate Limit Plugin

If `@fastify/rate-limit` is not already installed, add it:

```bash
pnpm --filter api add @fastify/rate-limit
```

### 6.2 Apply Rate Limit to Slack Routes

In `apps/api/src/routes/slack.ts`, register a rate limit for the command and events routes:

```ts
import rateLimit from '@fastify/rate-limit';

export const slackRoutes: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // Rate-limit by Slack workspace team ID if available, else by IP
      const params = new URLSearchParams(
        typeof req.body === 'string' ? req.body : ''
      );
      return params.get('team_id') ?? req.ip;
    },
  });

  // ... existing routes
};
```

**Acceptance criteria:**
- More than 100 requests per minute from a single workspace or IP returns HTTP 429.
- Normal Slack traffic (burst of reactions, slash commands) passes through without throttling.

---

## Phase 7: Improve Channel Discovery UX

**Goal:** Users should not need to manually look up channel IDs.

### 7.1 Add `GET /api/slack/channels` Endpoint

Add a new route that calls the Slack `conversations.list` API using the stored bot token:

```ts
app.get('/channels', async (request, reply) => {
  const { teamId } = request.query as { teamId?: string };
  // ... auth check, load connection, decrypt token
  const response = await fetch('https://slack.com/api/conversations.list?limit=200&types=public_channel', {
    headers: { Authorization: `Bearer ${rawToken}` },
  });
  const data = await response.json();
  return {
    channels: (data.channels ?? []).map((c: { id: string; name: string }) => ({
      id: c.id,
      name: c.name,
    })),
  };
});
```

### 7.2 Add Channel Picker to Frontend

In `apps/web/src/components/SlackIntegration.tsx`, replace the raw channel ID input with a `<select>` or combobox that fetches from the new endpoint:

- Fetch channel list on component mount (or on demand).
- Display channel names (`#general`) alongside IDs.
- Fall back to manual channel ID input if the fetch fails.

**Acceptance criteria:**
- Users can select monitored channels by name from a dropdown rather than pasting IDs.
- Channel list loads within 2 seconds of the settings panel opening.

---

## Phase 8: Audit Logging

**Goal:** All significant Slack connection events are recorded in the audit trail.

### 8.1 Identify Audit Trail Service

Locate the `auditTrail` table and its insertion pattern in the codebase (check `apps/api/src/db/schema.ts` and services).

### 8.2 Add Audit Log Calls

Add audit log entries at these points in `apps/api/src/routes/slack.ts`:

| Event | Action Field |
|-------|--------------|
| OAuth callback completes successfully | `slack.connected` |
| `DELETE /api/slack/connection` | `slack.disconnected` |
| `PATCH /api/slack/connection` (emoji or channel change) | `slack.settings_updated` |

**Acceptance criteria:**
- Connecting and disconnecting Slack each produce an `auditTrail` row with the acting `teamId` and a timestamp.

---

## Phase 9: E2E and Integration Tests

**Goal:** Automated tests prove the full path works end-to-end.

### 9.1 Unit Test for `sendSlackMessage()`

File: `apps/api/src/__tests__/services/slack.service.test.ts`

Add tests for the new `sendSlackMessage()` function:
- Successful send returns without throwing.
- Non-ok Slack API response throws with the error code.
- Fetch is called with the correct `Authorization: Bearer {token}` header.

### 9.2 Route Test for Channels Endpoint

File: `apps/api/src/__tests__/routes/slack.test.ts`

Add test for `GET /api/slack/channels`:
- Returns a list of `{ id, name }` objects when the connection exists.
- Returns 400 when `teamId` is missing.
- Returns 404 (or empty) when the team has no Slack connection.

### 9.3 E2E Test for Connect Flow

File: `e2e/slack-integration.spec.ts`

```ts
test('Slack connect button redirects to OAuth and settings shows connected after callback', async ({ authenticatedPage }) => {
  // Mock the OAuth callback by hitting /api/slack/callback with a fixture code
  // Assert settings page shows "Connected" badge
});
```

Use a mock Slack server or stub the `fetch` call to `slack.com/api/oauth.v2.access` to return a fixture bot token.

### 9.4 E2E Test for Slash Command Flow

```ts
test('/nyx slash command creates an intake session', async ({ request }) => {
  // POST to /api/slack/command with a valid HMAC-signed payload
  // Assert an intake session row was created in the database
});
```

**Acceptance criteria:**
- All existing 22 Slack tests continue to pass.
- New unit tests for `sendSlackMessage()` pass.
- E2E connect flow test passes in CI.

---

## Phase 10: OAuth Callback Redirect Fix

**Goal:** Ensure the OAuth callback redirects to the correct URL in all environments (currently hardcoded to `/settings`).

### 10.1 Make the Redirect URL Dynamic

In `apps/api/src/routes/slack.ts`, the callback currently does:

```ts
reply.redirect('/settings?tab=integrations&slack=connected');
```

This works when the API and the web frontend are on the same origin. In a split-origin deployment (API on `api.nyx.io`, web on `nyx.io`), this will redirect to the API's own domain.

Fix by constructing the frontend URL from a `BASE_URL` or `FRONTEND_URL` config variable:

```ts
const redirectBase = config.FRONTEND_URL ?? '';
reply.redirect(`${redirectBase}/settings?tab=integrations&slack=connected`);
```

Add `FRONTEND_URL` to `.env.example` and the config schema.

**Acceptance criteria:**
- OAuth callback redirects to the frontend's settings page in both local dev and production environments.

---

## Delivery Sequence

Phases are ordered by dependency and risk. Phases 1 and 2 are the highest-value and should ship first.

| Phase | Description | Blocking |
|-------|-------------|---------|
| 0 | Prerequisites — Slack app provisioning | All phases |
| 1 | `.env.example` documentation | Nothing blocked, ship independently |
| 10 | OAuth redirect URL fix | Required for any user to test the flow |
| 2 | Wire `processSlackMessage()` to intake | Core feature value |
| 3 | Encrypt bot token | Security requirement before GA |
| 4 | Outbound notification sending | High-value feature, can ship after Phase 2 |
| 5 | Error logging | Required for observability in production |
| 6 | Rate limiting | Ship before public beta |
| 7 | Channel picker UI | UX improvement, not blocking |
| 8 | Audit logging | Compliance/observability, not blocking |
| 9 | E2E and integration tests | Required before marking the feature stable |
