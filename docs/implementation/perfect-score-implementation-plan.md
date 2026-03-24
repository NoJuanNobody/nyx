# Implementation Plan: Perfect Score (10/10) for AI Advisor Quality Scoring

**Issue:** #235
**Feature spec:** `docs/features/perfect-score-10-10.md`
**Estimated scope:** Small — prompt changes, frontend rendering, tests

---

## Overview

This plan breaks the implementation into four sequential phases. Each phase is independently committable and can be reviewed in isolation.

```
Phase 1 → Prompt engineering (backend)
Phase 2 → Score parsing hardening (backend)
Phase 3 → Frontend perfect-score state
Phase 4 → Tests
```

---

## Phase 1 — Prompt Engineering

**File:** `apps/api/src/services/ai.service.ts`

### 1a. `analyzeSpecQuality` system prompt

**Current** (line 128–129):
```typescript
system:
  `You are a technical specification quality analyzer. Given a spec document, rate its quality from 1 to 10 and provide actionable improvement suggestions. Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...]}${stageContext}`,
```

**Replace with:**
```typescript
system:
  `You are a technical specification quality analyzer. Given a spec document, rate its quality on a scale from 1 to 10 using these guidelines:

- Score 10: The document fully satisfies ALL quality criteria for its stage with no meaningful omissions or ambiguities. A score of 10 is achievable and should be awarded when genuinely earned.
- Score 8-9: Strong document with minor gaps.
- Score 6-7: Adequate but missing important elements.
- Score 4-5: Significant gaps requiring substantial work.
- Score 1-3: Incomplete or unclear; major rework needed.

When the document earns a score of 10, the suggestions array MUST be empty ([]). For all other scores, provide specific, actionable improvement suggestions.

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...]}${stageContext}`,
```

**Why this works:**
- Explicitly states 10 is achievable and should be awarded.
- Breaks the implicit contract that suggestions are always required.
- Mandates an empty suggestions array at score 10, preventing the AI from hedging.
- The per-stage context (injected via `stageContext`) is still appended and now anchors the AI's judgment to stage-specific criteria.

### 1b. `STAGE_QUALITY_PROMPTS` — add 10/10 criteria per stage

Extend each entry in `STAGE_QUALITY_PROMPTS` (lines 89–100) to include what earns a 10:

```typescript
const STAGE_QUALITY_PROMPTS: Record<string, string> = {
  conception:
    'Focus on: clarity of problem definition, evidence of market validation, target user identification, uniqueness of proposed approach, and completeness of problem framing. Score 10 requires: precise problem statement with supporting evidence, named and validated target user, differentiated approach, and explicit scope boundaries with no ambiguity.',
  definition:
    'Focus on: completeness of requirements, unambiguous language, user story coverage with acceptance criteria, measurable success metrics, and clearly bounded scope. Score 10 requires: all requirements complete and unambiguous, every user story with acceptance criteria, measurable success metrics, explicit out-of-scope list, and no open questions.',
  architecture:
    'Focus on: technical feasibility, traceability back to PRD requirements, scalability and security considerations, documented trade-offs, and dependency analysis. Score 10 requires: every decision traced to a requirement, fully specified data model and API contracts, addressed security and scalability, documented trade-offs with rationale, and no dangling dependencies.',
  implementation:
    'Focus on: AI-readiness (can an AI coding agent act on this spec?), testable acceptance criteria, edge case coverage, ticket granularity, and rollback planning. Score 10 requires: file-by-file changes listed, all acceptance criteria testable, edge cases enumerated, granular tickets, and a rollback plan — sufficient for an AI coding agent to act without clarification.',
  execution:
    'Focus on: documentation freshness, drift coverage against current codebase, release completeness, accuracy of documented behavior, and changelog coverage. Score 10 requires: documentation current with deployed codebase, all documented behavior accurate, complete changelog, verified drift coverage, and fully documented release.',
};
```

### 1c. `analyzeMeetingNoteQuality` system prompt

**Current** (lines 840–850):
```typescript
system:
  `You are a meeting notes quality analyzer for a technical team. Given meeting notes, rate their quality from 1 to 10 and provide actionable improvement suggestions. Evaluate based on these criteria:
- Are decisions clearly stated with owners?
- Are action items specific, assigned, and have deadlines?
- Are code references resolvable (file paths, not vague)?
- Are open questions properly flagged?
- Is the summary comprehensive?
- Is there proper speaker attribution?

