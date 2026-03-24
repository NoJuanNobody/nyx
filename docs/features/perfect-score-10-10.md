# Feature Specification: Allow Maximum Score of 10/10 in AI Advisor Quality Scoring

**Issue:** #235
**Status:** Draft
**Author:** Alejandro Londono
**Affects:** Spec quality scoring, meeting note quality scoring

---

## Overview

The AI Advisor scores documents on a 1–10 quality scale to help users understand how well their specifications and meeting notes are written. Currently, the AI model almost never returns a score of 10 because the system prompt implicitly demands improvement suggestions in every response — creating a structural bias against perfect scores even when a document genuinely meets all quality criteria.

This feature corrects that bias by:

1. Rewriting the system prompts to explicitly define when 10/10 is earned and to permit an empty suggestions list for perfect documents.
2. Adding per-stage rubrics that state the criteria for each score band, including 10/10.
3. Updating the frontend to render a distinct "perfect score" state so users know they have reached the ceiling.

---

## Problem Statement

### Root Cause

The `analyzeSpecQuality` system prompt in `apps/api/src/services/ai.service.ts` (line 129) reads:

> "Given a spec document, rate its quality from 1 to 10 **and provide actionable improvement suggestions**."

Because the phrase "provide actionable improvement suggestions" appears unconditionally, the model interprets this as "always find something to improve." Claude is trained to be helpful, so it manufactures suggestions even for documents that are objectively complete — and then assigns a score of 8 or 9 to justify having suggestions at all.

The same problem exists in `analyzeMeetingNoteQuality` (line 840).

### Observed Symptoms

- Documents that satisfy every stated requirement consistently score 8–9/10.
- The suggestions panel always shows at least one item, even for near-perfect documents.
- Users who iterate on feedback to address every suggestion still cannot reach 10/10.
- The quality gate threshold of 7/10 becomes the effective ceiling in practice, because anything above it reads as "done."

### User Impact

- High-quality documentation is incorrectly signalled as having room for improvement.
- Users lose trust in the scoring signal when repeated improvements don't move the score.
- The 10/10 target is invisible — users don't know what "perfect" looks like per stage.

---

## Goals

| # | Goal |
|---|---|
| G1 | A document that meets all quality criteria for its lifecycle stage can receive a score of 10. |
| G2 | Suggestions are optional at score 10; an empty array is a valid response. |
| G3 | Each lifecycle stage has an explicit rubric so the AI applies consistent, stage-appropriate criteria. |
| G4 | The UI renders a distinct "perfect score" state that communicates achievement clearly. |
| G5 | Meeting note quality scoring follows the same rules. |

### Non-Goals

- Changing the 1–10 scale itself.
- Modifying the governance quality gate threshold (currently 7/10).
- Changing how scores are stored or transmitted (the `{ score, suggestions }` shape is unchanged).

---

## Scoring Rubric (Per Stage)

Each rubric defines what is required to earn a score in each band. Score 10 is awarded only when the document satisfies **all** criteria for its stage with no meaningful omissions.

### Conception Stage

| Score | Criteria |
|---|---|
| **10** | Problem is stated with precision and supported by evidence. Target user is named and validated. Proposed approach is differentiated. Scope boundaries are explicit. No ambiguity that a reader must resolve. |
| **8–9** | All required elements present; minor lack of specificity (e.g., market validation is asserted but not evidenced). |
| **6–7** | Most elements present; one required element is thin or missing (e.g., no target user identification). |
| **4–5** | Multiple elements missing or vague; reader must make significant assumptions. |
| **1–3** | Only a rough idea is present; no structured problem definition. |

### Definition Stage

| Score | Criteria |
|---|---|
| **10** | All requirements are complete and unambiguous. Every user story has acceptance criteria. Success metrics are measurable. Scope is bounded with explicit out-of-scope list. No open questions. |
| **8–9** | Requirements are complete; one or two acceptance criteria lack measurability. |
| **6–7** | Most requirements present; some user stories lack acceptance criteria or metrics are vague. |
| **4–5** | Key requirements missing; success is not defined. |
| **1–3** | Informal list of wishes; not structured as requirements. |

### Architecture Stage

| Score | Criteria |
|---|---|
| **10** | Every architecture decision traces to a requirement. Data model, API contracts, and component boundaries are fully specified. Security and scalability are addressed. Trade-offs are documented with rationale. No dangling dependencies. |
| **8–9** | Fully specified; one trade-off or dependency not documented. |
| **6–7** | Main components defined; gaps in API contracts or security considerations. |
| **4–5** | High-level architecture only; insufficient for implementation. |
| **1–3** | Diagrams or hand-wavy descriptions without actionable specification. |

### Implementation Stage

| Score | Criteria |
|---|---|
| **10** | An AI coding agent can act on this spec without clarification. File-by-file changes are listed, acceptance criteria are testable, edge cases are enumerated, tickets are granular, and a rollback plan exists. |
| **8–9** | Actionable; one area (e.g., edge cases) is thinner than ideal. |
| **6–7** | Most implementation steps present; missing rollback or incomplete acceptance criteria. |
| **4–5** | High-level plan; not specific enough for direct implementation. |
| **1–3** | Implementation notes; not a structured spec. |

