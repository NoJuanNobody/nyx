# Implementation Plan: Rich Ticket Suggestion Viewer

**Feature Doc:** [rich-ticket-suggestion-viewer.md](./rich-ticket-suggestion-viewer.md)
**Issue:** [#238](https://github.com/NoJuanNobody/nyx/issues/238)
**Estimate:** ~3–4 days of frontend work

---

## Prerequisites

- [ ] Read and understand `apps/web/src/components/BulkTicketReview.tsx` fully
- [ ] Confirm `react-markdown` is already installed (check `apps/web/package.json`)
- [ ] Confirm no backend changes are needed (the full `description` is returned by the existing GET endpoint)

---

## Phase 1: Parsing Layer (Day 1, ~3h)

The most important foundation: a robust utility that takes a raw `TicketSuggestion` and returns structured, display-ready data.

### Step 1.1 — Create `parseSuggestion.ts`

**File:** `apps/web/src/lib/parseSuggestion.ts`

```typescript
export type SuggestionScope = 'S' | 'M' | 'L' | null;

export interface ParsedSuggestion extends TicketSuggestion {
  scope: SuggestionScope;
  cleanTitle: string;
  context: string;
  affectedAreas: string[];
  acceptanceCriteria: string[];
}

export function parseSuggestion(s: TicketSuggestion): ParsedSuggestion {
  // 1. Parse scope prefix from title
  const scopeMatch = s.title.match(/^\[(S|M|L)\]\s*/);
  const scope = (scopeMatch?.[1] as SuggestionScope) ?? null;
  const cleanTitle = scopeMatch ? s.title.slice(scopeMatch[0].length) : s.title;

  // 2. Parse markdown sections from description
  const context = extractSection(s.description, 'Context');
  const affectedAreas = extractBulletList(s.description, 'Affected Areas');
  const acceptanceCriteria = extractChecklistItems(s.description, 'Acceptance Criteria');

  return { ...s, scope, cleanTitle, context, affectedAreas, acceptanceCriteria };
}

// Helper: extract the text content of a ## Section from markdown
function extractSection(md: string, heading: string): string {
  const regex = new RegExp(
    `##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`,
    'i'
  );
  return md.match(regex)?.[1]?.trim() ?? '';
}

// Helper: extract bullet list items (- item) from a section
function extractBulletList(md: string, heading: string): string[] {
  const section = extractSection(md, heading);
  return section
    .split('\n')
    .filter(line => line.trim().startsWith('- '))
    .map(line => line.trim().replace(/^-\s+/, ''));
}

// Helper: extract checklist items (- [ ] item or - [x] item) from a section
function extractChecklistItems(md: string, heading: string): string[] {
  const section = extractSection(md, heading);
  return section
    .split('\n')
    .filter(line => /^-\s+\[[ x]\]/.test(line.trim()))
    .map(line => line.trim().replace(/^-\s+\[[ x]\]\s*/, ''));
}
```

### Step 1.2 — Write unit tests

**File:** `apps/web/src/lib/__tests__/parseSuggestion.test.ts`

Cover:
- Scope parsing for `[S]`, `[M]`, `[L]`, and absent prefix
- Clean title stripping
- Context extraction (full text, not just first line)
- Affected areas as array of strings
- Acceptance criteria as array of strings
- Empty description (all arrays empty, no crash)
- Description with missing sections (graceful degradation)
- Scope in middle of title (should not match — only prefix)

---

## Phase 2: SuggestionCard Component (Day 1, ~2h)

Extract the suggestion row from `BulkTicketReview` into its own component. This is important for testability and for adding the new visual elements cleanly.

### Step 2.1 — Create `SuggestionCard.tsx`

**File:** `apps/web/src/components/SuggestionCard.tsx`

```typescript
interface SuggestionCardProps {
  suggestion: ParsedSuggestion;
  isSelected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onViewDetails: (suggestion: ParsedSuggestion) => void;
  onDismiss: (id: string) => void;
}
```

Render:
1. Checkbox (left)
2. Body:
   - Row 1: `ScopeBadge` + title (cleanTitle) + status badge if approved/dismissed
   - Row 2: Label chips (map over `suggestion.labels`)
   - Row 3: Context one-liner (first 100 chars of `suggestion.context`, ellipsized)
   - Row 4: Affected areas count ("3 files affected")
3. Actions (right): "View details →" button, "Dismiss" button (only if pending)

**Scope badge colors:**
- `S` → green (`bg-green-100 text-green-800`)
- `M` → yellow (`bg-yellow-100 text-yellow-800`)
- `L` → red (`bg-red-100 text-red-800`)

### Step 2.2 — Write component tests

**File:** `apps/web/src/components/__tests__/SuggestionCard.test.tsx`

---

## Phase 3: SuggestionDetailDrawer Component (Day 2, ~4h)

The core new UI piece. This is a slide-in panel that renders the full structured content of a suggestion.

### Step 3.1 — Create `SuggestionDetailDrawer.tsx`

**File:** `apps/web/src/components/SuggestionDetailDrawer.tsx`

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

Layout (when `suggestion !== null`):
```
[Header]
  - [← Back] button (calls onClose)
  - Scope badge + cleanTitle
  - Label chips
  - Status badge

