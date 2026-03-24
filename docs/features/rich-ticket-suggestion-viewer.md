# Feature: Rich Ticket Suggestion Viewer

**Issue:** [#238 — Need better viewable ticket suggestion](https://github.com/NoJuanNobody/nyx/issues/238)
**Status:** Planned
**Owner:** TBD
**Target:** MVP

---

## Overview

Nyx's AI already generates deeply structured ticket suggestions — each one includes a scope level (`[S]`/`[M]`/`[L]`), a `## Context` section referencing the spec, an `## Affected Areas` section listing impacted files/modules, and a `## Acceptance Criteria` checklist. None of this structure is surfaced to the user today.

Users currently see a flat list of suggestion cards with truncated text and no way to open a full view of a suggestion before approving or dismissing it. This creates friction: stakeholders can't make informed decisions, developers can't verify accuracy, and the rich AI output is invisible.

This feature adds a **Suggestion Detail Drawer** and upgrades the suggestion list with structured metadata badges, making the full content of every suggestion visible, navigable, and actionable.

---

## Problem Statement

### What's broken today

1. **No detail view.** Users see a truncated description in the bulk review list. There is no way to read a suggestion's full content before approving it.
2. **AI-generated structure is invisible.** The AI generates `## Context`, `## Affected Areas`, and `## Acceptance Criteria` sections in every description, but the frontend renders them as raw text (or truncates them entirely).
3. **Scope is hidden in the title.** Scope prefixes (`[S]`, `[M]`, `[L]`) are embedded as text in the title string rather than displayed as visual badges.
4. **Labels are not shown.** The `labels` field exists in the database and is populated by the AI, but is never rendered in the UI.
5. **No filtering or grouping.** Users cannot sort by scope, filter by label, or group by category, making it hard to triage 50+ suggestions at once.
6. **No spec link-back.** The `## Context` section references a specific heading in the originating spec, but there is no clickable link from the suggestion to that spec section.

### Impact

- **Non-technical stakeholders** can't understand suggestions without the full context section.
- **Developers** can't validate acceptance criteria before approving.
- **Teams** lose trust in AI suggestions because they appear vague and low-detail.
- Bulk approval of 50+ suggestions is effectively a coin flip.

---

## Goals

1. Make every suggestion fully readable before a decision is made.
2. Surface AI-generated structure (scope, labels, affected areas, acceptance criteria) as first-class UI elements.
3. Reduce time-to-decision per suggestion by improving information density.
4. Maintain the existing bulk-selection and bulk-approval workflow.

## Non-Goals

- Changing the AI prompt or the structure of generated suggestions (that already works well).
- Replacing the BulkTicketReview modal with a new page.
- Adding new suggestion fields to the database schema (not needed — the data is already there).
- Implementing dependent/linked ticket relationships (future work).

---

## User Stories

### US-1: View full suggestion content
**As a** product manager reviewing AI-generated ticket suggestions,
**I want to** click on any suggestion and see its full structured content in a side panel,
**So that** I can read the spec context, affected areas, and acceptance criteria before approving.

**Acceptance criteria:**
- Clicking a suggestion card opens a detail drawer without closing the bulk review modal.
- The drawer renders the full markdown description including all headings and lists.
- The drawer shows the scope badge, labels, and title prominently at the top.
- Closing the drawer returns focus to the suggestion list.

### US-2: See scope and labels at a glance
**As a** developer triaging 50 suggestions,
**I want to** see scope size badges and label chips on every suggestion card,
**So that** I can quickly identify small, high-priority tasks versus large feature work.

**Acceptance criteria:**
- Scope badges (`S`, `M`, `L`) are parsed from the title prefix and rendered as colored chips (not in the title string).
- Labels are rendered as small chips below the title.
- The raw `[S]`/`[M]`/`[L]` prefix is stripped from the displayed title.

### US-3: Filter and sort suggestions
**As a** developer,
**I want to** filter suggestions by label or scope and sort them by scope size,
**So that** I can batch-approve all small tasks first or focus on a specific label.

**Acceptance criteria:**
- Filter bar allows selecting one or more labels (multi-select).
- Scope filter allows selecting S, M, L, or any combination.
- Sort options include: creation date (default), scope (S→L), scope (L→S), alphabetical.
- Filters persist within the session (reset on modal close).
- Count of filtered vs. total is shown.

### US-4: View acceptance criteria as interactive checklist
**As a** developer reviewing a suggestion before approval,
**I want to** see the acceptance criteria as a readable checklist in the detail view,
**So that** I can evaluate completeness and accuracy before pushing to GitHub/Jira.

**Acceptance criteria:**
- The `## Acceptance Criteria` section is rendered as a formatted checklist in the drawer.
- Checkbox items are styled clearly (not raw markdown `- [ ]`).
- The checklist is read-only (not editable in the viewer — editing is a separate workflow).

### US-5: Navigate to the source spec section
**As a** non-technical stakeholder,
**I want to** click a link from the suggestion's Context section to jump to the relevant part of the spec,
**So that** I can verify what change triggered this suggestion.

**Acceptance criteria:**
- The `## Context` section in the drawer includes a "View in spec" link if the referenced heading exists in the parent document.
- Clicking the link opens the document editor scrolled to the referenced heading.

---

## Design Specification

### Suggestion Card (list item in BulkTicketReview)

**Current state:** Title + truncated description text + status badge.

**Proposed state:**
```
┌─────────────────────────────────────────────────────┐
│  ☐  [M] Refactor auth middleware for session tokens  │
│                                                       │
│     🏷 security  🏷 enhancement                       │
│                                                       │
│     Context: §3.2 Authentication Requirements         │
│     Affected: src/middleware/auth.ts, src/routes/...  │
│                                                       │
│                          [View details →]  [Dismiss]  │
└─────────────────────────────────────────────────────┘
```

Key changes from current:
- Scope badge (`S`/`M`/`L`) as colored chip before title
- Labels as small chips (not hidden)
- One-line context summary (first line of `## Context`)
- Affected areas summary (first file path from `## Affected Areas`)
- "View details →" button that opens the drawer
- Title no longer includes the raw `[S]`/`[M]`/`[L]` prefix

### Suggestion Detail Drawer

A slide-in panel from the right side of the BulkTicketReview modal:

```
┌────────────────────────────────────────────────────────┐
│                                          [← Back] [✕]  │
│  [M]  Refactor auth middleware for session tokens       │
│       🏷 security  🏷 enhancement                       │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  ## Context                                             │
│  Per §3.2 Authentication Requirements, session tokens   │
│  are currently stored in a manner that does not meet    │
│  the new compliance requirements.        [View in spec] │
│                                                         │
│  ## Affected Areas                                      │
│  • src/middleware/auth.ts                               │
│  • src/routes/auth.ts                                   │
│  • apps/api/src/services/session.service.ts             │
│                                                         │
│  ## Acceptance Criteria                                 │
│  ☐ Session tokens are stored using HttpOnly cookies     │
│  ☐ Token rotation is implemented on every request       │
│  ☐ Existing tests pass with updated implementation      │
│  ☐ Load test confirms no regression in auth latency     │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│  [Edit suggestion]        [Dismiss]   [✓ Approve]       │
└────────────────────────────────────────────────────────┘
```

### Filter Bar (top of BulkTicketReview)

```
Search: [_________________________]
Scope:  [All ▾] [S] [M] [L]
Labels: [All ▾] [security] [bug] [enhancement] [testing]
Sort:   [Newest first ▾]
                          Showing 12 of 50 suggestions
```

---

## Technical Specification

### Frontend Changes

#### 1. Parsing utility: `parseSuggestion(suggestion: TicketSuggestion)`

New file: `apps/web/src/lib/parseSuggestion.ts`

Responsibilities:
- Parse `[S]`/`[M]`/`[L]` prefix from `title` → return `{ scope, cleanTitle }`.
- Parse `description` markdown → extract `context`, `affectedAreas`, `acceptanceCriteria` sections.
- Return a `ParsedSuggestion` type that extends `TicketSuggestion`.

```typescript
export type SuggestionScope = 'S' | 'M' | 'L' | null;

export interface ParsedSuggestion extends TicketSuggestion {
  scope: SuggestionScope;
  cleanTitle: string;
  context: string;          // text content of ## Context section
  affectedAreas: string[];  // bullet list items from ## Affected Areas
  acceptanceCriteria: string[]; // checklist items from ## Acceptance Criteria
}

export function parseSuggestion(s: TicketSuggestion): ParsedSuggestion;
```

#### 2. New component: `SuggestionDetailDrawer`

New file: `apps/web/src/components/SuggestionDetailDrawer.tsx`

Props:
```typescript
interface SuggestionDetailDrawerProps {
  suggestion: ParsedSuggestion | null;
  onClose: () => void;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onEdit: (id: string) => void;
  documentId: string;
}
```

Behavior:
- Renders as a right-side panel within the BulkTicketReview modal (not a separate modal).
- Uses `react-markdown` (already a dependency) to render description sections.
- "View in spec" link: builds anchor link from heading text using slugification.
- Acceptance criteria items are rendered as styled read-only checkboxes.

#### 3. Updated component: `SuggestionCard` (extracted from BulkTicketReview)

Extract the suggestion row into its own component for clarity and testability.

File: `apps/web/src/components/SuggestionCard.tsx`

Props:
```typescript
interface SuggestionCardProps {
  suggestion: ParsedSuggestion;
  isSelected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onViewDetails: (suggestion: ParsedSuggestion) => void;
  onDismiss: (id: string) => void;
}
```

Renders:
- Checkbox
- Scope badge (color-coded: S=green, M=yellow, L=red)
- Clean title (no `[S]`/`[M]`/`[L]` prefix)
- Label chips
- Context one-liner
- Affected area count
- "View details" and "Dismiss" buttons

#### 4. Updated component: `BulkTicketReview`

File: `apps/web/src/components/BulkTicketReview.tsx`

Changes:
- Add `selectedSuggestion: ParsedSuggestion | null` state for the drawer.
- Apply `parseSuggestion()` to all fetched suggestions before rendering.
- Add filter bar: scope filter, label filter, search input, sort selector.
- Render `SuggestionDetailDrawer` when `selectedSuggestion` is set.
- Use two-panel layout when drawer is open (list narrows to ~60% width).
- Wire "View details →" button on each card to open the drawer.

#### 5. Filter state (local, not persisted)

```typescript
interface SuggestionFilters {
  scope: SuggestionScope[];       // empty = show all
  labels: string[];               // empty = show all
  status: ('pending' | 'approved' | 'dismissed')[];
  search: string;
  sortBy: 'newest' | 'oldest' | 'scope-asc' | 'scope-desc' | 'alpha';
}
```

Filter logic lives in a `useMemo` hook inside `BulkTicketReview`.

### Backend Changes

No backend changes are required. All the data needed for the richer view is already present in the `ticket_suggestions` table and populated by the AI. The existing `GET /documents/:documentId/ticket-suggestions` endpoint returns the full `description` text.

If the `GET` endpoint is paginating and truncating the `description` field, that should be checked and fixed — but based on the current implementation it returns the full text.

### Database Changes

No schema migrations required.

---

## Test Plan

### Unit Tests (Vitest)

**File:** `apps/web/src/lib/__tests__/parseSuggestion.test.ts`

Tests:
- Parses `[S]`, `[M]`, `[L]` scope from title correctly
- Returns `null` scope when no prefix present
- Strips scope prefix from `cleanTitle`
- Extracts `## Context` section text
- Extracts `## Affected Areas` as array of strings
- Extracts `## Acceptance Criteria` items as array
- Handles malformed/missing sections gracefully (empty arrays, not crash)

**File:** `apps/web/src/components/__tests__/SuggestionCard.test.tsx`

Tests:
- Renders scope badge with correct color for S/M/L
- Renders label chips
- Calls `onViewDetails` when "View details" clicked
- Calls `onDismiss` when "Dismiss" clicked
- Checkbox calls `onSelect` with correct args

**File:** `apps/web/src/components/__tests__/SuggestionDetailDrawer.test.tsx`

Tests:
- Renders all sections (Context, Affected Areas, Acceptance Criteria)
- "View in spec" link is present when context references a heading
- "Approve" button calls `onApprove` with correct id
- "Dismiss" button calls `onDismiss` with correct id
- "Edit" button calls `onEdit` with correct id
- Drawer closes when `onClose` is called

### E2E Tests (Playwright)

**File:** `e2e/ticket-suggestion-viewer.spec.ts`

Scenarios:
1. **Open detail drawer** — click "View details" on a suggestion → drawer opens with full content.
2. **Drawer shows scope and labels** — verify scope badge and label chips are visible.
3. **Filter by label** — select "security" label filter → only security suggestions shown.
4. **Filter by scope** — select "S" scope → only small suggestions shown.
5. **Approve from drawer** — click "Approve" in drawer → suggestion moves to approved state.
6. **Dismiss from drawer** — click "Dismiss" in drawer → suggestion moves to dismissed state.
7. **Drawer closes on back click** — click "← Back" → drawer closes, list still visible.

### Manual QA Checklist

- [ ] Drawer opens/closes without layout shift on small viewports (1024px wide)
- [ ] Markdown renders correctly (headings, bullets, code blocks) in drawer
- [ ] Filter counts update correctly as filters change
- [ ] Bulk-select still works when filters are active (selects filtered items only)
- [ ] Scope badges use consistent colors across cards and drawer header
- [ ] "View in spec" link scrolls document to correct heading

---

## Rollout & Flags

No feature flag needed. This is purely additive UI — it doesn't change API behavior, database schema, or AI prompt. The drawer opens only when a user clicks "View details"; default behavior (flat list) is unchanged.

---

## Open Questions

1. **Two-panel vs. full overlay:** Should the detail drawer slide in alongside the suggestion list (two-panel) or overlay the list entirely? Two-panel is better on wide screens but degrades on laptops. Recommend two-panel with fallback to full overlay below 1280px wide.

2. **"View in spec" link depth:** The `## Context` section references a heading by name (e.g., "§3.2 Authentication Requirements"). Should we fuzzy-match against actual document headings, or use the exact string? Recommend exact-match first with graceful degradation (hide the link if no match).

3. **Edit from drawer:** Should the "Edit suggestion" button open an inline edit form inside the drawer, or open the existing edit modal? Recommend inline edit form in the drawer (better UX, avoids modal stacking).

4. **Acceptance criteria interactivity:** Should acceptance criteria be checkable (local state, not persisted) to allow reviewers to "pre-check" items during review? This would be read-only to the database. Nice-to-have; not blocking MVP.

---

## Appendix: Current AI Output Structure (Reference)

The AI currently generates descriptions in this format:

```markdown
## Context
[Specific reference to which part of the spec triggered this suggestion, including heading/section identifier]

## Affected Areas
- [file path or module 1]
- [file path or module 2]

## Acceptance Criteria
- [ ] [specific, testable criterion]
- [ ] [specific, testable criterion]
- [ ] [specific, testable criterion]
```

Titles are formatted as: `[S] Title text here`, `[M] Title text here`, or `[L] Title text here`.

Labels are drawn from: `bug`, `enhancement`, `drift`, `spec-gap`, `testing`, `security`, `performance`, `accessibility`, `documentation`.

This structure is stable and can be reliably parsed by the frontend utility described above.
