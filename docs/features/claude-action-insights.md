# Claude Action Insights

Surface Claude GitHub Action output directly on kanban board ticket cards.

## Overview

When Claude Code runs via the `claude.yml` GitHub Action (triggered by `@claude` mentions in
issues or PRs), it posts markdown comments summarizing its work. The Claude Action Insights
feature fetches those comments and displays them as rich context on the corresponding ticket
card in the SyncDocs kanban board.

## How It Works

1. **Ticket sync**: When a GitHub ticket is synced or a new `issue_comment` webhook event
   arrives, SyncDocs checks whether the commenter is the Claude bot.
2. **Filtering**: Only comments from known Claude bot accounts (`github-actions[bot]`,
   `claude[bot]`, etc.) are ingested.
3. **Parsing**: The latest Claude comment is parsed into structured sections:
   - `title` — the top-level heading of the comment
   - `summary` — bullet points describing what was done
   - `filesChanged` — file paths mentioned in a "Files changed" section
4. **Storage**: The parsed insight is stored in the `claude_insights` JSONB column on the
   `tickets` table.
5. **Display**: The `ClaudeInsightCard` component renders a collapsible panel below each
   GitHub ticket card on the Board page.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/tickets/:id/insights` | Return stored Claude insight for a ticket |
| `POST` | `/api/tickets/:id/insights/refresh` | Re-fetch insight from GitHub and update DB |

### GET `/api/tickets/:id/insights`

Returns the stored `ClaudeInsight` object or `404` if none exists.

```json
{
  "title": "Implement auth endpoints",
  "summary": [
    "Added JWT middleware to all protected routes",
    "Created /api/auth/login and /api/auth/logout endpoints"
  ],
  "filesChanged": [
    "apps/api/src/middleware/auth.ts",
    "apps/api/src/routes/auth.ts"
  ],
  "commentId": 1234567890,
  "commentUrl": "https://github.com/org/repo/issues/42#issuecomment-1234567890",
  "commentedAt": "2026-03-14T12:00:00Z",
  "fetchedAt": "2026-03-14T12:05:00Z"
}
```

### POST `/api/tickets/:id/insights/refresh`

Fetches issue comments from GitHub, filters for the latest Claude bot comment, parses it, and
stores the result. Returns the same `ClaudeInsight` shape, or `404` if no Claude comment exists.

## Webhook Integration

The `POST /api/webhooks/github` handler now processes `issue_comment` events:

1. If `action === "created"` and the commenter is a Claude bot, the webhook handler calls
   `claudeInsightsService.handleIssueCommentWebhook()`.
2. The service matches the issue number + repository to stored tickets.
3. It parses the comment and stores the result — no separate polling required.

This keeps insights up to date automatically as Claude posts new comments.

## ClaudeInsight Schema

```typescript
interface ClaudeInsight {
  title: string;          // Top-level heading from the comment
  summary: string[];      // Bullet points (up to 10)
  filesChanged: string[]; // File paths (up to 20)
  commentId: number;      // GitHub comment ID
  commentUrl: string;     // Direct link to the comment
  commentedAt: string;    // ISO timestamp of the comment
  fetchedAt: string;      // ISO timestamp when SyncDocs fetched it
}
```

## ClaudeInsightCard Component

`apps/web/src/components/ClaudeInsightCard.tsx`

Props:
- `ticketId: string` — used for the refresh mutation
- `insight: ClaudeInsight | null | undefined` — pre-fetched insight from ticket data

Behaviour:
- If no insight is stored, shows a "Fetch" button that calls the refresh endpoint.
- If an insight exists, shows a collapsible panel with the title always visible.
- Expanded panel shows summary bullets, top 5 files changed, a "View comment" link, and a
  "Refresh" button to re-fetch from GitHub.
- Only rendered for GitHub tickets (Jira tickets have no Claude Action integration).

## Bot Detection

Accounts recognised as Claude bots:

| Login | Description |
|-------|-------------|
| `github-actions[bot]` | Default GitHub Actions bot account |
| `claude[bot]` | Anthropic Claude bot |
| `claude-code[bot]` | Claude Code bot |
| `anthropic-claude[bot]` | Anthropic Claude (alternate) |

Any bot account whose login contains "claude" is also accepted as a fallback.

## Markdown Parsing

The parser (`parseClaudeComment`) handles Claude's typical comment structure:

```markdown
## Title of the task

Summary sentence or bullets describing what was done.

- Bullet point 1
- Bullet point 2

### Files changed

- apps/api/src/routes/auth.ts
- apps/web/src/pages/Login.tsx
```

Section detection is keyword-based: headings containing "file", "change", or "modified" switch
the parser to file-collection mode; headings containing "summary", "overview", or "what" switch
to summary mode.

## Database Migration

```sql
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "claude_insights" jsonb DEFAULT NULL;
```

Migration file: `apps/api/drizzle/0012_claude_insights.sql`