[Divider]

[Context Section]
  - Heading: "Context"
  - Rendered markdown text
  - "View in spec →" link (if context mentions a heading)

[Affected Areas Section]
  - Heading: "Affected Areas"
  - List of file paths (code font)

[Acceptance Criteria Section]
  - Heading: "Acceptance Criteria"
  - Styled read-only checklist items

[Divider]

[Footer actions]
  - [Edit] button (secondary) — if pending
  - [Dismiss] button (destructive) — if pending
  - [✓ Approve] button (primary) — if pending
  - Status message — if already approved/dismissed
```

**"View in spec" link logic:**
```typescript
function buildSpecLink(context: string, documentId: string): string | null {
  // Look for a pattern like §3.2 Title or heading in backticks or quotes
  // Build anchor: /documents/{documentId}#heading-slug
  // Return null if no heading reference found
}
```

**Markdown rendering:**
- Use `react-markdown` with `remarkGfm` for tables, task lists, etc.
- Apply `prose` Tailwind classes for readable typography.

### Step 3.2 — Animation/transition

Use a CSS transition for the slide-in effect:
```css
.drawer-enter { transform: translateX(100%); }
.drawer-enter-active { transform: translateX(0); transition: transform 200ms ease; }
```

Or use Tailwind's `translate-x-0` / `translate-x-full` with `transition-transform`.

### Step 3.3 — Write component tests

**File:** `apps/web/src/components/__tests__/SuggestionDetailDrawer.test.tsx`

---

## Phase 4: Filter Bar (Day 2, ~2h)

### Step 4.1 — Create `SuggestionFilters.tsx`

**File:** `apps/web/src/components/SuggestionFilters.tsx`

```typescript
interface SuggestionFiltersProps {
  allLabels: string[];      // derived from all suggestions in the list
  filters: SuggestionFilterState;
  onFiltersChange: (filters: SuggestionFilterState) => void;
  totalCount: number;
  filteredCount: number;
}

interface SuggestionFilterState {
  scope: SuggestionScope[];
  labels: string[];
  status: ('pending' | 'approved' | 'dismissed')[];
  search: string;
  sortBy: 'newest' | 'oldest' | 'scope-asc' | 'scope-desc' | 'alpha';
}
```

Render:
- Search input (debounced, 300ms)
- Scope toggle buttons: `[All]` `[S]` `[M]` `[L]` — multi-selectable, highlight active
- Label multi-select dropdown
- Sort dropdown
- Result count: "Showing 12 of 50"

### Step 4.2 — Filter logic hook: `useSuggestionFilters`

**File:** `apps/web/src/hooks/useSuggestionFilters.ts`

```typescript
function useSuggestionFilters(suggestions: ParsedSuggestion[]) {
  const [filters, setFilters] = useState<SuggestionFilterState>(defaultFilters);

  const filtered = useMemo(() => {
    return suggestions
      .filter(s => /* scope filter */)
      .filter(s => /* label filter */)
      .filter(s => /* status filter */)
      .filter(s => /* search filter (title + context) */)
      .sort(/* sortBy */)
  }, [suggestions, filters]);

  return { filters, setFilters, filtered };
}
```

---

## Phase 5: BulkTicketReview Integration (Day 3, ~3h)

Wire everything together in the existing modal.

### Step 5.1 — Apply `parseSuggestion` to all fetched suggestions

In `BulkTicketReview.tsx`:
```typescript
const parsedSuggestions = useMemo(
  () => suggestions.map(parseSuggestion),
  [suggestions]
);
```

### Step 5.2 — Add filter state

```typescript
const { filters, setFilters, filtered } = useSuggestionFilters(parsedSuggestions);
```

### Step 5.3 — Add drawer state

```typescript
const [detailSuggestion, setDetailSuggestion] = useState<ParsedSuggestion | null>(null);
```

### Step 5.4 — Update layout

Current layout:
```
[Modal header]
[Suggestions list]
[Footer: bulk actions]
```

New layout:
```
[Modal header]
[Filter bar]
[Two-panel row]
  [Suggestions list (60% when drawer open, 100% when closed)]
  [Detail drawer (40% when open, hidden when closed)]
