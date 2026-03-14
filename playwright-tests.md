# Nyx — Exhaustive Playwright E2E Test Plan

Cross-referenced against every completed item in `TODO.md`. Each test validates the user-facing behavior described in the TODO status column.

---

## P0 — Critical (Auth & Security)

### TODO #1 — Clerk Auth Middleware
**File:** `e2e/auth.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1.1 | Unauthenticated user sees landing page | Navigate to `/` without auth | Landing page renders with hero, features, waitlist form |
| 1.2 | Unauthenticated user redirected from protected route | Navigate to `/dashboard` without auth | Redirected to `/sign-in` |
| 1.3 | Dev bypass grants access without Clerk | Start app without `CLERK_SECRET_KEY`, navigate to `/dashboard` | Dashboard loads, dev user visible in sidebar |
| 1.4 | Sign-in page renders | Navigate to `/sign-in` | Clerk sign-in form or dev bypass dashboard |
| 1.5 | Sign-up page renders | Navigate to `/sign-up` | Clerk sign-up form visible |

**Data required:** None — tests use dev bypass auth and auto-provisioned team. Public pages need no seed data.

### TODO #2 — User + Team Seed (Dev Bootstrap)
**File:** `e2e/auth.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 2.1 | Dev user has auto-provisioned team | Sign in via dev bypass, check sidebar | Team name visible in sidebar (e.g., "My Workspace") |
| 2.2 | Dev user appears in team members | Navigate to `/settings`, click Team tab | Dev user listed as owner |

**Data required:**
- Seeded dev user: `dev@nyx.io` (id `00000000-0000-0000-0000-000000000000`) — already in seed
- Seeded team: `Default Team` (id `00000000-0000-0000-0000-000000000001`) — already in seed
- team_member linking dev user → Default Team as `owner` — already in seed

### TODO #4 — Permission Enforcement
**File:** `e2e/permissions.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 4.1 | Viewer cannot create documents | Authenticate as viewer role, attempt to create doc | Create button hidden or action returns error |
| 4.2 | Admin can invite team members | Authenticate as admin, go to Settings > Team, submit invite | Invite succeeds (toast or member appears) |
| 4.3 | Owner can delete team members | Authenticate as owner, go to Settings > Team, remove member | Member removed from list |

**Data required:**
- 3 users with different roles on the same team:
  - Dev user as `owner` (already seeded)
  - `alice@nyx.io` ("Alice Admin") as `admin` on Default Team
  - `bob@nyx.io` ("Bob Viewer") as `viewer` on Default Team
- At least 1 removable team member (Alice or Bob) for test 4.3
- **Note:** Dev bypass always injects the owner DEV_USER. Testing different roles requires either: (a) Playwright route interception to mock `/api/auth/me`, (b) a dev-only role-switch endpoint, or (c) direct DB role changes before each test.

---

## P1 — High (Core Value Prop)

### TODO #5–8 — AI Services (Quality, Drift, Tickets, Bootstrap)
**File:** `e2e/ai-features.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 5.1 | AI quality analysis runs on document | Open document editor, open AI Quality panel | Quality score and suggestions displayed |
| 6.1 | Drift detection results visible in timeline | (Requires webhook trigger or manual API) Check timeline tab | Drift event appears with details |
| 7.1 | AI generates ticket suggestion from doc | Open document, click "Suggest Tickets" in drawer | Ticket suggestions listed with title/description |
| 8.1 | AI generates document from prompt | Open AI chat panel, enter prompt like "Write a spec for user auth" | New document content generated and displayed |

**Data required:**
- 1 document with substantial content (for quality analysis + ticket suggestions)
- `ANTHROPIC_API_KEY` env var set (all 4 tests call Claude API)
- For test 6.1: a `timeline_events` row with `type: 'drift_detected'` pre-seeded on a document, OR trigger via webhook + Playwright route interception to mock the drift detection API response
- For test 7.1: 1 GitHub integration on the team (ticket suggestions need a provider to push to)

### TODO #9 — GitHub Token from Stored Integration
**File:** `e2e/integrations.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 9.1 | GitHub integration shows connected account | Connect GitHub via OAuth, go to Settings > Integrations | GitHub card shows connected username and avatar |

**Data required:**
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` env vars for OAuth flow
- OR: 1 pre-seeded integration row with `type: 'github'` and config `{ accessToken, login, avatar_url }` to skip OAuth and test the display directly
- Playwright route interception recommended to mock the GitHub OAuth callback

