# Lifecycle Explorer View (#38)

**TODO item:** #38
**Status:** TODO
**Priority:** P3 — MVP

---

## Overview

The Lifecycle Explorer is an interactive, full-screen React component that walks users through SyncDocs' 5-phase product lifecycle — Conception → Definition → Architecture → Implementation → Execution — showing what documents are created at each phase, who owns them, and how Claude AI assists. It renders in two contexts: as a **dashboard view** for returning users who want to re-orient or onboard a new team member, and as an **onboarding step** for new users completing initial workspace setup.

The component (`SyncDocs_Lifecycle.jsx`) already exists at the repository root as a working prototype. This doc defines how it integrates into the app, what data model drives it, and how it relates to the rest of the SyncDocs feature set.

## Why this matters

- **Mental model before interaction** — non-technical stakeholders and new engineers need to understand why SyncDocs has lifecycle stages before they encounter them in the editor, context menus, or AI Advisor. The Explorer delivers that context visually and interactively.
- **Bridges onboarding and discovery** — new users arrive in the editor understanding what stages are and why they exist. Returning users can always revisit the Explorer as a reference or team teaching tool.
- **Reinforces the full-stack vision** — the Explorer makes the connection explicit: every document belongs to a phase, every phase feeds the next, and AI is present at each step. This is the core SyncDocs value proposition in a single scrollable view.
- **Reduces stage abandonment** — users who understand the lifecycle model are more likely to assign stages to documents and use AI features. The Explorer is the cheapest path to that understanding.

## The 5 Phases

Each phase entry is drawn directly from the `stages` array in `SyncDocs_Lifecycle.jsx`.

### Phase 1 — Conception: Idea & Vision

| Field | Value |
|-------|-------|
| **Icon** | ◎ |
| **Accent color** | `#E8C547` (gold) |
| **Who** | Founder · Stakeholder · PM |
| **Description** | Where everything begins. An unstructured thought gets captured and shaped into a clear problem worth solving. |
| **Documents** | Problem Statement, Value Proposition, Market Opportunity, Rough Concept Notes |
| **Claude AI role** | Stress-tests your idea, identifies blind spots, suggests missing angles |
| **Output** | Validated concept brief ready for product definition |

### Phase 2 — Definition: Product Spec

| Field | Value |
|-------|-------|
| **Icon** | ◈ |
| **Accent color** | `#4EC9B0` (teal) |
| **Who** | PM · Product Designer · Stakeholder |
| **Description** | The product takes shape. Non-technical stakeholders define what needs to be built and why. |
| **Documents** | Product Requirements Doc (PRD), User Stories, Personas, Feature List, Competitive Analysis |
| **Claude AI role** | Flags ambiguous requirements, generates user stories from PRD, scores completeness |
| **Output** | Structured PRD that engineering can trust |

### Phase 3 — Architecture: System Design

| Field | Value |
|-------|-------|
| **Icon** | ◫ |
| **Accent color** | `#7B9FE0` (indigo) |
| **Who** | Tech Lead · Senior Engineer · Architect |
| **Description** | Decisions get made. The technical foundation is designed with full traceability back to the product vision. |
| **Documents** | System Architecture Doc, Data Models, API Contracts, Component Hierarchy, Tech Stack Decisions |
| **Claude AI role** | Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent |
| **Output** | Architecture docs linked to every PRD requirement they serve |

### Phase 4 — Implementation: Dev Specs

| Field | Value |
|-------|-------|
| **Icon** | ◧ |
| **Accent color** | `#C084FC` (purple) |
| **Who** | Engineer · QA · Tech Lead |
| **Description** | Specs are written to be consumed by AI coding agents. Every ticket traces back to a user story. |
| **Documents** | AI-Ready Feature Specs, Ticket Breakdowns, Acceptance Criteria, Edge Cases, Test Plans |
| **Claude AI role** | Scores spec quality for AI code generation, auto-generates tickets, suggests edge cases |
| **Output** | Implementation-ready specs optimized for Claude Code & Copilot |

### Phase 5 — Execution: Code & Sync

| Field | Value |
|-------|-------|
| **Icon** | ◉ |
| **Accent color** | `#F87171` (red) |
| **Who** | Engineer · AI Coding Agent |
| **Description** | Code is written — by humans or AI agents. SyncDocs watches for drift and keeps the full stack in sync. |
| **Documents** | Living Codebase, Auto-Updated Docs, Drift Alerts, Change History, Rollback Points |
| **Claude AI role** | Watches commits, detects doc-code drift in real time, flags intent violations |
| **Output** | Codebase that never diverges silently from its original intent |

### Phase-to-phase connectors

