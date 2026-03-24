# Slack Integration

## Overview

Nyx integrates with Slack to enable two-way communication between Slack workspaces and the Nyx documentation platform. The integration serves two primary purposes:

1. **Passive intake** — team members route Slack messages (conversations, ideas, requirements) into Nyx's intake pipeline directly from Slack, without leaving their existing workflow.
2. **Active notifications** — Nyx pushes status updates, document change alerts, and action items back to configured Slack channels so that teams stay informed without switching to the Nyx UI.

The integration uses Slack's [OAuth 2.0 (v2) flow](https://api.slack.com/authentication/oauth-v2) for workspace authorization and the [Events API](https://api.slack.com/events-api) for real-time message reception.

---

## User-facing Features

### Connect a Slack Workspace

Any team admin can connect their Slack workspace to Nyx through the **Settings → Integrations** page. Clicking "Connect Slack" initiates the OAuth flow and, upon approval, stores a scoped bot token for the workspace.

### Disconnect a Workspace

The same settings panel allows team admins to revoke the connection at any time. Disconnecting deletes the stored bot token and stops all event processing.

### Slash Command (`/nyx`)

Once the Nyx Slack app is installed in a workspace, any team member can type `/nyx <message>` in any channel. The bot:

1. Receives the slash command payload.
2. Looks up the linked Nyx team by Slack workspace ID.
3. Routes the message text through the Nyx intake pipeline.
4. Responds in-channel with a confirmation that the input was received and queued.

### Emoji-Reaction Trigger

Users can react to any existing Slack message with the configured trigger emoji (default: `:nyx:`). This routes the original message content into intake without requiring a slash command. The trigger emoji is configurable per-workspace in Settings.

### Channel Monitoring

Team admins can whitelist specific Slack channels. Every message posted in a monitored channel is automatically routed to intake — no user action required. This is useful for dedicated `#product-feedback` or `#stakeholder-notes` channels.

### Outbound Notifications (Planned)

Nyx will proactively send messages to a configured Slack channel when key events occur, including:

- A document reaches a new lifecycle stage (Draft → Review → Approved).
- A spec drift alert is detected between documentation and code.
- A ticket is created or resolved.
- A team member is mentioned or assigned.

---

## OAuth Flow

Nyx uses the standard Slack OAuth 2.0 authorization code grant (no PKCE required for server-side apps).

### Requested Scopes

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages from joined public channels (for channel monitoring) |
| `channels:read` | List public channels; resolve channel IDs to names |
| `chat:write` | Post messages and slash command responses |
| `commands` | Receive `/nyx` slash command payloads |
| `reactions:read` | Receive emoji-reaction events |

### Flow Steps

```
1. User clicks "Connect Slack" in Settings
2. Frontend calls GET /api/slack/install?teamId=<teamId>
3. API returns a Slack OAuth URL (https://slack.com/oauth/v2/authorize) with scopes and state=teamId
4. Browser redirects to Slack's authorization screen
5. User approves the Nyx app in their workspace
6. Slack redirects to GET /api/slack/callback?code=<code>&state=<teamId>
7. API exchanges the code for a bot token via slack.com/api/oauth.v2.access
8. Token and workspace ID are upserted into the slack_connections table
9. API redirects to /settings?tab=integrations&slack=connected
10. Frontend detects the query param and shows a "Connected" success state
```

### Authorization Redirect URI

```
{BASE_URL}/api/slack/callback
```

This must be registered as a valid Redirect URL in the Slack app configuration.

---

## Inbound Message Processing

### Signature Verification

Every inbound request from Slack (slash commands and Events API) is verified using HMAC-SHA256 with the workspace's signing secret:

- Header `X-Slack-Signature` contains `v0=<hex_digest>`.
- Header `X-Slack-Request-Timestamp` is checked to be within 5 minutes of server time (replay attack prevention).
- The computed digest is compared using a timing-safe byte-by-byte comparison.

In production, requests without a valid signature are rejected with HTTP 401.

### Event Types Handled

| Event | Trigger Condition | Action |
|-------|-------------------|--------|
| `url_verification` | Slack sends this when a new Events API URL is configured | Echo the `challenge` value back immediately |
| `reaction_added` | A user reacts to a message with the configured trigger emoji | Route the original message through intake (fire-and-forget) |
| `message` | A message is posted in a monitored channel (non-bot messages only) | Route message text through intake (fire-and-forget) |