[Footer: bulk actions]
```

Use `flex` with dynamic widths or CSS grid:
```typescript
<div className={`flex gap-4 ${detailSuggestion ? 'grid grid-cols-[3fr_2fr]' : ''}`}>
  <SuggestionList ... />
  {detailSuggestion && <SuggestionDetailDrawer ... />}
</div>
```

### Step 5.5 — Replace inline suggestion rows with `SuggestionCard`

Remove the existing inline row JSX and replace with `<SuggestionCard>`.

### Step 5.6 — Wire bulk-select to respect filters

The "Select All" / "Deselect All" button should operate on the **filtered** list, not all suggestions. Update the `handleSelectAll` logic.

---

## Phase 6: E2E Tests (Day 3–4, ~2h)

**File:** `e2e/ticket-suggestion-viewer.spec.ts`

Use the existing `authenticatedPage` fixture and existing mock AI patterns from `e2e/fixtures/test-base.ts`.

Key scenarios:
1. Open the Bulk Ticket Review modal
2. Click "View details" on a suggestion → drawer appears
3. Assert scope badge, labels, context, affected areas, acceptance criteria are all visible
4. Click "← Back" → drawer closes
5. Apply label filter → filtered count updates correctly
6. Apply scope filter → correct suggestions shown
7. Approve from drawer → suggestion status changes
8. Dismiss from drawer → suggestion status changes

Note: The mock AI fixture needs to return suggestions with the structured description format (with `## Context`, `## Affected Areas`, `## Acceptance Criteria` sections). Update the mock if necessary.

---

## Phase 7: Polish & QA (Day 4, ~2h)

- [ ] Responsive check: test at 1024px, 1280px, 1440px, 1920px
- [ ] Keyboard accessibility: Tab order through filter bar and suggestion cards
- [ ] Focus management: when drawer opens, focus the "← Back" button; when it closes, return focus to the card that opened it
- [ ] Empty state: what happens when filters produce 0 results
- [ ] Loading state: skeleton cards while suggestions are fetching
- [ ] Error state: if one suggestion fails to parse (missing sections), show gracefully

---

## File Checklist

### New files to create
- [ ] `apps/web/src/lib/parseSuggestion.ts`
- [ ] `apps/web/src/lib/__tests__/parseSuggestion.test.ts`
- [ ] `apps/web/src/components/SuggestionCard.tsx`
- [ ] `apps/web/src/components/__tests__/SuggestionCard.test.tsx`
- [ ] `apps/web/src/components/SuggestionDetailDrawer.tsx`
- [ ] `apps/web/src/components/__tests__/SuggestionDetailDrawer.test.tsx`
- [ ] `apps/web/src/components/SuggestionFilters.tsx`
- [ ] `apps/web/src/hooks/useSuggestionFilters.ts`
- [ ] `e2e/ticket-suggestion-viewer.spec.ts`

### Files to modify
- [ ] `apps/web/src/components/BulkTicketReview.tsx` — integrate all new components
- [ ] `apps/web/src/lib/api.ts` — no changes expected, but verify full description is returned

### Files NOT to modify
- `apps/api/src/services/ai.service.ts` — AI prompt already generates correct structure
- `apps/api/src/db/schema.ts` — no schema changes needed
- `apps/api/src/routes/suggestions.ts` — no API changes needed

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AI output format drifts (no longer uses `## Context` headings) | Low | High | The `parseSuggestion` utility degrades gracefully (empty sections), and AI prompt is stable |
| `react-markdown` not installed in `apps/web` | Low | Medium | Check `apps/web/package.json`; install with `pnpm --filter web add react-markdown remark-gfm` if missing |
| Two-panel layout breaks on small screens | Medium | Low | Fall back to full-overlay drawer below 1280px wide |
| Existing BulkTicketReview tests break | Medium | Medium | The refactor extracts rows to `SuggestionCard` — update test selectors after extraction |
| "View in spec" link can't find heading | Medium | Low | Feature degrades gracefully — hide the link when no heading match |

---

## Definition of Done

- [ ] `parseSuggestion` utility has 100% unit test coverage of described cases
- [ ] `SuggestionDetailDrawer` renders all sections correctly in Vitest
- [ ] Filter bar correctly filters and counts suggestions
- [ ] All E2E scenarios in `ticket-suggestion-viewer.spec.ts` pass in CI
- [ ] No TypeScript errors (`pnpm --filter web tsc --noEmit`)
- [ ] No regressions in existing `e2e/tickets.spec.ts`
- [ ] Visual review approved by design/product stakeholder
