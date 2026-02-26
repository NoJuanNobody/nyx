# SyncDocs — Mocked, Stubbed & Unimplemented Items

Everything currently mocked, hardcoded, returning placeholder data, or not yet built — compared against the [Product Brief](./SyncDocs_ProductBrief.md).

---

## P0 — Critical (blocks production)

| # | What | Where | Real implementation |
|---|------|-------|---------------------|
| 1 | **Mock auth middleware** — hardcoded `Dev User` injected on every request, no real token validation | `apps/api/src/middleware/auth.ts:16-21` | Clerk/Auth0 JWT verification, session management, logout |
| 2 | **Mock user + team seed** — fake UUIDs and `dev@syncdocs.io` | `apps/api/src/db/seed.ts` | Real user onboarding flow; seed only in dev |
| 3 | **Database URL defaults to localhost** | `apps/api/src/lib/config.ts:5` and `apps/api/drizzle.config.ts:9` | Require `DATABASE_URL` in production, remove hardcoded fallback |
| 4 | **No permission enforcement** — every endpoint is accessible to everyone regardless of role | All route files | Route-level role checks using `teamMembers.role`; enforce dev vs non-dev access |

## P1 — High (core value prop gaps)

| # | What | Where | Real implementation |
|---|------|-------|---------------------|
| 5 | **AI `analyzeSpecQuality()` mock** — returns hardcoded score of 7 + canned suggestions | `apps/api/src/services/ai.service.ts:14-22` | Require `ANTHROPIC_API_KEY`, remove fallback mock |
| 6 | **AI `detectDrift()` mock** — always returns `hasDrift: false` | `apps/api/src/services/ai.service.ts:60-67` | Same — real Claude API call |
| 7 | **AI `generateTicketFromDiff()` mock** — returns canned ticket title/description | `apps/api/src/services/ai.service.ts:106-113` | Same |
| 8 | **AI `bootstrapDocsFromCode()` mock** — returns file list instead of real docs | `apps/api/src/services/ai.service.ts:151-154` | Same |
| 9 | **GitHub token from header** — reads `x-github-token` header instead of stored OAuth creds | `apps/api/src/routes/onboarding.ts:14-16` | GitHub OAuth flow, encrypted token storage, refresh logic |
| 10 | **Webhook signature verification optional** — skips validation when `GITHUB_WEBHOOK_SECRET` is unset | `apps/api/src/routes/webhooks.ts:35-48` | Make secret required in prod, reject unsigned webhooks |
| 11 | **Ticket service integration lookup** — grabs first integration of matching type, ignores team scope | `apps/api/src/services/ticket.service.ts:80-87` | Filter by `teamId`, handle multiple integrations |
| 12 | **No auto drift detection loop** — webhooks arrive but don't trigger AI analysis against docs | `apps/api/src/routes/webhooks.ts` | Webhook push → fetch changed files → run `detectDrift()` → create timeline event + alert |
| 13 | **No non-dev change flow** — no way to group doc edits into ticket suggestions | Not started | AI analyzes accumulated doc changes, suggests ticket groupings, human reviews before push |
| 14 | **No diff view UI** — backend endpoint exists but frontend has no comparison view | `apps/web/src/pages/DocumentEditor.tsx` | Side-by-side or inline diff view for any two versions |
| 15 | **No rollback / revert** — snapshots are read-only with no restore capability | `apps/api/src/services/snapshot.service.ts` | Restore docs to snapshot state, create revert PRs in GitHub, reopen Jira tickets |
| 16 | **No doc branching + approval UI** — DB table exists but no routes or frontend | `apps/api/src/db/schema.ts` (`documentBranches`) | Branch routes, merge/approval flow, PR-style review UI for docs |
| 17 | **No blame / attribution** — no tracing from stakeholder edit → ticket → code change | Not started | Full audit trail linking doc edits, ticket creation, and code commits |
| 18 | **No unified timeline UI** — service works but frontend doesn't display it | `apps/web/src/pages/DocumentEditor.tsx` | Chronological stream showing doc edits, ticket activity, and linked commits |
| 19 | **AI spec quality not wired into editor** — endpoint exists but editor doesn't show feedback | `apps/web/src/pages/DocumentEditor.tsx` | Inline quality score, suggestions panel, real-time feedback while writing |

## P2 — Medium (UI & polish)

| # | What | Where | Real implementation |
|---|------|-------|---------------------|
| 20 | **Settings — Team management** — "coming soon" placeholder | `apps/web/src/pages/Settings.tsx:19` | Member invite/remove UI, role management |
| 21 | **Settings — Integrations** — "coming soon" placeholder | `apps/web/src/pages/Settings.tsx:30` | GitHub/Jira connection forms, OAuth callbacks |
| 22 | **Settings — Account** — "coming soon" placeholder | `apps/web/src/pages/Settings.tsx:41` | Profile editing, password/email change |
| 23 | **Vite proxy hardcoded to `localhost:3001`** | `apps/web/vite.config.ts:9-14` | Env-based `API_URL` for dev/staging/prod |
| 24 | **No markdown preview in document editor** — editor shows raw markdown with no rendered preview | `apps/web/src/pages/DocumentEditor.tsx` | Live markdown preview (split-pane or toggle), syntax highlighting |
| 25 | **Document page layout not flexible** — rigid layout, not intuitive for editing workflows | `apps/web/src/pages/DocumentEditor.tsx` | Resizable panes, collapsible sidebar, responsive layout |
| 26 | **No document organization** — documents shown as flat list with no grouping | `apps/web/src/pages/Dashboard.tsx` | Folders/categories, tags, search/filter, drag-and-drop reordering |
| 27 | **No editor toolbar** — no markdown formatting shortcuts or helpers | `apps/web/src/pages/DocumentEditor.tsx` | Toolbar with bold, italic, headings, links, code blocks, etc. |
| 28 | **PDF export doesn't render markdown** — outputs raw text instead of formatted document | `apps/api/src/services/export.service.ts` | Parse markdown and render formatted PDF with headings, lists, code blocks |
| 29 | **No user auth state in frontend** — no auth store, no Authorization header on API calls | `apps/web/src/lib/api.ts`, `apps/web/src/stores/` | Auth store (Zustand), token management, protected routes |
| 30 | **No logout or team switcher in sidebar** | `apps/web/src/components/Sidebar.tsx` | Logout button, team selector dropdown |

## P3 — Post-MVP (in product brief, not in MVP scope)

| # | What | Where | Real implementation |
|---|------|-------|---------------------|
| 31 | **Agile / Kanban board** — aggregated ticket view across GitHub/Jira | Not started | Unified dashboard syncing ticket status from all integrated platforms |
| 32 | **Coding agent integrations** — Cursor, Copilot, Claude Code | Not started | Extensions/MCP so specs flow directly into AI coding workflows |
| 33 | **Confluence integration** — schema mentions it but no service | `apps/api/src/db/schema.ts` (`integrationType`) | Confluence REST API service for page linking and doc sync |
| 34 | **BYOK (Bring Your Own Key)** — teams connect their own Anthropic API key | Not started | Per-team API key storage, routing AI calls through team key |

---

**34 items total.** Auth (#1) + permissions (#4) are the blockers — almost everything else chains off having real users. The drift detection loop (#12) and non-dev change flow (#13) are the core value prop and should follow immediately after auth.