Also extract metrics: count of decisions, action items, code references, and open questions.

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": [...], "meetingMetrics": {...}}`,
```

**Replace with:**
```typescript
system:
  `You are a meeting notes quality analyzer for a technical team. Given meeting notes, rate their quality on a scale from 1 to 10 using these criteria:
- Are decisions clearly stated with owners?
- Are action items specific, assigned, and have deadlines?
- Are code references resolvable (file paths, not vague)?
- Are open questions properly flagged?
- Is the summary comprehensive?
- Is there proper speaker attribution?

Score 10 is achievable and should be awarded when ALL of the above criteria are fully met with no omissions. When score is 10, the suggestions array MUST be empty ([]). For all other scores, provide specific, actionable improvement suggestions.

Also extract metrics: count of decisions, action items, code references, and open questions.

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", ...], "meetingMetrics": {"decisions": <number>, "actionItems": <number>, "codeReferences": <number>, "openQuestions": <number>}}`,
```

---

## Phase 2 — Score Parsing Hardening

**File:** `apps/api/src/services/ai.service.ts`

Both parsing blocks (lines 148–161 and lines 871–898) already handle JSON and text fallbacks correctly. Add score clamping to guard against out-of-range values from either path.

### 2a. In `analyzeSpecQuality` (line 150–153):

```typescript
// Before
return {
  score: typeof parsed.score === 'number' ? parsed.score : 5,
  suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
};

// After
const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
return {
  score: Math.min(10, Math.max(1, Math.round(rawScore))),
  suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
};
```

### 2b. In `analyzeSpecQuality` text fallback (lines 157–160):

```typescript
// Before
return {
  score: scoreMatch ? parseInt(scoreMatch[1], 10) : 5,
  suggestions: [text],
};

// After
const fallbackScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 5;
return {
  score: Math.min(10, Math.max(1, fallbackScore)),
  suggestions: text ? [text] : [],
};
```

### 2c. Apply the same clamping to both parse paths in `analyzeMeetingNoteQuality` (lines 882–898).

---

## Phase 3 — Frontend Perfect Score State

### 3a. `ScoreBadge` in `apps/web/src/components/AIAdvisor.tsx` (line 54–67)

```typescript
// Before
function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 7 ? 'bg-green-100 text-green-700' :
    score >= 4 ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-700';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}
      data-testid="ai-advisor-score"
    >
      Score: {score}/10
    </span>
  );
}

// After
function ScoreBadge({ score }: { score: number }) {
  const isPerfect = score === 10;
  const color =
    isPerfect ? 'bg-yellow-100 text-yellow-700' :
    score >= 7 ? 'bg-green-100 text-green-700' :
    score >= 4 ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-700';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}
      data-testid="ai-advisor-score"
    >
      {isPerfect ? '★ ' : ''}Score: {score}/10
    </span>
  );
}
```

### 3b. Accent color for perfect-score notification card

In the quality notification construction (line ~314 in `AIAdvisor.tsx`), add a case for score 10:

```typescript
// Before
accentColor: data.score >= 7 ? 'bg-green-400' : data.score >= 4 ? 'bg-amber-400' : 'bg-red-400',

// After
accentColor:
  data.score === 10 ? 'bg-yellow-400' :
  data.score >= 7 ? 'bg-green-400' :
  data.score >= 4 ? 'bg-amber-400' : 'bg-red-400',
```

### 3c. `AIQualityPanel.tsx` — empty suggestions and perfect score bar

Locate the suggestions rendering section and add a guard:

```typescript
// Before (approximate — render suggestions list)
<ul>
  {result.suggestions.map((s, i) => <li key={i}>{s}</li>)}
</ul>

// After
{result.suggestions.length > 0 ? (
  <ul>
    {result.suggestions.map((s, i) => <li key={i}>{s}</li>)}
  </ul>
) : (
  <p className="text-sm text-slate-500">
    {result.score === 10
      ? 'This document meets all quality criteria for its stage.'
      : 'No suggestions available.'}
  </p>
)}
```

For the score bar fill color:

```typescript
// Before
const pct = (score / 10) * 100;
// bar color: green if >=7, amber if >=4, red otherwise

// After — add gold for 10
const barColor =
  score === 10 ? 'bg-yellow-400' :
  score >= 7 ? 'bg-green-500' :
  score >= 4 ? 'bg-amber-500' : 'bg-red-500';
```

---

## Phase 4 — Tests

### 4a. Unit tests — `apps/api/src/services/__tests__/ai.service.test.ts`

Add tests covering:

```typescript
describe('analyzeSpecQuality', () => {
  it('returns score 10 with empty suggestions when AI returns perfect score', async () => {
    // Mock AI response: { score: 10, suggestions: [] }
    // Assert: { score: 10, suggestions: [] }
  });

  it('clamps score 11 down to 10', async () => {
    // Mock AI response: { score: 11, suggestions: [] }
    // Assert: score === 10
  });

  it('clamps score 0 up to 1', async () => {
    // Mock AI response: { score: 0, suggestions: ["..."] }
    // Assert: score === 1
  });

  it('returns score 10 from text fallback when JSON fails', async () => {
    // Mock AI response: plain text "10/10"
    // Assert: score === 10, suggestions === []  (empty text means no suggestion)
  });
});

