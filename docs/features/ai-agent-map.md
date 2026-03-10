# AI Agent Map (#36)

**TODO item:** #36
**Status:** TODO
**Priority:** P2 — Post-MVP

---

## Overview

The AI Agent Map is a visual traceability feature that shows how a stakeholder request moves from intent to implementation. It answers the question: "What happened to that change I requested?" — for non-technical stakeholders and developers alike.

Given that the audit trail (#17) already captures all events with `parentEventId` chains, the Agent Map is essentially a visualization layer on top of existing data. No new event schema is needed.

> **UI naming note:** Do not call this "AI Agent Map" in the product UI. Use "Trace" or "Impact map" as the tab/page label. The internal name is for development and docs use only.

---

## Purpose

- **Traceability** — let any team member follow a change from its origin (a stakeholder doc edit) through to its resolution (a merged commit)
- **Accountability** — surface who was involved at each step and when
- **Drift awareness** — flag cases where a trace ends in a ticket but no commit ever closed it
- **Stakeholder communication** — give non-technical users plain-English summaries of where their requested changes stand

---

## Data Source

The trace is built from audit trail events (see audit trail feature, #17). Each event has:

```typescript
interface AuditEvent {
  id: string;
  type: 'doc_edit' | 'ticket_created' | 'pr_opened' | 'commit_pushed' | 'proposal_created' | 'ticket_closed' | 'pr_merged';
  parentEventId: string | null;   // forms the DAG
  documentId: string;
  userId: string;
  timestamp: string;
  metadata: Record<string, unknown>; // type-specific payload
}
```

The chain `parentEventId → id` forms a directed acyclic graph (DAG). In practice it is shallow (typically 3–5 levels deep) with limited branching.

### Typical trace depth

```
[Doc edit]  →  [Ticket created]  →  [PR opened]  →  [Commit merged]
```

### Branching cases

- One doc edit spawns multiple tickets (e.g., PM splits UX and backend work)
- One ticket produces multiple PRs (large feature broken into separate PRs)
- Multiple doc edits converge on one ticket (less common)

Branches are shallow and bounded — this is not an unbounded graph like a dependency tree or git history.

---

## UI Design

The trace view uses a **tiered approach**: the default is a readable card chain accessible to all users; an optional graph view is available for power users.

### Tier 1 — Linear trace card chain (default)

A top-to-bottom card flow. Each event is a card showing who, what, and when. Cards are linked by directional arrows.

```
┌──────────────────────────────────────────────────┐
│  👤 Sarah edited "Onboarding Flow" spec           │
│  March 4 · Section: "Step 3 — Account Setup"     │
│  "Added requirement for SSO login support"        │
└──────────────────────────┬───────────────────────┘
                           ▼
┌──────────────────────────────────────────────────┐
│  🎫 Ticket #42 created                           │
│  March 4 · Assigned to Dev Team                  │
│  "Add SSO login to onboarding flow"               │
│  ↳ also spawned: Ticket #43 (Backend API) ▸      │
└──────────────────────────┬───────────────────────┘
                           ▼
┌──────────────────────────────────────────────────┐
│  🔀 PR #87 opened                                │
│  March 6 · Reza Tehrani                          │
│  "feat: SSO integration in onboarding"           │
└──────────────────────────┬───────────────────────┘
                           ▼
┌──────────────────────────────────────────────────┐
│  ✅ Commit abc123f merged                         │
│  March 8 · via PR #87                            │
└──────────────────────────────────────────────────┘
```

**Branch handling in the linear view:**

- Secondary branches appear as a single collapsed annotation line beneath the relevant card: `↳ also spawned: Ticket #43 (collapsed) ▸`
- Clicking the annotation expands an inline sub-chain for the branch
- When branching is significant (2+ parallel paths), the layout promotes to a split column view:

```
              [Sarah's doc edit]
                      ▼
           ┌──────────┴──────────┐
      [Ticket #42]          [Ticket #43]
           ▼                     ▼
        [PR #87]              [PR #91]
           ▼                     ▼
      [Commit abc]          [Commit def]
```

This is a **deterministic layout** (top-to-bottom, branch → columns) — not a force-directed graph. The layout is predictable and readable without a graph-reading mental model.

**Primary path heuristic:** When a node has multiple children, the one created first (or with the most downstream events) is treated as the primary path.

**Branch depth cap:** The linear view shows at most 1 level of branching inline. Deeper nesting is summarized as "3 more events →" with a link to the full graph view.

### Tier 2 — Graph view (opt-in)

A React Flow canvas available via a **"Show as graph"** toggle button in the top-right of the trace panel. Intended for developers and power users who need to see a full multi-branch structure.

- **Pan and zoom** — built-in React Flow controls
- **Node click** — opens a slide-out detail panel with full event metadata, diff preview (for doc edits and commits), and external links (to GitHub PR, Jira ticket, etc.)
- **Layout algorithm** — dagre (top-to-bottom DAG layout, available as a React Flow plugin). Not force-directed — layout is deterministic.
- **Node types by event type:**

| Event type | Node shape | Color |
|------------|-----------|-------|
| Doc edit (stakeholder) | Large rounded rect | Amber (intent root) |
| Proposal created | Rounded rect | Purple |
| Ticket created | Rounded rect | Blue |
| PR opened | Rounded rect | Indigo |
| Commit pushed | Rounded rect | Green |
| Ticket closed | Rounded rect | Slate (muted) |
| PR merged | Rounded rect | Teal |

- **Edge style** — solid arrows for direct parent→child relationships; dashed arrows for inferred links (e.g., commit closes ticket via commit message pattern)

### Tier 3 — AI narrative panel

Displayed above the trace card chain. Claude generates a 2–3 sentence plain-English summary of the full chain.

Example:
> "Sarah requested SSO login support in the Onboarding Flow spec on March 4. This produced Ticket #42 (UX) and Ticket #43 (backend API). Both were resolved and merged by March 8."

Non-technical stakeholders can read this without interpreting any visualization. The narrative updates when a user applies filters.

---

## AI Assistance

The trace feature uses Claude in three ways:

### 1. Trace narrative

When a user opens the trace, Claude generates a brief plain-English summary of the chain (see above). This makes the view immediately useful for non-technical stakeholders without requiring them to read the cards.

**API call:** `POST /ai/summarize-trace` with the ordered list of audit events. Responses are cached per trace ID + last-event timestamp (re-generated only when new events appear).

### 2. Intent extraction

For doc edit events where the stakeholder did not leave a comment, Claude reads the diff of the edit and infers the likely intent. The inferred intent is shown as a subtitle on the root node card.

Example: A diff that replaces "password login" with "SSO login" in three places → inferred intent: *"Add SSO as the primary login method."*

**API call:** `POST /ai/infer-intent` with the document diff. Result is stored on the audit event as `metadata.inferredIntent`.

### 3. Drift flagging

If a trace ends in a ticket with no subsequent PR or commit events, or if the commit diff does not semantically address the original doc change, Claude flags the trace as potentially unresolved.

The flag appears as a banner at the top of the trace: *"This change may not have been fully implemented — no code changes were linked to Ticket #42."*

---

## Filtering

Filters are accessible via a filter bar above the trace. All filters affect both the linear card view and the graph view.

| Filter | Options |
|--------|---------|
| **Time range** | Last 7 days, 30 days, 90 days, custom date range |
| **User** | Filter to events initiated by a specific user |
| **Document** | Show only traces originating from a specific document |
| **Event type** | Toggle visibility of doc edits, tickets, PRs, commits independently |
| **Status** | All, In progress (open tickets/PRs), Resolved (merged/closed), Flagged (AI drift flag) |

Filters are applied client-side to the already-fetched trace data. No server round-trip needed for filter changes.

**Active filter indicator:** When filters are active, a chip row below the filter bar shows what's applied (e.g., `User: Sarah ×` `Type: Tickets ×`). Each chip is independently removable.

---

## Where It Lives in the App

### Primary location: DocDrawer "Trace" tab

The trace for a specific document lives in the DocDrawer as a new tab alongside versions, timeline, and audit. Tab label: **"Trace"**.

- The trace shows all event chains that originated from edits to the current document
- This is the primary entry point for stakeholders checking on a change they made

### Secondary location: Standalone "Impact map" page

A cross-document view accessible from the main navigation. Allows filtering by user, team, time range, or document — and shows traces that span multiple documents.

This is a post-MVP concern. The DocDrawer tab ships first.

---

## Technology

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Linear card view | Plain React + CSS (no library) | Simple tree structure doesn't need a graph library; faster to build, better a11y |
| Graph view | [React Flow](https://reactflow.dev/) | Built-in pan/zoom/click, TypeScript support, active ecosystem. Better DX than D3.js for this use case. |
| Graph layout | [dagre](https://github.com/dagrejs/dagre) + `@dagrejs/react-flow` layout plugin | Deterministic DAG layout (not force-directed), top-to-bottom orientation |
| AI narrative | Anthropic Claude API | `POST /ai/summarize-trace` — simple prompt-response, no streaming needed |

**Why not D3.js?** D3 gives more low-level control but requires significantly more implementation work for interactions (pan, zoom, click, tooltip) that React Flow provides out of the box. The control tradeoff is not worth it for this feature.

---

## Performance Considerations

Audit trails can grow large for long-lived documents. The following measures keep the trace view fast:

### Data fetching

- The API returns trace events paginated and pre-sorted by timestamp
- Endpoint: `GET /api/traces?documentId={id}&limit=200&cursor={cursor}`
- Initial load fetches the 200 most recent events. Older events load on demand when the user scrolls up.

### Rendering

- The linear card view renders only visible cards (windowing via `react-window` or similar if the chain exceeds 50 nodes)
- The React Flow graph view uses React Flow's built-in virtualization — only nodes in the viewport are rendered
- AI narrative is generated once per trace load and cached; it does not re-request on filter changes (the UI notes "Summary may not reflect active filters")

### Large event chains

- For traces with more than 100 nodes, the graph view shows a warning: *"This is a large trace. Graph performance may be affected."*
- A **"Summarize only"** mode skips the card chain entirely and shows only the AI narrative — intended for traces too large to browse interactively
- Event de-duplication: identical events within a 5-second window are collapsed into a single node (e.g., rapid sequential commits from a CI bot)

---

## Node Detail Panel

Clicking any card (linear view) or node (graph view) opens a slide-out detail panel on the right.

Panel contents by event type:

| Event type | Panel shows |
|------------|------------|
| Doc edit | Diff of the changed content, section name, user avatar, timestamp, inferred intent (if AI-generated) |
| Ticket | Title, description, assignee, status, link to GitHub Issues or Jira |
| PR | Title, status (open/merged/closed), author, link to GitHub PR, file change count |
| Commit | Short SHA, message, author, timestamp, link to GitHub commit, files changed |

The panel closes when the user clicks outside it or presses Escape.

---

## Open Questions

- **Inferred intent quality** — how confident should Claude be before showing an inferred intent label? Should it show a confidence indicator, or only show the label when confidence is high?
- **Cross-document traces** — if a ticket was created from one doc but the implementation is linked to a different doc, how does the trace handle that? Does it show a cross-document edge?
- **External ticket systems** — for teams using Jira, ticket events may come from a webhook. Does the trace show Jira tickets inline, or link out to Jira and exclude them from the graph?
- **Permissions** — can all roles see the full trace? Should commits or PR diffs be hidden from non-technical stakeholders?
- **Real-time updates** — should the trace view update live as new events arrive, or require a manual refresh?

---

## E2E Testing

### Critical user flows

1. **Full trace view** — user opens a document and navigates to the Trace tab; the complete event chain from doc edit → ticket → PR → commit is visible
2. **Linear → graph toggle** — user switches from linear card view to React Flow graph view and back
3. **Filter by user** — user applies a user filter; only events from that user appear in the trace
4. **Filter by time range** — user applies a date range filter; events outside the range are hidden
5. **Node detail panel** — user clicks a card or graph node; the detail panel opens with correct content
6. **AI narrative** — the AI narrative panel renders above the trace with a non-empty summary
7. **Branch expansion** — user clicks a collapsed branch annotation; the sub-chain expands inline
8. **Unresolved trace flagging** — a trace with no commits is flagged with the AI drift warning banner

### Test scenarios

#### Scenario 1: View full trace from doc edit to commit

```
Given a document with a complete audit trail (doc edit → ticket → PR → commit)
  And the user has access to that document
When the user opens the document and clicks the "Trace" tab
Then the linear card chain is visible
  And cards appear in chronological order (doc edit first, commit last)
  And each card shows the correct event type, user, and timestamp
  And the AI narrative panel is present with a non-empty summary
```

#### Scenario 2: Toggle graph view

```
Given the Trace tab is open and showing the linear card chain
When the user clicks "Show as graph"
Then the React Flow graph canvas renders
  And nodes are positioned top-to-bottom (DAG layout)
  And edges connect nodes matching the parentEventId relationships
  And pan and zoom controls are functional
When the user clicks "Show as list"
Then the linear card view is restored
```

#### Scenario 3: Filter by user

```
Given a trace with events from multiple users (Sarah and Reza)
When the user selects "Sarah" in the User filter
Then only events authored by Sarah are visible in the trace
  And the active filter chip "User: Sarah ×" is shown
When the user removes the filter chip
Then all events are visible again
```

#### Scenario 4: Node detail panel — doc edit

```
Given the Trace tab is open
When the user clicks the doc edit card (root node)
Then the detail panel slides in from the right
  And it shows the document diff for that edit
  And it shows the section name, user avatar, and timestamp
  And it shows the inferred intent (if available)
When the user presses Escape
Then the detail panel closes
```

#### Scenario 5: Unresolved trace flagging

```
Given a document with an audit trail ending in a ticket (no subsequent PR or commit)
When the user opens the Trace tab
Then the AI drift warning banner is visible:
  "This change may not have been fully implemented — no code changes were linked."
```

#### Scenario 6: Branch expansion

```
Given a trace where one doc edit spawned two tickets
When the user views the linear card chain
Then the primary ticket card is visible
  And a collapsed annotation is shown: "↳ also spawned: Ticket #43 ▸"
When the user clicks the annotation
Then the sub-chain for Ticket #43 expands inline beneath the primary path
```

### Integration boundaries

| Dependency | Test strategy |
|------------|--------------|
| Audit trail API (`GET /api/traces`) | Mock with fixture data in all E2E tests |
| GitHub API (PR and commit links) | Mock — use fixture PR/commit metadata |
| Jira API (ticket links for Jira-connected teams) | Mock — test Jira-style ticket cards separately |
| Anthropic Claude API (AI narrative, intent extraction) | Mock — return deterministic fixture summaries; no real API calls in CI |
| React Flow rendering | Test in headless Chromium (Playwright); pan/zoom interactions verified via DOM assertions |

### Test data requirements

**Fixture: `trace-complete.json`**
A full trace with one doc edit → two tickets (one primary, one branch) → one PR per ticket → one commit per PR. Used for the majority of E2E tests.

**Fixture: `trace-unresolved.json`**
A trace ending in an open ticket with no PR or commit. Used to test the AI drift flagging banner.

**Fixture: `trace-large.json`**
A trace with 150+ events across 10+ documents. Used to test performance warnings and the "Summarize only" mode.

**Seed data setup:**
- One team with three members: one stakeholder (Sarah), one developer (Reza), one PM (Alex)
- Three documents: "Onboarding Flow" (has a complete trace), "Auth Spec" (has an unresolved trace), "API Design" (no trace yet)
- GitHub integration connected with mock webhook responses
- Audit trail populated from fixture events (not live GitHub events)

### Playwright test file locations

```
tests/e2e/
  trace/
    trace-tab.spec.ts          # Tab navigation, card chain render, AI narrative
    trace-graph.spec.ts        # Graph view toggle, React Flow interactions
    trace-filters.spec.ts      # User, time range, event type, status filters
    trace-detail-panel.spec.ts # Node click → detail panel content by event type
    trace-branches.spec.ts     # Branch collapse/expand, split column layout
    trace-flagging.spec.ts     # AI drift flag banner for unresolved traces
    trace-performance.spec.ts  # Large trace warning, "Summarize only" mode
```

### CI considerations

- **Environment variables required:**
  - `ANTHROPIC_API_KEY` — set to a test/mock value; Anthropic calls are intercepted by MSW (Mock Service Worker) in E2E tests and never reach the real API
  - `GITHUB_WEBHOOK_SECRET` — required if testing webhook-triggered trace updates
- **Service containers:** PostgreSQL (for audit trail data) must be running. Use the existing `docker-compose.test.yml` service.
- **Seed script:** Run `pnpm db:seed:traces` before the trace E2E suite to populate fixture audit events.
- **Browser:** Chromium only for initial CI run. Firefox and WebKit can be added later — React Flow has known rendering quirks in WebKit that require additional CSS workarounds.
- **Test isolation:** Each test file uses a dedicated database snapshot (restored before each file) to avoid cross-test state pollution from audit event creation.
- **Flake risk:** React Flow pan/zoom tests can be flaky in headless browsers due to pointer event timing. Add `{ force: true }` to drag interactions and use `waitForSelector` on node positions rather than animation-frame timing.