### Execution Stage

| Score | Criteria |
|---|---|
| **10** | Documentation is current with the deployed codebase. All documented behaviour is accurate. Changelog is complete. Drift coverage is verified. Release is fully documented. |
| **8–9** | Mostly current; one minor undocumented change. |
| **6–7** | Core behaviour documented; some drift or incomplete changelog. |
| **4–5** | Documentation significantly lags the codebase. |
| **1–3** | Documentation does not reflect the current system. |

### Meeting Notes

| Score | Criteria |
|---|---|
| **10** | All decisions are stated with owners. Every action item has an assignee and deadline. Code references use resolvable file paths. Open questions are flagged. Summary is comprehensive. Speaker attribution is present throughout. |
| **8–9** | All required elements present; one item lacks an owner or deadline. |
| **6–7** | Most elements present; action items or attribution incomplete. |
| **4–5** | Decisions or action items are vague or missing owners. |
| **1–3** | Rough notes; not structured meeting documentation. |

---

## User Experience

### Score Display States

The `AIQualityPanel` and `AIAdvisor` score badge currently render three states based on thresholds:

| Current State | Score Range | Color |
|---|---|---|
| Good | 7–10 | Green |
| Needs improvement | 4–6 | Amber |
| Significant issues | 1–3 | Red |

With this feature, a fourth distinct state is added:

| New State | Score | Color / Treatment |
|---|---|---|
| **Perfect** | 10 | Gold / amber-400 with a star icon |

### Perfect Score UI

When `score === 10`:

1. **Score badge** (`AIAdvisor.tsx` → `ScoreBadge`): renders with a gold background and a `★` prefix: `★ Score: 10/10`.
2. **Quality panel** (`AIQualityPanel.tsx`): the score bar fills completely and renders in gold. The suggestions section is replaced with a "Perfect score — no improvements needed." message.
3. **Accent strip** on the advisor notification card uses `bg-amber-400` (already used for amber; we introduce `bg-yellow-400` for gold to distinguish from the "needs improvement" amber).

### Empty Suggestions

When the AI returns `score: 10` with `suggestions: []`, the frontend must handle this gracefully:

- `AIQualityPanel`: shows "This document meets all quality criteria for its stage." instead of an empty list.
- `AIAdvisor`: omits the suggestions section entirely rather than rendering an empty bullet list.

---

## API Contract

The `{ score: number; suggestions: string[] }` response shape is **unchanged**. The only difference is that `suggestions` may now be an empty array when `score === 10`.

```typescript
// Before (implicit contract — suggestions always non-empty)
{ score: 8, suggestions: ["Add acceptance criteria to user story 3"] }

// After (explicit contract — suggestions may be empty at score 10)
{ score: 10, suggestions: [] }
```

Callers that already guard with `suggestions.length > 0` before rendering are unaffected. Any caller that unconditionally maps over suggestions without a length check should be updated (see Implementation Plan).

---

## Acceptance Criteria

```gherkin
Scenario: Perfect spec receives a 10/10 score
  Given a spec document that satisfies all criteria in its rubric for the "definition" stage
  When the user clicks "Analyze Quality"
  Then the returned score is 10
  And the suggestions array is empty
  And the score badge renders as "★ Score: 10/10" with gold styling
  And the suggestions panel shows "This document meets all quality criteria for its stage."

Scenario: Near-perfect spec cannot reach 10 with a genuine gap
  Given a spec document that satisfies all definition criteria except measurable success metrics
  When the user clicks "Analyze Quality"
  Then the returned score is 8 or 9
  And at least one suggestion addresses the missing success metrics

Scenario: Meeting notes with all criteria met receive a 10/10
  Given meeting notes with all decisions owned, all action items assigned with deadlines,
        all code references resolvable, open questions flagged, and full speaker attribution
  When the meeting note quality analyzer runs
  Then the returned score is 10
  And the suggestions array is empty

Scenario: Legacy callers handle empty suggestions
  Given any component that renders the suggestions list
  When score is 10 and suggestions is []
  Then the component renders the "no improvements needed" message
  And does not render an empty unordered list
```

---

## Edge Cases

| Case | Handling |
|---|---|
| AI returns `score: 10` with non-empty suggestions | Accept the score; still render the suggestions (AI may flag optional enhancements). Badge shows gold but suggestions are shown. |
| AI returns `score: 11` or higher | Clamp to 10 in the parsing layer (already needed for robustness). |
| AI returns `score: 0` | Clamp to 1. |
| JSON parse failure at score 10 | The fallback regex already handles `X/10` format. No change needed. |
| Stage is null/undefined | No stage context injected; general rubric applies. |

---

## References

- `apps/api/src/services/ai.service.ts` — `analyzeSpecQuality` (line 115) and `analyzeMeetingNoteQuality` (line 822)
- `apps/web/src/components/AIAdvisor.tsx` — `ScoreBadge` component (line 54)
- `apps/web/src/components/AIQualityPanel.tsx` — Score display and suggestions list
- `apps/api/src/services/governance.service.ts` — Quality gate threshold (line 88)
- `docs/features/byok.md` — Reference for doc format conventions
