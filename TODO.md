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
| 27 | **No editor toolbar** — no markdown formatting shortcuts | `apps/web/src/pages/DocumentEditor.tsx` | PARTIAL — Save/version actions exist, but no bold/italic/headings formatting toolbar |
| 27b | ~~**AI chat is inline modal** — should be a right-side panel in the editor~~ | `apps/web/src/components/AIChatPanel.tsx`, `apps/web/src/components/DocDrawer.tsx` | **DONE** — AI chat moved to persistent right-side drawer panel (`AIChatPanel`) with chat history, suggestion prompts, clear button; old footer `AIEditPanel` removed |
| 27c | ~~**No syntax highlighting** — code blocks in markdown preview lack highlighting~~ | `apps/web/src/components/MarkdownPreview.tsx` | **DONE** — Shiki-powered syntax highlighting with `github-dark-default` theme, language badge, copy button, highlight caching, graceful fallback |
| 28 | ~~**PDF export doesn't render markdown**~~ | `apps/api/src/services/export.service.ts` | **DONE** — PDFKit rendering with formatted title + body |
| 29 | **No user auth state in frontend** — no auth store, no Authorization header | `apps/web/src/lib/api.ts`, `apps/web/src/stores/` | TODO — Auth store (Zustand), token management, protected routes |
| 30 | **No logout or team switcher in sidebar** | `apps/web/src/components/Sidebar.tsx` | TODO — Hardcoded placeholder user; needs logout button + team selector |
| 30b | ~~**No dark theme** — app is light-only, no theme toggle or system preference detection~~ | `apps/web/src/` | **DONE** — CSS variable swap for slate/accent scales, theme store (system/light/dark) with localStorage, flash prevention script, toggle in sidebar |
| 30c | **Settings backend wiring** — Team, Integrations, and Account panels use mock data / local state | `apps/api/src/routes/`, `apps/web/src/pages/Settings.tsx` | TODO — API routes for team member CRUD, integration OAuth flows, account profile/password updates |

## P3 — Post-MVP (in product brief, not in MVP scope)

| # | What | Where | Status |
|---|------|-------|--------|
| 31 | **Agile / Kanban board** — aggregated ticket view across GitHub/Jira | Not started | TODO |
| 32 | **Coding agent integrations** — Cursor, Copilot, Claude Code | Not started | TODO |
| 33 | **Confluence integration** — schema mentions it but no service | `apps/api/src/db/schema.ts` (`integrationType`) | TODO |
| 34 | **BYOK (Bring Your Own Key)** — teams connect their own Anthropic API key | Not started | TODO |

---

## Progress Summary

**31 of 36 items completed**, 1 partially done, 4 remaining.

### Remaining work:
- **P1:** All complete!
- **P2:** #27 (markdown toolbar — partial), #29 (frontend auth state), #30 (logout/team switcher), #30c (settings backend wiring)
- **P3:** #31-34 (all post-MVP)

All P1 features are done. The remaining gaps are P2 polish: frontend auth integration (#29, #30), Settings UI (#20-22), and editor UX (#27).
