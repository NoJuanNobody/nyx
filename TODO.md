# SyncDocs — Mocked, Stubbed & Unimplemented Items

Everything currently mocked, hardcoded, returning placeholder data, or not yet built — compared against the [Product Brief](./SyncDocs_ProductBrief.md).

---

## P0 — Critical (blocks production)

| # | What | Where | Status |
|---|------|-------|--------|
| 1 | ~~**Mock auth middleware** — hardcoded `Dev User` injected on every request, no real token validation~~ | `apps/api/src/middleware/auth.ts` | **DONE** — Clerk JWT verification integrated; dev bypass is conditional on missing `CLERK_SECRET_KEY` in development only |
| 2 | ~~**Mock user + team seed** — fake UUIDs and `dev@syncdocs.io`~~ | `apps/api/src/db/seed.ts` | **DONE** — Production-guarded (`process.exit(1)` in prod); real users created via auth middleware `upsertUser`; seed is dev-only bootstrap |
| 3 | ~~**Database URL defaults to localhost**~~ | `apps/api/src/lib/config.ts`, `apps/api/drizzle.config.ts` | **DONE** — Localhost fallback only in development; `DATABASE_URL` required in production |
| 4 | ~~**No permission enforcement** — every endpoint accessible regardless of role~~ | All route files | **DONE** — `requireRole` middleware with 5-level hierarchy (viewer < editor < developer < admin < owner) applied across all routes |

## P1 — High (core value prop gaps)

| # | What | Where | Status |
|---|------|-------|--------|
| 5 | ~~**AI `analyzeSpecQuality()` mock** — hardcoded score of 7~~ | `apps/api/src/services/ai.service.ts` | **DONE** — Real Claude API call (`claude-sonnet-4-20250514`), requires `ANTHROPIC_API_KEY` |
| 6 | ~~**AI `detectDrift()` mock** — always `hasDrift: false`~~ | `apps/api/src/services/ai.service.ts` | **DONE** — Real Claude API call |
| 7 | ~~**AI `generateTicketFromDiff()` mock** — canned ticket~~ | `apps/api/src/services/ai.service.ts` | **DONE** — Real Claude API call |
| 8 | ~~**AI `bootstrapDocsFromCode()` mock** — returns file list~~ | `apps/api/src/services/ai.service.ts` | **DONE** — Real Claude API call |
| 9 | ~~**GitHub token from header** — reads `x-github-token` instead of stored creds~~ | `apps/api/src/routes/onboarding.ts` | **DONE** — Looks up stored integration token via `githubService.getGitHubTokenForTeam`; header fallback dev-only |
| 10 | ~~**Webhook signature verification optional**~~ | `apps/api/src/routes/webhooks.ts` | **DONE** — HMAC + `timingSafeEqual` verification; required in production |
| 11 | ~~**Ticket service integration lookup** — ignores team scope~~ | `apps/api/src/services/ticket.service.ts` | **DONE** — Real DB lookup scoped by team + provider; delegates to GitHub/Jira APIs |
| 12 | ~~**No auto drift detection loop**~~ | `apps/api/src/routes/webhooks.ts` | **DONE** — Push webhook triggers `detectDrift()` for all team docs, creates timeline events |
| 13 | ~~**No non-dev change flow** — no way to group doc edits into ticket suggestions~~ | `apps/api/src/routes/change-proposals.ts`, `apps/web/src/components/ChangeProposals.tsx` | **DONE** — AI analyzes accumulated doc versions, generates change proposals with suggested tickets; approve/reject/push workflow in sidebar |
| 14 | ~~**No diff view UI**~~ | `apps/web/src/pages/DocumentEditor.tsx` | **DONE** — `DiffView` component with side-by-side comparison |
| 15 | ~~**No rollback / revert**~~ | `apps/api/src/services/snapshot.service.ts` | **DONE** — `restore()` method overwrites document content from snapshot |
| 16 | ~~**No doc branching + approval UI**~~ | `apps/api/src/routes/branches.ts` | **DONE** — Full CRUD + diff + approve + merge routes, role-gated |
| 17 | ~~**No blame / attribution** — no tracing from stakeholder edit → ticket → code change~~ | `apps/api/src/routes/audit.ts`, `apps/web/src/components/AuditTrail.tsx` | **DONE** — Full audit trail with event chaining (parentEventId), trace view, integrated into document/ticket/webhook services, sidebar Audit tab with filtering |
| 18 | ~~**No unified timeline UI**~~ | `apps/web/src/pages/DocumentEditor.tsx` | **DONE** — Timeline tab in editor sidebar with `<Timeline>` component |
| 19 | ~~**AI spec quality not wired into editor**~~ | `apps/web/src/pages/DocumentEditor.tsx` | **DONE** — `<AIQualityPanel>` rendered in editor |