### TODO #11 — Ticket Service (Team-Scoped)
**File:** `e2e/tickets.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 11.1 | Create ticket from document | Open document, click create ticket, select GitHub | Ticket created, appears in document ticket list |
| 11.2 | Ticket appears on board after creation | Create ticket, navigate to `/board` | Ticket visible in appropriate kanban column |

**Data required:**
- 1 document belonging to the dev user's team
- 1 GitHub integration with valid `accessToken` and `selectedRepos` on the team
- Playwright route interception to mock `POST https://api.github.com/repos/:owner/:repo/issues` (returns `{ number, html_url }`) — avoids needing a real GitHub token

### TODO #13 — Change Proposal Workflow
**File:** `e2e/change-proposals.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 13.1 | Generate change proposal | Open document with saved versions, click "Generate Proposal" in drawer | Proposal appears with title, description, suggested tickets |
| 13.2 | Approve change proposal | Generate proposal, click Approve | Status changes to "Approved" |
| 13.3 | Reject change proposal | Generate proposal, click Reject | Status changes to "Rejected" |
| 13.4 | Push approved proposal to tickets | Approve proposal, click Push | Tickets created, proposal status becomes "Pushed" |

**Data required:**
- 1 document with at least 2 saved `document_versions` (generate analyzes version diffs)
- `ANTHROPIC_API_KEY` env var (generate calls `aiService.analyzeChangesForTickets`)
- 1 GitHub integration on the team (push creates tickets via GitHub API)
- Playwright route interception to mock GitHub issue creation for test 13.4

### TODO #14 — Diff View
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 14.1 | Compare two versions shows diff | Save two versions, open History drawer, select Compare mode, pick both | Side-by-side diff view renders with additions/deletions highlighted |

**Data required:**
- 1 document with 2+ `document_versions` with differing content

### TODO #15 — Rollback / Revert
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 15.1 | Restore document to previous version | Save version, edit doc, save another version, click Restore on first version | Document content reverts to first version's content |

**Data required:**
- 1 document with 2+ `document_versions` (can reuse same doc as #14)

### TODO #16 — Document Branching
**File:** `e2e/document-branches.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 16.1 | Create branch from document | Open document, create a version, create branch from History | Branch appears in version graph with branch indicator |
| 16.2 | Edit branch content | Click on branch in History, edit content | Branch content updates independently |
| 16.3 | View branch diff | Click branch diff button | Diff view shows changes vs base version |
| 16.4 | Approve and merge branch | Create branch, edit, click Approve, then Merge | Branch merges, document content updates |

**Data required:**
- 1 document with at least 1 saved `document_version` (branch creation needs a base version)
- Tests 16.2–16.4 can operate on the branch created in 16.1 (serial test execution)

### TODO #17 — Audit Trail
**File:** `e2e/audit-trail.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 17.1 | Audit trail shows document events | Create and edit document, open Audit tab in drawer | Events listed: doc_created, doc_updated |
| 17.2 | Audit trail shows ticket events | Create ticket from document, check Audit tab | ticket_created event visible |
| 17.3 | Trace view chains events | Click on audit event with parent | Parent chain shown (trace view) |

**Data required:**
- 1 document that has been edited (generates `doc_edit` audit events)
- 1 ticket created from that document (generates `ticket_created` audit event)
- For test 17.3: at least 2 `audit_trail` rows where one has `parentEventId` pointing to the other
- Pre-seed 3 audit_trail rows: `{ eventType: 'doc_edit', documentId }`, `{ eventType: 'ticket_created', documentId, ticketId }`, `{ eventType: 'doc_edit', documentId, parentEventId: <first event id> }`

### TODO #18 — Timeline UI
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 18.1 | Timeline tab shows events | Create document, save version, open Timeline drawer tab | Timeline events displayed with timestamps |

**Data required:**
- 1 document with at least 1 `timeline_events` row
- Pre-seed: `{ documentId, type: 'document_updated', payload: { fields: ['content'] }, actorId: <dev user id> }` and `{ documentId, type: 'version_created', payload: { version: 1 } }`
- OR: timeline events auto-generate when saving via the UI, so creating a version in-test may suffice

### TODO #19 — AI Quality Panel in Editor
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 19.1 | AI quality panel renders in editor | Open any document | AI Quality Panel visible (or accessible via button) |

**Data required:**
- 1 document (any content)
- `ANTHROPIC_API_KEY` env var if the panel triggers an AI call on open

---

## P2 — Medium (UI & Polish)

### TODO #20 — Settings: Team Management
**File:** `e2e/settings.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 20.1 | Team tab shows member list | Navigate to `/settings`, click Team tab | Members listed with name, email, role, avatar |
| 20.2 | Invite form submits | Enter email and select role, click Invite | Success toast, member added or invitation created |
| 20.3 | Change member role | Click role dropdown on a member, select new role | Role updates in the list |
| 20.4 | Remove member | Click remove button on a member, confirm | Member removed from list |

