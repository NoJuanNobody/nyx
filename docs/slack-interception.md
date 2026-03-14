# Slack Interception — Passive Intake from Team Channels

A post-launch growth feature. A native Slack integration that intercepts casual feature requests dropped in channels and automatically routes them through the SyncDocs ingestion pipeline — without the user ever opening the app.

## Problem

The highest-friction moment in the AI PM workflow is remembering to use the tool. Founders and PMs drop feature ideas in Slack constantly. If SyncDocs requires them to switch context and paste the request manually, adoption will be inconsistent and the tool becomes optional rather than essential.

## Solution

A Slack bot that watches designated channels (or responds to a trigger like `/syncdocs` or an emoji reaction) and silently routes the message through the ingestion pipeline. The user stays in Slack. The spec or ticket appears in SyncDocs automatically.

---

## Trigger Modes

| Mode | How It Works |
| --- | --- |
| **Slash command** | `/syncdocs [message]` anywhere in Slack — immediately queues the message for processing |
| **Emoji reaction** | React to any message with `:syncdocs:` to queue it for processing |
| **Channel monitoring** | Designate a `#product-requests` channel (opt-in per workspace); all messages are auto-processed |

---

## Flow

```
Slack message / reaction / channel post
        │
        ▼
Slack Events API (HTTP POST to SyncDocs webhook)
        │
        ▼
Intake Service
  - Deduplication check (same message_ts + channel)
  - Source metadata attached (user, channel, timestamp, permalink)
        │
        ▼
AI Ingestion Pipeline
  - Claude classifies: feature request / bug / question / noise
  - Discards noise (standup updates, "thanks", etc.)
  - Formats actionable items into structured spec or ticket draft
        │
        ▼
SyncDocs Inbox
  - Item appears as a draft in the connected project's inbox
  - User reviews, edits, and promotes to full spec or ticket
  - One-click push to GitHub Issues or Jira
        │
        ▼
Slack confirmation (optional)
  - Thread reply: "✓ Queued in SyncDocs — [View draft]"
```

---

## Architecture

| Component | Location |
| --- | --- |
| Slack app manifest | `integrations/slack/manifest.json` |
| Webhook receiver | `apps/api/src/routes/slack.ts` |
| Signature verification middleware | `apps/api/src/middleware/slack-verify.ts` |
| Intake & dedup service | `apps/api/src/services/slack-intake.service.ts` |
| AI classification + formatting | `apps/api/src/services/ingestion.service.ts` |
| Inbox UI | `apps/web/src/pages/Inbox.tsx` |
| Database schema | `apps/api/src/db/schema.ts` (`slackIntakeItems`) |

---

## Database Schema

```ts
// slackIntakeItems
{
  id: uuid (PK)
  projectId: uuid (FK → projects)
  workspaceId: string          // Slack workspace ID
  channelId: string
  messageTs: string            // Slack message timestamp (unique per channel)
  userId: string               // Slack user ID of the author
  rawText: string
  triggerMode: 'slash_command' | 'emoji_reaction' | 'channel_monitor'
  aiClassification: 'feature_request' | 'bug' | 'question' | 'noise'
  formattedTitle: string | null
  formattedBody: string | null
  status: 'pending' | 'reviewed' | 'promoted' | 'dismissed'
  slackPermalink: string | null
  createdAt: timestamp
  updatedAt: timestamp
}
```

Unique constraint on `(channelId, messageTs)` prevents duplicate intake from multiple triggers on the same message.

---

## API Endpoints

### `POST /api/integrations/slack/events`

Receives all events from the Slack Events API. Handles:
- `url_verification` challenge (one-time setup)
- `message` events (channel monitoring)
- `reaction_added` events (emoji trigger)
- `slash_commands` are delivered to a separate URL: `POST /api/integrations/slack/commands`

Slack requires a `200 OK` within 3 seconds. Anything slower should be handed off to a background job queue.

**Headers:**
```
X-Slack-Request-Timestamp: <unix ts>
X-Slack-Signature: v0=<hmac_sha256>
```

**Verification:** HMAC-SHA256 of `v0:<timestamp>:<raw body>` using `SLACK_SIGNING_SECRET`. Reject if timestamp is >5 minutes old (replay protection).