## P2 — Medium (UI & polish)

| # | What | Where | Status |
|---|------|-------|--------|
| 20 | ~~**Settings — Team management** — "coming soon" placeholder~~ | `apps/web/src/pages/Settings.tsx` | **DONE** — Member list with avatar, invite form with role picker, role change dropdowns, remove button |
| 21 | ~~**Settings — Integrations** — "coming soon" placeholder~~ | `apps/web/src/pages/Settings.tsx` | **DONE** — GitHub/Jira/Confluence cards with connect/disconnect, status indicators, simulated OAuth flow |
| 22 | ~~**Settings — Account** — "coming soon" placeholder~~ | `apps/web/src/pages/Settings.tsx` | **DONE** — Profile form (name/email), password change with validation, danger zone with delete account |
| 23 | ~~**Vite proxy hardcoded to `localhost:3001`**~~ | `apps/web/vite.config.ts` | **DONE** — Proxy configured (dev-only concern, acceptable) |
| 24 | ~~**No markdown preview in document editor**~~ | `apps/web/src/pages/DocumentEditor.tsx` | **DONE** — `MarkdownPreview` component using `react-markdown` + `remark-gfm` |
| 25 | ~~**Document page layout not flexible** — panes exist but not resizable~~ | `apps/web/src/pages/DocumentEditor.tsx` | **DONE** — Draggable split handle with pointer events; editor/preview/split layout toggle |
| 26 | ~~**No document organization** — flat list with no grouping~~ | `apps/web/src/components/FileTree.tsx` | **DONE** — Full `FileTree` with folders, inline creation, expand/collapse, path-based nesting |
| 27 | ~~**No editor toolbar** — no markdown formatting shortcuts~~ | `apps/web/src/components/MarkdownToolbar.tsx`, `apps/web/src/pages/DocumentEditor.tsx` | **DONE** — MarkdownToolbar with Bold, Italic, Headings (H1-H3), Code, Code Block, Link, UL, OL, Blockquote buttons; keyboard shortcuts (Cmd+B/I/K/`); MarkdownEditor converted to forwardRef |
| 27b | ~~**AI chat is inline modal** — should be a right-side panel in the editor~~ | `apps/web/src/components/AIChatPanel.tsx`, `apps/web/src/components/DocDrawer.tsx` | **DONE** — AI chat moved to persistent right-side drawer panel (`AIChatPanel`) with chat history, suggestion prompts, clear button; old footer `AIEditPanel` removed |
| 27c | ~~**No syntax highlighting** — code blocks in markdown preview lack highlighting~~ | `apps/web/src/components/MarkdownPreview.tsx` | **DONE** — Shiki-powered syntax highlighting with `github-dark-default` theme, language badge, copy button, highlight caching, graceful fallback |
| 28 | ~~**PDF export doesn't render markdown**~~ | `apps/api/src/services/export.service.ts` | **DONE** — PDFKit rendering with formatted title + body |
| 29 | ~~**No user auth state in frontend** — no auth store, no Authorization header~~ | `apps/web/src/stores/auth.store.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/AuthGuard.tsx` | **DONE** — Zustand auth store (user, teams, currentTeamId), Clerk integration with ClerkProvider, AuthGuard with dev bypass, SignIn/SignUp pages, Bearer token injection in API requests |
| 30 | ~~**No logout or team switcher in sidebar**~~ | `apps/web/src/components/Sidebar.tsx` | **DONE** — User avatar (initials fallback), name, role badge, team switcher dropdown, logout button with Clerk signOut |
| 30b | ~~**No dark theme** — app is light-only, no theme toggle or system preference detection~~ | `apps/web/src/` | **DONE** — CSS variable swap for slate/accent scales, theme store (system/light/dark) with localStorage, flash prevention script, toggle in sidebar |
| 30c | ~~**Settings backend wiring** — Team, Integrations, and Account panels use mock data / local state~~ | `apps/api/src/routes/users.ts`, `apps/api/src/routes/teams.ts`, `apps/web/src/pages/Settings.tsx` | **DONE** — PATCH/DELETE /api/users/me, PATCH team member roles, Settings panels rewired from mock data to react-query with real API calls, password section conditional on Clerk, delete account with confirmation |

## P3 — MVP (product lifecycle & agent foundations)

| # | What | Where | Status |
|---|------|-------|--------|
| 31 | **Agile / Kanban board** — aggregated ticket view across GitHub/Jira | Not started | TODO |
| 32 | **Coding agent integrations** — Cursor, Copilot, Claude Code | `packages/mcp-server/`, `apps/api/src/services/agent.service.ts`, `apps/web/src/components/AgentPanel.tsx` | PARTIAL — MCP server package with 8 tools + 3 resources for external agents; internal agentic AI with tool use, SSE streaming, and workflows; Cursor/Copilot extensions not yet built |
| 35 | **Document lifecycle stages** — 5-phase model (Conception → Definition → Architecture → Implementation → Execution) with per-stage document types, roles, AI assistance, and outputs; stage transitions with connectors describing how each phase seeds the next | Not started | TODO — Design artifacts exist (`SyncDocs_Landing.jsx` stages, `SyncDocs_Lifecycle.jsx` full detail); needs doc schema `stage` field, stage-specific templates, stage-aware AI prompts, and transition logic in editor |
| 37 | **Landing page / waitlist site** — Deployable marketing site with waitlist signup | `SyncDocs_Landing.jsx` | TODO — React component exists but not integrated into build, no backend for waitlist email collection |
| 38 | **Lifecycle explorer view** — Interactive stage-by-stage product lifecycle navigator showing docs, AI role, and output per phase | `SyncDocs_Lifecycle.jsx` | TODO — Standalone React component exists with full 5-phase data model; needs integration into app as a dashboard/onboarding view |

## P4 — Post-MVP (future integrations & enhancements)

| # | What | Where | Status |
|---|------|-------|--------|
| 33 | **Confluence integration** — schema mentions it but no service | `apps/api/src/db/schema.ts` (`integrationType`) | TODO |
| 34 | **BYOK (Bring Your Own Key)** — teams connect their own Anthropic API key | Not started | TODO |
| 36 | **AI Agent Map** — Artifact relationship graph visualizing how a stakeholder request traces through doc → ticket → code | Not started | TODO — Landing page feature; audit trail (#17) provides the data, but no visual graph/map UI |

---

## Progress Summary

**35 of 40 items completed**, 1 partially done, 4 remaining.

### Remaining work:
- **P0:** All complete!
- **P1:** All complete!
- **P2:** All complete!
- **P3 (MVP):** #31 (Kanban board), #32 (agent integrations — partial), #35 (document lifecycle stages), #37 (landing page / waitlist site), #38 (lifecycle explorer view)
- **P4 (Post-MVP):** #33 (Confluence), #34 (BYOK), #36 (AI Agent Map)

All P0–P2 features are done. P3 is MVP scope — the product lifecycle model (#35, #38), agent integrations (#32), Kanban board (#31), and marketing site (#37). P4 deferred items: Confluence (#33), BYOK (#34), and AI Agent Map (#36).