describe('analyzeMeetingNoteQuality', () => {
  it('returns score 10 with empty suggestions for perfect meeting notes', async () => {
    // Mock AI response: { score: 10, suggestions: [], meetingMetrics: {...} }
    // Assert: score === 10, suggestions === []
  });
});
```

### 4b. E2E tests — `e2e/ai-quality-perfect-score.spec.ts`

```gherkin
Scenario: Perfect spec document receives 10/10 with gold badge
  Given the AI mock is configured to return score 10 with empty suggestions
  When the user opens a spec document and triggers "Analyze Quality"
  Then the score badge shows "★ Score: 10/10" with gold styling
  And the suggestions panel shows "This document meets all quality criteria for its stage."
  And the score bar is filled completely in gold

Scenario: Near-perfect spec receives 8/10 with normal green badge
  Given the AI mock returns score 8 with one suggestion
  When the user triggers "Analyze Quality"
  Then the score badge shows "Score: 8/10" with green styling
  And the suggestion is rendered in the suggestions list
```

**Test fixture note:** Add a `mockPerfectQuality` helper to `e2e/fixtures/test-base.ts` that intercepts `POST /api/ai/analyze` and returns `{ score: 10, suggestions: [] }`.

### 4c. Playwright selector update — `e2e/fixtures/selectors.ts`

Add:
```typescript
perfectScoreBadge: '[data-testid="ai-advisor-score"]', // already exists; filter by text content in tests
```

No new selector needed — filter by text `★ Score: 10/10` in the test assertion.

---

## Commit Strategy

| Commit | Files | Message |
|---|---|---|
| 1 | `apps/api/src/services/ai.service.ts` | `feat(ai): update quality scoring prompts to allow 10/10 and define per-stage rubrics` |
| 2 | `apps/api/src/services/ai.service.ts` | `fix(ai): clamp quality scores to 1–10 range in all parse paths` |
| 3 | `apps/web/src/components/AIAdvisor.tsx`, `AIQualityPanel.tsx` | `feat(ui): render gold perfect-score state for 10/10 quality scores` |
| 4 | `apps/api/src/services/__tests__/ai.service.test.ts`, `e2e/ai-quality-perfect-score.spec.ts` | `test: add unit and e2e tests for perfect 10/10 quality score` |

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| AI still rarely gives 10 after prompt changes | Medium | The explicit rubric and the mandatory empty-suggestions rule provide strong signal. Monitor score distribution in staging. |
| Existing callers crash on empty suggestions | Low | All known callers guard with `.map()` or `.length`. Phase 3 adds an explicit empty-state render. |
| Score clamping changes existing behavior | Very Low | Clamping only affects out-of-range values (0, 11+) which are currently unhandled bugs. |
| Gold colour clashes with existing amber | Low | `bg-yellow-400` vs `bg-amber-400` are visually distinct in Tailwind. Review in both light and dark contexts. |

---

## Definition of Done

- [ ] `analyzeSpecQuality` system prompt updated with 10/10 guidance and empty-suggestions rule.
- [ ] `STAGE_QUALITY_PROMPTS` updated with 10/10 criteria for all five stages.
- [ ] `analyzeMeetingNoteQuality` system prompt updated identically.
- [ ] Score clamping applied in all four parse paths (JSON + text fallback for each function).
- [ ] `ScoreBadge` renders gold with `★` prefix for score 10.
- [ ] Notification accent strip uses `bg-yellow-400` for score 10.
- [ ] `AIQualityPanel` renders "meets all quality criteria" message when suggestions is empty.
- [ ] `AIQualityPanel` score bar uses gold color for score 10.
- [ ] Unit tests cover: perfect score, score clamping (11→10, 0→1), text fallback at 10.
- [ ] E2E test covers: perfect score badge and empty suggestions panel.
- [ ] All existing quality-related tests still pass.

---

## References

- Feature spec: `docs/features/perfect-score-10-10.md`
- `apps/api/src/services/ai.service.ts` — prompt and parsing locations
- `apps/web/src/components/AIAdvisor.tsx` — `ScoreBadge`, notification construction
- `apps/web/src/components/AIQualityPanel.tsx` — bar and suggestions rendering
- `apps/api/src/services/governance.service.ts` — quality gate (not modified)