**Data required:**
- 2+ team_members on the team (dev user as owner + at least 1 other user as admin/developer)
- The extra user (`alice@nyx.io`) must exist in the `users` table so the member list shows name/email
- 1 pending `team_invitations` row (for invite list display)
- Test 20.2 can create an invite in-test, but 20.3–20.4 need an existing member to modify/remove

### TODO #21 — Settings: Integrations
**File:** `e2e/settings.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 21.1 | Integrations tab shows provider cards | Click Integrations tab | GitHub, Jira, Confluence cards visible |
| 21.2 | GitHub connect button initiates OAuth | Click Connect on GitHub card | Redirects to GitHub OAuth (or shows connected state) |
| 21.3 | Disconnect integration | Click Disconnect on connected integration | Card returns to disconnected state |

**Data required:**
- Test 21.1: No data needed (cards render regardless of connection state)
- Test 21.2: `GITHUB_CLIENT_ID` env var (for OAuth redirect URL), OR Playwright route interception to mock the redirect
- Test 21.3: 1 pre-seeded `integrations` row with `type: 'github'` and config `{ accessToken, selectedRepos, login }` so the card shows "connected"

### TODO #22 — Settings: Account
**File:** `e2e/settings.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 22.1 | Account tab shows profile form | Click Account tab | Name and email fields visible with current values |
| 22.2 | Update profile name | Change name, click Save | Success feedback, name updated |
| 22.3 | Delete account danger zone | Scroll to danger zone, click Delete | Confirmation dialog appears |

**Data required:**
- Dev user in `users` table (already seeded) — profile form reads from `/api/auth/me`
- No additional seed data needed

### TODO #24 — Markdown Preview
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 24.1 | Preview renders markdown | Type `# Hello` in editor, switch to Preview mode | Rendered `<h1>Hello</h1>` visible |
| 24.2 | Preview renders GFM tables | Type GFM table syntax, switch to Preview | Table renders with borders |
| 24.3 | Preview renders code blocks | Type fenced code block, switch to Preview | Code block with syntax highlighting visible |

**Data required:**
- 1 document (any content — tests type new content into the editor)

### TODO #25 — Resizable Split Pane
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 25.1 | Toggle between Editor/Preview/Split | Click layout toggle buttons | View switches between modes |
| 25.2 | Split view shows editor and preview | Select Split mode | Both editor textarea and preview pane visible side by side |