Slack requires a 200 OK response within 3 seconds. All processing is fire-and-forget (`setImmediate`) so the acknowledgement is immediate.

### Bot Loop Prevention

The Events API handler filters out any `message` event that has a `bot_id` field. This prevents the Nyx bot from triggering itself when it posts outbound messages.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/slack/install` | Returns the OAuth authorization URL for a given `teamId` |
| `GET` | `/api/slack/callback` | OAuth redirect handler — exchanges code for token, upserts connection |
| `GET` | `/api/slack/connection` | Returns the current Slack connection for a team (without the bot token) |
| `PATCH` | `/api/slack/connection` | Updates `triggerEmoji` and/or `monitoredChannels` for a team |
| `DELETE` | `/api/slack/connection` | Disconnects Slack for a team (deletes the connection row) |
| `POST` | `/api/slack/events` | Receives Slack Events API payloads |
| `POST` | `/api/slack/command` | Receives `/nyx` slash command payloads |

---

## Database Schema

```sql
CREATE TABLE slack_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams(id),
  slack_team_id   TEXT NOT NULL,          -- Slack workspace/team identifier (e.g. T0123456789)
  slack_bot_token TEXT NOT NULL,          -- Bot OAuth token (xoxb-...)
  trigger_emoji   TEXT DEFAULT 'nyx',     -- Emoji name (without colons) used as reaction trigger
  monitored_channels JSONB DEFAULT '[]',  -- Array of Slack channel IDs to auto-monitor
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

One row per Nyx team. A team can connect exactly one Slack workspace at a time.

---

## Frontend Components

### `SlackIntegration` (`apps/web/src/components/SlackIntegration.tsx`)

A self-contained card component embedded in the Settings → Integrations tab. It:

- Fetches the current connection status on mount.
- Shows a loading skeleton while fetching.
- Renders a "Connect Slack" button when disconnected, redirecting through the OAuth flow.
- Renders connection details (workspace ID, connected date) and a "Disconnect" button when connected.
- Provides an inline editor for the trigger emoji.
- Allows adding and removing monitored channels by Slack channel ID.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_CLIENT_ID` | Yes (production) | OAuth app client ID from Slack app credentials |
| `SLACK_CLIENT_SECRET` | Yes (production) | OAuth app client secret from Slack app credentials |
| `SLACK_SIGNING_SECRET` | Yes (production) | Request signing secret for HMAC verification |

In development, signature verification is skipped when `SLACK_SIGNING_SECRET` is unset (unless `NODE_ENV=production`).

---

## Slack App Configuration Requirements

To use this integration, a Slack app must be created at [api.slack.com/apps](https://api.slack.com/apps) with the following configuration:

### OAuth & Permissions

- **Bot Token Scopes**: `channels:history`, `channels:read`, `chat:write`, `reactions:read`
- **Redirect URL**: `{BASE_URL}/api/slack/callback`

### Slash Commands

- **Command**: `/nyx`
- **Request URL**: `{BASE_URL}/api/slack/command`
- **Description**: Route a message through Nyx intake

### Event Subscriptions

- **Request URL**: `{BASE_URL}/api/slack/events`
- **Subscribe to Bot Events**:
  - `message.channels` — messages in public channels the bot has joined
  - `reaction_added` — emoji reactions on any message

---

## Known Gaps & Future Work

| Gap | Priority | Notes |
|-----|----------|-------|
| `processSlackMessage()` is a placeholder — messages are logged but not wired to intake pipeline | High | Must integrate with the actual intake/chaos ingestion service |
| Bot token stored as plain text in database | High | Should be encrypted at rest (see `teamAiKeys` pattern) |
| No outbound notification sending | High | Need `sendSlackMessage()` for proactive notifications |
| Channel selection requires manual Channel ID input | Medium | Should offer a channel picker using `conversations.list` Slack API |
| Error handling is silent (bare try-catch) | Medium | Add structured logging and dead-letter queue for failed events |
| Slack env vars missing from `.env.example` | Medium | Developers need documentation to set up local dev |
| No audit log entries for connect/disconnect | Low | Should log to `auditTrail` table |
| No rate limiting on Slack endpoints | Low | Could be exploited with high message volume |
| No onboarding flow integration | Low | Slack should be offered during initial workspace setup |