The `connectors[]` array describes the handoff between consecutive phases. These are displayed as a pill below the detail card while the user is on phases 1–4.

| Transition | Connector phrase |
|------------|-----------------|
| Phase 1 → 2 | "Concept brief seeds the PRD" |
| Phase 2 → 3 | "PRD requirements drive architecture" |
| Phase 3 → 4 | "Architecture shapes implementation specs" |
| Phase 4 → 5 | "Specs generate code via AI agents" |

## Where it lives in the app

The Explorer component is used in two placement contexts, both rendering the same `<LifecycleExplorer />` component with different props.

### 1. Dashboard view

Accessible via a "Product Lifecycle" tab or card in the main dashboard. Lets returning users re-orient, explore a phase in depth, or walk a new team member through the SyncDocs model without entering the editor.

- Entry point: dashboard tab labeled "How SyncDocs works" or a card in the getting-started section
- Always accessible — not a one-time-only flow
- Renders in full-page mode with no onboarding chrome around it
- No forced progression — user can jump to any stage freely

### 2. Onboarding step

Rendered as a step in the new-user onboarding flow, shown after workspace setup and before first document creation.

- Entry point: automatic — triggered after the user creates their workspace
- Skippable at any point via a "Skip intro" link
- Auto-advances to phase 1 on arrival; user clicks "Next →" to progress
- On phase 5, a CTA appears: "Start with [current stage] →" and "Skip to editor →"
- Re-accessible from the dashboard after onboarding completes

## UI/UX Design

### Stage rail

A horizontal row of 5 circular icon nodes connected by lines sits at the top of the Explorer. The active node is highlighted in the phase's accent color with a glow effect. Completed nodes (phases already visited) show a gradient connector between them; unvisited transitions show a muted line. Clicking any node jumps directly to that phase.

```
  ◎ ——————— ◈ ——————— ◫ ——————— ◧ ——————— ◉
  (gold)   (teal)   (indigo)  (purple)  (red)
CONCEPTION DEFINITION ARCHITECTURE IMPLEMENTATION EXECUTION
```

### Main detail card

A max-width-720 dark card (`#0D1520` background) with four sections:

1. **Phase header** — phase number label (in monospace), large phase label, role line, description paragraph, and a large faded phase icon at top-right
2. **Document badges** — pill tags for each document type at this phase, colored with the phase accent at low opacity
3. **AI layer panel** — a bordered sub-panel labeled "✦ Claude AI at this stage" showing Claude's role description for this phase
4. **Output line** — a single line: `Output → [phase output description]`

### Ambient glow

A radial gradient positioned behind the detail card shifts to the active phase's accent color on transition (`background 0.6s ease`). Creates a subtle environmental color shift that reinforces which phase is active without overwhelming the UI.

### Connector pill

Below the detail card (hidden on phase 5), a pill shows the phase-to-phase handoff description. Helps users understand why phases are ordered the way they are.

### Navigation controls

Three navigation elements sit below the connector pill:

- **← prev button** — disabled and visually muted on phase 1
- **Dot indicator row** — 5 dots; active dot expands horizontally (width 20px vs 6px) and fills with the active phase color; clicking any dot jumps to that phase
- **next → button** — styled with the active phase accent color; disabled and visually muted on phase 5; in onboarding mode, phase 5 shows a CTA button instead

### Responsive behavior

The Explorer is desktop-only for MVP (consistent with the rest of the app). Mobile/touch support (vertical stage rail or accordion layout) is post-MVP.

### Animations

| Element | Transition |
|---------|-----------|
| Stage node border, background, shadow | `all 0.3s ease` |
| Phase label color in header | `color 0.4s` |
| Ambient glow background | `background 0.6s ease` |
| Connector line fill | `background 0.4s` |
| Dot indicator width | `all 0.3s` |
| Card border color | `border-color 0.4s` |

### Typography

- **Headings / phase labels** — Syne (700–800 weight)
- **Metadata labels, badges, monospace elements** — JetBrains Mono
- **Body / description text** — Syne (400 weight)

### Color palette

Background: `#080C10` (body), `#0D1520` (card)
Text hierarchy: `#F1F5F9` (primary), `#94A3B8` (secondary), `#64748B` (tertiary), `#475569` (labels)
Borders: `#1E293B` (default), `{phase.color}30` (active card border)

## Data Model

The component's phase data lives in a `stages` array. In the integrated app, this array is imported from the shared config at `apps/web/src/lib/stages.ts` — the same source used by the FileTree context menu (#35), stage filter dropdown, and AI Advisor panel (#49). The component does not define its own copy.