### `POST /api/integrations/slack/commands`

Handles `/syncdocs` slash command payloads.

**Request (form-encoded):**
```
command=/syncdocs
text=add dark mode to the editor
user_id=U123ABC
channel_id=C456DEF
response_url=https://hooks.slack.com/...
```

**Response (immediate, within 3 seconds):**
```json
{
  "response_type": "ephemeral",
  "text": "Got it — queued in SyncDocs."
}
```

---

## Slack App Setup

### 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From manifest**
2. Paste `integrations/slack/manifest.json`
3. Install to workspace

### 2. Required OAuth Scopes

| Scope | Purpose |
| --- | --- |
| `channels:history` | Read messages from public channels |
| `channels:read` | List channels for workspace config UI |
| `chat:write` | Post confirmation thread replies |
| `commands` | Register `/syncdocs` slash command |
| `reactions:read` | Detect `:syncdocs:` emoji reactions |
| `users:read` | Resolve Slack user ID to display name |

### 3. Environment Variables

Add to `.env`:

```env
SLACK_CLIENT_ID=your_client_id
SLACK_CLIENT_SECRET=your_client_secret
SLACK_SIGNING_SECRET=your_signing_secret
SLACK_BOT_TOKEN=xoxb-your-bot-token
```

### 4. Event Subscriptions

In the Slack app config, set the Request URL to:

```
https://your-api-domain.com/api/integrations/slack/events
```

Subscribe to bot events:
- `message.channels`
- `reaction_added`

### 5. Slash Commands

Register `/syncdocs` with Request URL:

```
https://your-api-domain.com/api/integrations/slack/commands
```

---

## Workspace Configuration (Per Team)

Each SyncDocs team can configure their Slack integration from **Settings → Integrations → Slack**:

| Setting | Description |
| --- | --- |
| **Monitored channels** | List of channel IDs where all messages are auto-processed |
| **Trigger emoji** | Custom emoji name (default: `syncdocs`) |
| **Default project** | Which SyncDocs project intake items are routed to |
| **Confirmation replies** | Toggle thread reply confirmations on/off |
| **Noise filter sensitivity** | How aggressively to discard non-actionable messages |

---

## AI Classification

Claude classifies each intake message before it enters the inbox. The prompt instructs it to:

1. Determine if the message is **actionable** (feature request, bug report, or question) or **noise** (casual conversation, status updates, "+1" reactions)
2. For actionable items, extract a structured title and description
3. Tag with `category`: `feature_request | bug | ux_improvement | question | other`

Noise items are silently discarded — they never reach the inbox. The classification threshold can be tuned via the noise filter sensitivity setting.

---

## Security

- **Signature verification** on every inbound Slack request (HMAC-SHA256 + timestamp check)
- **OAuth 2.0** for workspace installation — each workspace gets its own bot token stored encrypted at rest
- **Workspace isolation** — intake items are scoped to the installing team's SyncDocs workspace; no cross-team data access
- **Rate limiting** — cap intake processing at 100 items/hour per workspace to prevent channel-monitor abuse

---

## Rollout Plan

This is a **post-launch** feature. Prerequisites before building:

1. MVP shipped and at least one paid team using SyncDocs in production
2. Core ingestion pipeline stable (AI formatting, inbox UI, ticket push flow)
3. Demand signal from at least 3 teams requesting Slack integration

Suggested phased rollout:

| Phase | Scope |
| --- | --- |
| **Alpha** | Slash command only; manual opt-in; 2–3 design partners |
| **Beta** | Add emoji reaction trigger; expand to all paying teams |
| **GA** | Channel monitoring (opt-in); self-serve workspace install |

---

## Open Questions

- **Multi-project routing:** If a workspace has multiple SyncDocs projects, how does the bot know which project to route to? Options: default project per channel, `/syncdocs [project-slug] [message]`, or inbox with manual assignment.
- **Duplicate handling:** If a user both reacts with the emoji AND types `/syncdocs` on the same message, the unique constraint catches it — but should the user get an error reply or silent dedup?
- **Private channels:** Requires `groups:history` scope and explicit channel invitation for the bot. Out of scope for alpha.
- **DMs and group DMs:** Likely out of scope — intake should come from team channels, not private conversations.
