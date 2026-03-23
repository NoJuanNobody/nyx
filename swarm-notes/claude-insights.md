# Claude Insights — Implementation Notes

## What changed

The Claude Action Insights feature was already substantially implemented in the codebase. This ticket added the missing pieces required by governance (shared types and tests).

### Files modified
- `packages/shared/src/types/ticket.ts` — Added `ClaudeInsightSchema` (Zod) and `ClaudeInsight` type to shared types package

### Files created
- `apps/api/src/services/__tests__/claude-insights.service.test.ts` — 22 unit tests covering:
  - `parseClaudeComment`: standard comments, heading extraction, fallback title, empty input, summary/file limits, keyword-based section detection, backtick stripping, code fence/table row handling
  - `isClaudeComment`: all 4 known bot logins, fallback "claude" substring matching, rejection of non-claude bots, rejection of non-bot users with "claude" in name
  - `claudeInsightsService.getForTicket`: stored insight retrieval, null handling, missing ticket error
  - `claudeInsightsService.handleIssueCommentWebhook`: non-claude comment filtering
- `apps/web/src/__tests__/components/ClaudeInsightCard.test.tsx` — 10 component tests covering:
  - Null/undefined insight rendering with Fetch button
  - Collapsed state showing title only
  - Expanded state showing summary, files, View comment link, Refresh button
  - File count limiting (top 5 + "+N more")
  - Collapse/expand toggle
  - Empty summary/files edge case
  - Refresh mutation trigger

### Pre-existing implementation (already in codebase, not modified)
- `apps/api/src/db/schema.ts` — `claudeInsights` JSONB column on tickets table
- `apps/api/drizzle/0012_claude_insights.sql` — Migration file
- `apps/api/src/services/claude-insights.service.ts` — Full service with parsing, refresh, webhook handler, bot detection
- `apps/api/src/routes/tickets.ts` — GET/POST insights endpoints
- `apps/api/src/routes/webhooks.ts` — issue_comment webhook processing
- `apps/web/src/components/ClaudeInsightCard.tsx` — Full UI component
- `apps/web/src/pages/Board.tsx` — Integration of ClaudeInsightCard into ticket cards
- `apps/web/src/lib/api.ts` — API client functions (fetchTicketInsight, refreshTicketInsight)

## Assumptions
- The parser does not track code fence state (content between ``` markers may be captured as summary text). This is a known limitation documented in tests.
- The `ClaudeInsight` interface in the service file and the shared types are kept in sync manually; the service does not import from shared to avoid circular dependency concerns.

## Governance conflicts
- None. All governance rules followed.

## Follow-up items
- Consider importing `ClaudeInsight` from `@nyx/shared` in both the API service and web app to ensure a single source of truth (currently defined in 3 places: shared types, service, and web API client).
- The `parseClaudeComment` function does not handle content inside code fences — lines between ``` markers in summary sections will be captured as summary text. Could be improved with a state machine.