```ts
// apps/web/src/lib/stages.ts
interface LifecycleStage {
  id: number;           // 1–5
  phase: string;        // "Conception", "Definition", "Architecture", "Implementation", "Execution"
  label: string;        // "Idea & Vision", "Product Spec", "System Design", "Dev Specs", "Code & Sync"
  icon: string;         // Unicode symbol: ◎ ◈ ◫ ◧ ◉
  color: string;        // Hex accent: #E8C547 #4EC9B0 #7B9FE0 #C084FC #F87171
  docs: string[];       // Document type names produced at this phase
  who: string;          // Role(s) who own this phase
  ai: string;           // One-line Claude AI role description
  description: string;  // Phase narrative paragraph
  output: string;       // What the phase produces
}

// connectors: string[] — 4 strings describing phase-to-phase handoffs (index = from-phase index)
```

The component also accepts props to control its onboarding behavior:

```ts
interface LifecycleExplorerProps {
  mode?: "dashboard" | "onboarding";   // default: "dashboard"
  onComplete?: () => void;             // called when user clicks the phase-5 CTA in onboarding mode
  initialPhase?: number;               // 0-indexed; default: 0
}
```

## Relationship to Document Lifecycle Stages (#35)

The Lifecycle Explorer and the FileTree context menu (#35) share the same `stages.ts` config. Changes to stage labels, colors, or icons flow to both automatically.

- **Explorer = read-only explanation** — the Explorer shows what stages are and what they contain. It does not assign stages to documents or manage documents in any way.
- **Context menu = interactive assignment** — the right-click menu in the FileTree lets users create stage-tagged documents and reassign existing documents between stages.
- **Visual consistency** — the colored stage badges users see on documents in the FileTree use the same hex values as the Explorer's accent colors. Users who have seen the Explorer will immediately recognize the badges.

The Explorer view is deliberately read-only. Stage assignment happens in the editor sidebar or via the FileTree context menu — not in the Explorer.

## Onboarding Integration

The Explorer slots into the new-user onboarding flow as follows:

### Flow position

```
1. Create account
2. Name your workspace
3. [Lifecycle Explorer — this component]
4. Create your first document
```

### Behavior in onboarding mode

- The Explorer renders in `mode="onboarding"` with onboarding chrome (step indicator, "Skip intro" link) wrapping the component
- Phase 1 (Conception) is active by default
- User advances via the "Next →" button (or by clicking stage nodes directly — skipping ahead is allowed)
- On phase 5, "next →" is replaced by two CTAs:
  - **"Start with [phase name] →"** — creates a blank document at the stage the user ended on and opens the editor
  - **"Skip to editor →"** — opens the editor with no pre-selected stage
- **"Skip intro"** link is always visible and jumps directly to document creation with no stage pre-selected
- On completion or skip, `onComplete()` is called and the onboarding flow advances to step 4

### Re-accessibility

After onboarding, the Explorer is always accessible from the dashboard. No data about whether the user completed or skipped the Explorer flow is used to gate any feature — it's purely informational.

## Relationship to Existing Components

| Component | Status | Notes |
|-----------|--------|-------|
| `SyncDocs_Lifecycle.jsx` | Exists (root) | Move to `apps/web/src/components/LifecycleExplorer.tsx`, convert to TypeScript, import `stages` and `connectors` from `stages.ts` instead of defining them inline |
| `stages.ts` | Exists | No changes needed. The `stages` array must include `icon`, `ai`, `output`, and `docs` fields — verify these are present |
| `Dashboard.tsx` | Planned | Add a "Product Lifecycle" tab or card that renders `<LifecycleExplorer mode="dashboard" />` |
| `OnboardingFlow.tsx` | Planned | Add `<LifecycleExplorer mode="onboarding" onComplete={next} />` as step 3 |
| `FileTree.tsx` context menu | Planned (#35) | Shares `stages.ts` — no direct dependency on LifecycleExplorer |
| `AIAdvisorPanel.tsx` | Planned (#49) | Shares `stages.ts` — no direct dependency on LifecycleExplorer |

## Open Questions

- **Dashboard entry point** — should the Explorer be a dedicated tab in the top nav, a card in the dashboard home, or both? Decision affects how prominent the lifecycle mental model is vs. getting out of the user's way once they know it.
- **Stage-5 CTA pre-selection** — when the user clicks "Start with [phase name] →" at onboarding step 5, should the phase be the last one the user visited, or always phase 1? The current plan (last visited) could confuse users who clicked around freely.
- **Accessibility** — the current prototype uses `onClick` handlers on `<div>` elements. The integrated version should use `<button>` elements with proper `aria-label` and keyboard focus management for the stage rail nodes.

---

## E2E Testing

### Playwright test file location

```
tests/e2e/lifecycle-explorer.spec.ts
```

### Critical user flows

1. Navigate all 5 phases by clicking stage rail nodes directly
2. Navigate phases sequentially via prev/next buttons
3. Verify the detail card updates correctly for each phase (docs, AI role, output, connector pill)
4. Verify boundary conditions: prev disabled on phase 1, next disabled on phase 5
5. Navigate via dot indicator row
6. Onboarding flow: arrive at Explorer, advance through all phases, click phase-5 CTA
7. Onboarding flow: skip intro via "Skip intro" link
8. Dashboard access: Explorer renders and is interactive from the dashboard entry point

### Test scenarios

#### Scenario: Navigate to phase 3 via stage rail

```
Given the Lifecycle Explorer is rendered on the dashboard
When the user clicks the Architecture node (phase 3)
Then the card heading shows "System Design"
And the accent color transitions to #7B9FE0
And the document badges include "System Architecture Doc", "Data Models", "API Contracts", "Component Hierarchy", "Tech Stack Decisions"
And the AI panel shows "Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent"
And the output line shows "Architecture docs linked to every PRD requirement they serve"
And the connector pill shows "Architecture shapes implementation specs"
```

#### Scenario: Navigate via next button through all phases

```
Given the Lifecycle Explorer is on phase 1
When the user clicks "next →" four times
Then the Explorer reaches phase 5 (Execution)
And the "next →" button is disabled
And no connector pill is visible
And the card shows the Execution phase content
```

#### Scenario: Prev button disabled on phase 1

```
Given the Lifecycle Explorer is on phase 1 (initial state)
Then the "← prev" button is disabled (aria-disabled="true" and visually muted)
When the user advances to phase 2
Then the "← prev" button is enabled
When the user clicks "← prev"
Then the Explorer returns to phase 1
```

#### Scenario: Onboarding flow — advance through all phases and complete

```
Given a new user has completed workspace setup
When the onboarding Lifecycle Explorer step is displayed
Then phase 1 (Conception) is active
And the "Skip intro" link is visible
When the user clicks "next →" four times to reach phase 5
Then the "next →" button is replaced by two CTAs: "Start with Code & Sync →" and "Skip to editor →"
When the user clicks "Start with Code & Sync →"
Then the onboarding flow advances to document creation
And the new document is pre-tagged with the Execution stage
```

#### Scenario: Onboarding flow — skip intro

```
Given the onboarding Lifecycle Explorer step is displayed on phase 1
When the user clicks "Skip intro"
Then the onboarding flow advances to document creation immediately
And no stage is pre-selected
```

#### Scenario: Dot indicator navigation

```
Given the Lifecycle Explorer is on phase 1
When the user clicks the 4th dot in the indicator row
Then the Explorer jumps to phase 4 (Implementation)
And the 4th dot expands and fills with #C084FC
```

### Integration boundaries

| Dependency | Treatment |
|-----------|-----------|
| `stages.ts` config data | No mock needed — static config imported directly, no API calls |
| Authentication / user session | Fixture file for authenticated user state (`tests/e2e/fixtures/auth.ts`) |
| Onboarding flow state | Seed a fresh workspace with no documents via `beforeEach` setup |
| External APIs (GitHub, Jira) | Not involved — Explorer has no external dependencies |

The Explorer has no API calls of its own. All test data is static config. The only external dependency is the user session for tests that exercise the onboarding flow context.

### Test data requirements

| Requirement | Details |
|------------|---------|
| Authenticated user | Standard test user fixture with a workspace |
| Fresh workspace | No existing documents — required for onboarding flow tests to start from step 1 |
| Dashboard access | User with completed onboarding — so dashboard tests don't redirect to onboarding |
| Stage config integrity | `stages.ts` must contain all 5 stages with `id`, `phase`, `label`, `icon`, `color`, `docs`, `who`, `ai`, `description`, `output` fields populated |

### Playwright configuration

No special environment variables are required. The Explorer renders entirely from static config with no API calls.

Tests should run in the standard Playwright browser matrix:

```ts
// playwright.config.ts
projects: [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
  { name: "webkit",   use: { ...devices["Desktop Safari"] } },
]
```

### CI considerations

- No additional service containers required (no database, no API server needed for Explorer-only tests)
- Tests can run in parallel with other UI tests — no shared mutable state
- Onboarding tests do require an authenticated session; the CI environment must have `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` set (standard for all E2E tests, not Explorer-specific)
- Recommended to tag Explorer tests with `@lifecycle` so they can be run in isolation:
  ```bash
  npx playwright test --grep @lifecycle
  ```