**Data required:**
- 1 document (can reuse same document as #24)

### TODO #26 — File Tree with Folders
**File:** `e2e/file-tree.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 26.1 | File tree shows documents | Dashboard loads with documents | Documents listed in sidebar file tree |
| 26.2 | Create folder | Right-click in file tree, select New Folder, type name | Folder appears in tree |
| 26.3 | Create document in folder | Right-click folder, select New Document | Document created with path under folder |
| 26.4 | Expand/collapse folders | Click folder chevron | Children toggle visibility |
| 26.5 | Archived docs in trash section | Delete a document, check Trash section in file tree | Archived doc visible in Trash |
| 26.6 | Restore from trash | Click restore on archived doc in Trash | Document reappears in main tree as draft |

**Data required:**
- 3+ documents with different `path` values to populate the tree:
  - `{ title: 'API Specification', path: '/api', status: 'draft' }`
  - `{ title: 'Quick Start', path: '/', status: 'draft' }`
  - `{ title: 'Deprecated Guide', path: '/api', status: 'archived' }` — for trash tests 26.5–26.6
- At least 1 document in a subfolder to test expand/collapse (26.4)

### TODO #27 — Markdown Toolbar
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 27.1 | Bold button wraps selection | Select text, click Bold button | Text wrapped with `**` |
| 27.2 | Italic button wraps selection | Select text, click Italic button | Text wrapped with `_` |
| 27.3 | Heading dropdown inserts prefix | Click Heading > H1 | `# ` prefix inserted at line start |
| 27.4 | Code button wraps inline | Select text, click Code button | Text wrapped with backticks |
| 27.5 | Link button inserts link syntax | Select text, click Link button | `[text](url)` syntax inserted |
| 27.6 | Keyboard shortcut Cmd+B | Select text, press Cmd+B | Text wrapped with `**` |
| 27.7 | Undo bold | Apply bold to selection, press Cmd+Z | `**` wrapper removed, original text restored |
| 27.8 | Undo italic | Apply italic to selection, press Cmd+Z | `_` wrapper removed, original text restored |
| 27.9 | Undo heading | Apply H1 prefix, press Cmd+Z | `# ` prefix removed, original line restored |
| 27.10 | Undo code | Apply inline code to selection, press Cmd+Z | Backtick wrapper removed, original text restored |
| 27.11 | Undo link | Apply link syntax to selection, press Cmd+Z | `[text](url)` syntax removed, original text restored |
| 27.12 | Undo keyboard shortcut bold | Apply bold via Cmd+B, press Cmd+Z | `**` wrapper removed, original text restored |

**Data required:**
- 1 document with some text content (toolbar operates on the editor textarea)

### TODO #27b — AI Chat Drawer Panel
**File:** `e2e/ai-chat.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 27b.1 | AI chat drawer opens | Click AI Edit tab in drawer | Chat panel opens on right side |
| 27b.2 | Send message to AI | Type prompt and press Enter | User message appears, AI response follows |
| 27b.3 | Suggestion prompts clickable | Click a suggested prompt chip | Prompt filled into input and sent |
| 27b.4 | Clear chat history | Click clear button | Chat history cleared |
| 27b.5 | Close drawer with Escape | Press Escape key | Drawer closes |

**Data required:**
- 1 document open in the editor
- `ANTHROPIC_API_KEY` env var (tests 27b.2–27b.3 send real AI requests)
- OR: Playwright route interception to mock `POST /api/ai/edit-document` responses

### TODO #27c — Syntax Highlighting in Preview
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 27c.1 | Code block has language badge | Type ` ```js ` code block, view preview | Language badge "js" visible on code block |
| 27c.2 | Copy button on code blocks | Hover over code block in preview | Copy button appears |

**Data required:**
- 1 document (tests type code blocks into the editor — no pre-existing content needed)

### TODO #28 — PDF Export
**File:** `e2e/export.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 28.1 | Export document as PDF | Open document, click Export > PDF | PDF file downloads |
| 28.2 | Export document as Markdown | Open document, click Export > Markdown | Markdown file downloads |

**Data required:**
- 1 document with content (export reads document content from DB)

### TODO #29 — Auth State in Frontend
**File:** `e2e/auth.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 29.1 | Auth token sent with API requests | Sign in, create document | Document creates successfully (API received auth token) |

**Data required:**
- Dev user + team (already seeded) — test creates a document to prove auth token works

### TODO #30 — Sidebar User Section
**File:** `e2e/sidebar.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 30.1 | User avatar/initials shown | Sign in, check sidebar | Avatar or initials badge visible |
| 30.2 | User name and role displayed | Check sidebar user section | Name and role badge visible |
| 30.3 | Team switcher works | Click team switcher dropdown, select different team | Team switches, documents reload |
| 30.4 | Logout button works | Click logout button | User signed out, redirected to sign-in |

**Data required:**
- Dev user with name/email (already seeded)
- **2 teams** with the dev user as a member of both (for team switcher test 30.3):
  - Default Team (already seeded)
  - `Second Team` (slug: `second-team`) — new seed row
  - team_member: dev user → Second Team as `owner`
- 1+ document per team (to verify documents reload after team switch)

### TODO #30b — Dark Theme
**File:** `e2e/theme.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 30b.1 | Toggle to dark theme | Click theme toggle in sidebar, select Dark | Page has `dark` class on `<html>`, dark colors applied |
| 30b.2 | Toggle to light theme | Switch to Light | `dark` class removed |
| 30b.3 | System theme follows preference | Set to System, verify behavior | Matches `prefers-color-scheme` |
| 30b.4 | Theme persists across reload | Set to dark, reload page | Dark theme still active |

**Data required:** None — theme toggle is purely frontend (localStorage + CSS class).

### TODO #30c — Settings Backend Wiring
**File:** `e2e/settings.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 30c.1 | Team members load from API | Navigate to Settings > Team | Real member data loaded (not mocked) |
| 30c.2 | Profile update saves to backend | Change name in Account tab, save, reload | Name persists |
| 30c.3 | API keys panel creates key | Click API Keys tab, create new key | Key displayed with copy button, listed in table |
| 30c.4 | Revoke API key | Click Revoke on an API key | Key marked as revoked |

**Data required:**
- 2+ team_members (for 30c.1 member list) — same as TODO #20
- Dev user in `users` table (for 30c.2 profile update)
- 1 pre-seeded `api_keys` row (for 30c.4 revoke test), OR create one in test 30c.3 first and revoke it in 30c.4
- API key seed: `{ teamId, userId: devUserId, name: 'CI/CD Key', keyHash: sha256('sd_test_seed_key'), keyPrefix: 'sd_test', scopes: ['read', 'write'] }`

---

## P3 — MVP Features

### TODO #31 — Kanban Board
**File:** `e2e/board.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 31.1 | Board page loads with 3 columns | Navigate to `/board` | Open, In Progress, Closed columns visible |
| 31.2 | Ticket cards show provider badge | Create GitHub ticket, check board | Ticket card has GitHub icon/badge |
| 31.3 | Ticket cards link to document | Check ticket card on board | Document link navigates to `/documents/:id` |
| 31.4 | Ticket cards link to external URL | Check ticket card on board | External link opens GitHub/Jira issue |
| 31.5 | Provider filter works | Click GitHub filter | Only GitHub tickets shown |
| 31.6 | Provider filter "All" shows everything | Click All filter | All tickets visible |
| 31.7 | Sync All button triggers sync | Click Sync All | Loading state, then tickets refresh |
| 31.8 | Ticket count per column | Check column headers | Count matches number of cards |
| 31.9 | Board link in sidebar | Click Board in sidebar | Navigates to `/board`, link highlighted |

**Data required:**
- 2 documents belonging to the dev user's team (tickets reference documents)
- 4 `tickets` rows across different statuses and providers:
  - `{ documentId: doc1, provider: 'github', externalId: '101', status: 'open', title: 'Implement auth endpoints', externalUrl: 'https://github.com/nyx/app/issues/101' }`
  - `{ documentId: doc1, provider: 'github', externalId: '102', status: 'closed', title: 'Fix rate limiting', externalUrl: 'https://github.com/nyx/app/issues/102' }`
  - `{ documentId: doc2, provider: 'jira', externalId: 'SD-1', status: 'open', title: 'Review architecture', externalUrl: 'https://nyx.atlassian.net/browse/SD-1' }`
  - `{ documentId: doc2, provider: 'jira', externalId: 'SD-2', status: 'in_progress', title: 'Update deployment docs', externalUrl: 'https://nyx.atlassian.net/browse/SD-2' }`
- Test 31.7 (Sync All) needs either: Playwright route interception to mock GitHub/Jira status APIs, or just verifying the loading state appears and completes

### TODO #32 — Agent Integrations (PARTIAL)
**File:** `e2e/agent.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 32.1 | Agent panel opens in drawer | Open document, click Agent tab in drawer | Agent panel renders with workflow options |
| 32.2 | Agent workflow list loads | Open Agent panel | Available workflows listed |
| 32.3 | API key management for agents | Go to Settings > API Keys, create key for "Claude Code" | Key created with appropriate scopes |

**Data required:**
- 1 document open in the editor (for agent panel access)
- `ANTHROPIC_API_KEY` env var (agent loop calls Claude — but tests 32.1–32.2 only render the panel/list, no AI call needed unless a workflow is triggered)
- No pre-seeded data for 32.3 — API key is created in-test

### TODO #37 — Landing Page + Waitlist
**File:** `e2e/landing.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 37.1 | Landing page renders hero section | Navigate to `/landing` | Hero text, animated stage colors visible |
| 37.2 | Feature cards display | Scroll down on landing page | 6 feature cards visible |
| 37.3 | Stats section displays | Scroll to stats | Statistics with source citations visible |
| 37.4 | Waitlist email submission — success | Enter valid email, click submit | Success state shown |
| 37.5 | Waitlist email submission — duplicate | Submit same email twice | Error message displayed |
| 37.6 | Sign-in link in navigation | Check sticky nav | Sign-in link navigates to `/sign-in` |
| 37.7 | Root `/` shows landing for unauthenticated | Navigate to `/` without auth | Landing page shown (not dashboard) |
| 37.8 | Root `/` redirects to dashboard when authed | Navigate to `/` while authed | Redirects to `/dashboard` |

**Data required:** None — landing page is static UI. Waitlist entries (37.4–37.5) are created in-test. The `waitlist_signups` table should be empty at start (or test uses unique emails).

### TODO #39 — Team Invite Flow
**File:** `e2e/team-invites.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 39.1 | Invite existing user by email | Go to Settings > Team, enter existing user email, select role, submit | Member added directly, toast says "added" |
| 39.2 | Invite non-existent user by email | Enter unknown email, submit | Pending invitation created, toast says "invited" |
| 39.3 | Pending invitations list | After inviting unknown email, check invitations section | Invitation shown with email, role, expiry date |
| 39.4 | Cancel pending invitation | Click cancel on pending invitation | Invitation removed from list |
| 39.5 | Duplicate invite blocked | Invite same existing user email twice | Error: "already a member" |

**Data required:**
- 1 user in the `users` table who is NOT a member of the dev user's team (for test 39.1 — "invite existing user")
  - e.g., `charlie@nyx.io` ("Charlie External") — exists in users but no team_member row on Default Team
- Dev user must be `admin` or `owner` on the team (already is `owner`)
- Tests 39.2–39.4 create invitations in-test, no pre-seeded invitations needed
- Test 39.5 requires test 39.1 to run first (Charlie is now a member, re-inviting returns 409)

### TODO #44 — Per-Integration Webhooks
**File:** `e2e/integrations.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 44.1 | Repo picker modal opens | Connect GitHub, click "Manage Repos" | Modal with searchable repo list appears |
| 44.2 | Search repos in picker | Type in search field | Repos filtered by name |
| 44.3 | Select/deselect repos | Click checkboxes on repos | Checkboxes toggle |
| 44.4 | Save selected repos | Select repos, click Save | Modal closes, repos saved |
| 44.5 | Select All / Deselect All | Click Select All button | All repos checked; click again, all unchecked |

**Data required:**
- 1 pre-seeded GitHub `integrations` row with a valid `accessToken` (repo picker calls `GET /user/repos` via GitHub API)
- Playwright route interception recommended to mock `GET https://api.github.com/user/repos` returning 5+ fake repos — avoids needing a real token
- If mocking: return repos like `[{ id: 1, name: 'frontend', full_name: 'nyx/frontend', private: false, html_url: '...', default_branch: 'main' }, ...]`

---

## Cross-Cutting Concerns

### Navigation & Layout
**File:** `e2e/navigation.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| N.1 | Sidebar logo links to dashboard | Click Nyx logo in sidebar | Navigates to `/dashboard` |
| N.2 | Board link in sidebar bottom | Click Board link | Navigates to `/board`, active state shown |
| N.3 | Settings link in sidebar bottom | Click Settings link | Navigates to `/settings`, active state shown |
| N.4 | Mobile hamburger menu | Resize to mobile width | Hamburger button appears, sidebar slides out |
| N.5 | Document click navigates to editor | Click document in file tree or list | Navigates to `/documents/:id` |

**Data required:**
- 1+ document in the team (for file tree display and test N.5)
- No special data — sidebar navigation is static UI

### Document Editor (Comprehensive)
**File:** `e2e/document-editor.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| DE.1 | Create new document | Click New Document on dashboard | New document created, editor opens |
| DE.2 | Edit document title | Click title, type new title | Title updates, save indicator shows "Saving..." then "Saved" |
| DE.3 | Edit document content | Type in editor textarea | Content updates, autosave triggers after 500ms |
| DE.4 | Save version manually | Click Save Version, enter message, confirm | Version created, appears in History drawer |
| DE.5 | Version history graph renders | Open History drawer tab | SVG commit graph visible with nodes |
| DE.6 | View past version (read-only) | Click on older version in History | Editor shows old content, read-only mode |
| DE.7 | Drawer panel tabs switch | Click History, Timeline, Proposals, Audit, AI, Agent tabs | Correct panel content renders for each |
| DE.8 | Close drawer | Click close button or press Escape | Drawer closes, editor expands |

**Data required:**
- 1 document with rich markdown content (for DE.2, DE.3, DE.7)
- 2+ `document_versions` on that document (for DE.5, DE.6 — version history needs existing versions)
- DE.1 and DE.4 create data in-test (new doc, new version)
- Timeline events + audit events on the document (for DE.7 drawer tab content) — or these tabs may show "empty" state which is also valid

### Dashboard
**File:** `e2e/dashboard.spec.ts`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| D.1 | Dashboard shows document list | Navigate to `/dashboard` | DocumentList component renders |
| D.2 | Document cards show metadata | Check document cards | Title, updated date, status badge visible |
| D.3 | Empty state with CTA | New team with no documents | "Create your first document" CTA shown |
| D.4 | Create document from dashboard | Click create button, enter title | Document created, navigates to editor |

**Data required:**
- 2+ documents with different titles and statuses (for D.1, D.2 — list and metadata display)
- For D.3: a second team with zero documents (the dev user must be a member). Can use the "Second Team" from TODO #30 sidebar tests.
- D.4 creates a document in-test

---

## Test File Summary

| File | TODO Items Covered | Test Count |
|------|-------------------|------------|
| `e2e/auth.spec.ts` | #1, #2, #29 | 8 |
| `e2e/permissions.spec.ts` | #4 | 3 |
| `e2e/ai-features.spec.ts` | #5, #6, #7, #8 | 4 |
| `e2e/ai-chat.spec.ts` | #27b | 5 |
| `e2e/integrations.spec.ts` | #9, #21, #44 | 8 |
| `e2e/tickets.spec.ts` | #11 | 2 |
| `e2e/change-proposals.spec.ts` | #13 | 4 |
| `e2e/document-editor.spec.ts` | #14, #15, #18, #19, #24, #25, #27, #27c | 24 |
| `e2e/document-branches.spec.ts` | #16 | 4 |
| `e2e/audit-trail.spec.ts` | #17 | 3 |
| `e2e/file-tree.spec.ts` | #26 | 6 |
| `e2e/export.spec.ts` | #28 | 2 |
| `e2e/sidebar.spec.ts` | #30 | 4 |
| `e2e/theme.spec.ts` | #30b | 4 |
| `e2e/settings.spec.ts` | #20, #22, #30c | 11 |
| `e2e/board.spec.ts` | #31 | 9 |
| `e2e/agent.spec.ts` | #32 | 3 |
| `e2e/landing.spec.ts` | #37 | 8 |
| `e2e/team-invites.spec.ts` | #39 | 5 |
| `e2e/navigation.spec.ts` | Cross-cutting | 5 |
| `e2e/dashboard.spec.ts` | Cross-cutting | 4 |
| **Total** | **39 TODO items + cross-cutting** | **~126** |

---

## TODO Items NOT Covered (incomplete/unbuilt)

| # | Reason |
|---|--------|
| #3 | Config validation — backend-only, covered by unit test |
| #10 | Webhook signature — backend-only, covered by API integration test |
| #12 | Auto drift detection — webhook-triggered, not directly testable via browser |
| #23 | Vite proxy — dev config, not a user-facing feature |
| #32 | PARTIAL — agent integrations only partially built; basic tests included |
| #33 | TODO — Confluence not built |
| #34 | TODO — BYOK not built |
| #35 | TODO — Lifecycle stages not built |
| #36 | TODO — AI Agent Map not built |
| #38 | TODO — Lifecycle explorer not built |
| #40 | TODO — Jira/Confluence OAuth not built |
| #41 | TODO — Health check enhancement not built |
| #42 | TODO — Notifications not built |
| #43 | TODO — Real-time collaboration not built |

---

## Notes

- Tests assume dev bypass mode (no `CLERK_SECRET_KEY`) for simplicity. Clerk-specific auth flows (sign-in/sign-up with real OAuth) would need separate config.
- AI-dependent tests (#5–8, #27b) require `ANTHROPIC_API_KEY` or mocked API responses via Playwright route interception.
- GitHub OAuth tests (#9, #44) require either real credentials or Playwright request interception to mock the OAuth flow.
- Tests are ordered by priority within each file — run the first test to verify basic setup before running the full suite.

---

## Consolidated Seed Data Requirements

The current seed (`apps/api/src/db/seed.ts`) only creates 1 user, 1 team, 1 membership. Below is everything needed for the full 120-test suite.

### Users (4 total — 1 existing + 3 new)

| ID | Email | Name | Purpose |
|---|---|---|---|
| `00000000-...-000000000000` | `dev@nyx.io` | Dev User | Already seeded — primary test user (owner) |
| New UUID | `alice@nyx.io` | Alice Admin | admin role member for permission + settings tests |
| New UUID | `bob@nyx.io` | Bob Viewer | viewer role member for permission tests |
| New UUID | `charlie@nyx.io` | Charlie External | Exists in users but NOT a team member — for invite flow test 39.1 |

### Teams (2 total — 1 existing + 1 new)

| ID | Name | Slug | Purpose |
|---|---|---|---|
| `00000000-...-000000000001` | Default Team | `default` | Already seeded — primary team |
| New UUID | Second Team | `second-team` | Team switcher (30.3), empty dashboard state (D.3) |

### Team Members (5 total — 1 existing + 4 new)

| User | Team | Role | Purpose |
|---|---|---|---|
| Dev User | Default Team | owner | Already seeded |
| Alice | Default Team | admin | Permission tests, settings member list |
| Bob | Default Team | viewer | Permission tests |
| Dev User | Second Team | owner | Team switcher test |
| _(Charlie is intentionally NOT a member)_ | | | Invite flow test 39.1 |

### Documents (5 — all new)

| Title | Team | Path | Status | Content Notes |
|---|---|---|---|---|
| `API Specification` | Default | `/api` | draft | Rich markdown: headings, code blocks, GFM table (for preview, toolbar, export, AI tests) |
| `Architecture Overview` | Default | `/` | published | Substantial spec content (for AI quality, drift, ticket suggestions) |
| `Deprecated Guide` | Default | `/api` | archived | Minimal content (for file tree trash/restore tests 26.5–26.6) |
| `Quick Start` | Default | `/` | draft | Short doc (basic CRUD, navigation tests) |
| `Second Team Doc` | Second | `/` | draft | Verifies team switcher reloads documents |

### Document Versions (3 — all new)

| Document | Version # | Message | Content |
|---|---|---|---|
| API Specification | 1 | `Initial draft` | First version of API spec |
| API Specification | 2 | `Added endpoints` | Updated with new endpoints section |
| Architecture Overview | 1 | `First draft` | Initial architecture content |

### Integrations (2 — all new)

| Team | Type | Config (JSONB) |
|---|---|---|
| Default | `github` | `{ accessToken: "ghp_test_token", selectedRepos: [{ owner: "nyx", name: "app", fullName: "nyx/app" }], webhookSecret: "wh-seed-secret", login: "nyx-bot", avatar_url: "https://github.com/identicons/nyx.png" }` |
| Default | `jira` | `{ baseUrl: "https://nyx.atlassian.net", email: "admin@nyx.io", apiToken: "jira-test-token", projectKey: "SD" }` |

### Tickets (4 — all new)

| Document | Provider | External ID | Status | Title | External URL |
|---|---|---|---|---|---|
| API Specification | `github` | `101` | `open` | Implement auth endpoints | `https://github.com/nyx/app/issues/101` |
| API Specification | `github` | `102` | `closed` | Fix rate limiting | `https://github.com/nyx/app/issues/102` |
| Architecture Overview | `jira` | `SD-1` | `open` | Review architecture | `https://nyx.atlassian.net/browse/SD-1` |
| Architecture Overview | `jira` | `SD-2` | `in_progress` | Update deployment docs | `https://nyx.atlassian.net/browse/SD-2` |

### Audit Trail Events (3 — all new)

| Team | Event Type | Document | Parent | Metadata |
|---|---|---|---|---|
| Default | `doc_edit` | API Specification | — | `{ fields: ["content"] }` |
| Default | `ticket_created` | API Specification | — | `{ provider: "github", title: "Implement auth endpoints" }` |
| Default | `doc_edit` | API Specification | → event #1 | `{ fields: ["title"] }` — chains to first event for trace test |

### Timeline Events (2 — all new)

| Document | Type | Payload |
|---|---|---|
| API Specification | `document_updated` | `{ fields: ["content"], actorId: "<dev user id>" }` |
| API Specification | `version_created` | `{ version: 1, message: "Initial draft" }` |

### Team Invitations (1 — new)

| Team | Email | Role | Status | Expires |
|---|---|---|---|---|
| Default | `pending@nyx.io` | `developer` | `pending` | now + 7 days |

### API Keys (1 — new)

| Team | User | Name | Key Prefix | Scopes |
|---|---|---|---|---|
| Default | Dev User | `CI/CD Key` | `sd_test` | `["read", "write"]` |

### Total New Seed Rows: ~25

---

## Environment Variables Required

```env
# Already needed for dev server
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nyx

# Required for AI-dependent tests (~30 tests)
ANTHROPIC_API_KEY=sk-ant-...

# Required for GitHub OAuth flow tests (3 tests) — optional, can be skipped
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Used by webhook signature tests
GITHUB_WEBHOOK_SECRET=test-webhook-secret
```

**Without `ANTHROPIC_API_KEY`:** ~30 tests fail (AI quality, drift, chat, agent, change proposals). Use `page.route()` to mock API responses as an alternative.

**Without GitHub OAuth credentials:** 3 tests fail (9.1, 21.2, 44.x). Pre-seeded integration row + Playwright route interception can cover these.

---

## Open Question: Role-Based Permission Tests

Dev bypass always injects `DEV_USER` as `owner`. Tests 4.1–4.3 need viewer/admin roles. Options:

1. **Playwright route interception** — `page.route('/api/**', ...)` to override the user's role in API responses
2. **Dev-only role-switch endpoint** — `POST /api/dev/switch-role` that temporarily changes the dev user's team_member role (only when `NODE_ENV=development`)
3. **Skip in E2E, cover in unit tests** — permissions are already covered by `permissions.test.ts` (8 passing unit tests)

**Recommended:** Option 2 (simplest to implement, most realistic) or Option 3 (pragmatic — unit tests already validate this).
