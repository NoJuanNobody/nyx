# Feature: Code-Implementation-Focused Ticket Generation

**Issue:** #247
**Status:** Planned
**Affected service:** `apps/api/src/services/ai.service.ts`

---

## Problem Statement

When Nyx generates tickets from spec-code drift or document change analysis, the AI frequently produces tickets that describe *documentation work* rather than *engineering work*. Examples of bad output:

- "Document the authentication flow"
- "Write spec for the search endpoint"
- "Update documentation to reflect new user model"

These tickets are not actionable for engineers. They describe Nyx's *own job* (keeping docs in sync with code), not the engineer's job (writing code that makes a spec real). The root cause is that the AI prompts treat documentation tasks as first-class citizens alongside code implementation tasks, and in several cases explicitly bias the model *toward* documentation.

### Affected Flows

| Flow | Entry Point | Root Cause |
|------|------------|------------|
| Bulk suggestion generation | `POST /api/documents/:id/bulk-suggest-tickets` | Prompt includes "documentation gap" as a standard category; `execution` stage focus explicitly says "documentation updates" |
| Diff-to-ticket generation | `POST /api/ai/generate-ticket` | System prompt has no bias toward code tasks; model defaults to describing what the spec says (often a doc update) |
| Change analysis / version-diff tickets | Called from suggestion service | Generic "change analyst" persona; no rule about code vs. doc tickets |
| Drift detection suggestions | `suggestions[]` field from `detectDrift()` | Suggestions are freeform strings — model will naturally suggest "update the spec" as often as "update the code" |

---

## Goals

1. AI-generated tickets should describe **concrete engineering work**: new endpoints, component changes, validation fixes, migration scripts, test coverage.
2. Documentation-only tickets (e.g., "Add a spec section for X") should **only be generated** when the gap is a genuinely missing document — not when code is missing or broken.
3. Ticket titles must be **action-oriented toward code**: "Implement...", "Add...", "Fix...", "Refactor...", "Migrate...".
4. The fix must be **backward-compatible** with all existing callers and return types — only prompt strings change.

## Non-Goals

- Completely eliminating documentation tickets. When a spec section is genuinely absent and there is no corresponding code to point to, a doc ticket is appropriate.
- Changing ticket data models, API routes, or database schema.
- Altering the drift detection scoring algorithm.

---

## User-Facing Impact

| Before | After |
|--------|-------|
| "Document the `/search` endpoint" | "Implement `GET /search` endpoint with pagination" |
| "Write spec for user onboarding" | "Add onboarding wizard component with step validation" |
| "Update documentation to reflect new auth model" | "Migrate auth middleware to use new JWT claims structure" |
| "Document drift between spec and code" | "Fix `UserProfile` component to render `displayName` field per spec" |

---

## Design

### Prompt Philosophy

The AI should reason about tickets the way a **tech lead triaging a backlog** does:

> "The spec says X should exist. Does the code already implement X? If not, create a ticket to *build* X. If the spec itself is unclear or missing, create a ticket to *clarify the spec*. Do not create a ticket telling someone to copy what the code already does into a doc."

This translates into three prompt rules added to every ticket-generating prompt:

1. **Code-first rule:** Tickets must describe code changes unless the spec section is *genuinely absent* (no heading, no requirements, no acceptance criteria exist anywhere in the document).
2. **Anti-doc-replication rule:** Never create a ticket whose sole purpose is to write a doc that describes what the code already does. That is Nyx's job, not a ticket.
3. **Action-verb rule:** Every ticket title must begin with an engineering verb: Implement, Add, Fix, Update, Refactor, Migrate, Remove, Integrate, or Test.

### Stage-Specific Behaviour

The `stage` field on a document drives the focus of bulk suggestion generation. The mapping needs updating:

| Stage | Current (broken) focus | Proposed focus |
|-------|----------------------|----------------|
| `conception` | Requirement gaps, missing user stories | Same — these are legitimately doc/spec gaps |
| `definition` | Same as above | Same |
| `architecture` | Code changes, API contracts, migration tasks | Same — already correct |
| `implementation` | Code changes | Same — already correct |
| `execution` | **"drift remediation and documentation updates"** | **Code fixes that bring the implementation into sync with the spec.** Doc tickets only when spec accuracy (not code accuracy) is in question. |

---

## Implementation Plan

### 1. Fix `generateBulkTicketSuggestions` system prompt

**File:** `apps/api/src/services/ai.service.ts`, lines 571–579

**Current prompt (problematic sections bolded):**
```
You are a ticket suggestion engine for a documentation platform. Given a document and optional code context, generate at least 50 actionable ticket suggestions. Be thorough and exhaustive — cover every feature, requirement, edge case, test scenario, integration point, **documentation gap**, performance concern, security consideration, accessibility issue, and **deployment task** you can identify.
...
labels: array of relevant labels (e.g., bug, enhancement, drift, spec-gap, testing, security, performance, accessibility, **documentation**)
```

**Changes:**
- Replace "documentation gap" with "missing implementation" in the coverage list
- Add the three prompt rules (code-first, anti-doc-replication, action-verb) as an explicit RULES block
- Change the label hint: move `documentation` to the end and add a condition — `documentation` label only when the spec section itself is missing
- Add a concrete example of a good vs. bad ticket title in the prompt

**Proposed system prompt (new text in `[brackets]`):**
```
You are a ticket suggestion engine for an engineering team. Given a spec document and optional code context, generate at least 50 actionable ticket suggestions. Be thorough — cover every feature, requirement, edge case, test scenario, integration point, [missing implementation], performance concern, security consideration, and accessibility issue you can identify. ${stageFocus}${stageContext}

RULES (follow strictly):
1. Every ticket must describe a CODE CHANGE — something an engineer implements, fixes, refactors, or tests.
2. NEVER create a ticket whose only purpose is to write or update documentation that describes what the code already does. Nyx handles documentation automatically.
3. Every title MUST start with an engineering verb: Implement, Add, Fix, Update, Refactor, Migrate, Remove, Integrate, or Test.
4. Only use the "documentation" label when a spec section is genuinely absent (no heading, requirements, or acceptance criteria exist) AND there is no corresponding code to reference. In all other cases, the ticket should describe code work.

BAD title: "Document the /users endpoint"
GOOD title: "Implement GET /users endpoint with role-based filtering"

BAD title: "Update spec to reflect new auth model"
GOOD title: "Migrate auth middleware to validate new JWT claims structure"

Each ticket must have:
- title: prefixed with [S], [M], or [L] for scope; starts with an engineering verb
- description: ## Context (spec reference), ## Affected Areas (file paths/modules), ## Acceptance Criteria (verifiable checklist of code behaviour)
- labels: array from: bug, enhancement, drift, spec-gap, testing, security, performance, accessibility, documentation (documentation only per rule 4)

Respond ONLY with a valid JSON array of objects with title, description, and labels fields.
```

### 2. Fix `execution` stage focus string

**File:** `apps/api/src/services/ai.service.ts`, line 557

**Current:**
```typescript
stageFocus = 'Focus on drift remediation and documentation updates.';
```

**Proposed:**
```typescript
stageFocus =
  'Focus on code fixes that bring the implementation into sync with the spec. ' +
  'For each drift item, create a ticket that describes the code change needed — not a doc update. ' +
  'Only create a documentation ticket if the spec section itself is inaccurate or missing entirely.';
```

### 3. Fix `generateTicketFromDiff` system prompt

**File:** `apps/api/src/services/ai.service.ts`, lines 219–220

**Current:**
```
You are a ticket generator. Given a diff between specification versions, generate a well-formatted ticket.
```

**Proposed:**
```
You are an engineering ticket generator. Given a diff between specification versions, generate a ticket that describes the CODE CHANGE needed to implement the new or updated requirement.

RULES:
1. The ticket must describe what an engineer builds, fixes, or refactors — not what a writer documents.
2. The title must start with an engineering verb: Implement, Add, Fix, Update, Refactor, Migrate, Remove, Integrate, or Test.
3. Only generate a documentation ticket if the diff shows a spec section being added that has no corresponding code concept at all.
```

### 4. Fix `analyzeChangesForTickets` system prompt

**File:** `apps/api/src/services/ai.service.ts`, lines 328–329

**Current:**
```
You are a change analyst for a documentation platform. Given a set of document version changes, analyze them and suggest ticket groupings. Group related changes into logical tickets.
```

**Proposed:**
```
You are an engineering backlog analyst. Given a set of spec document version changes, identify the CODE CHANGES needed to implement those requirements and group them into actionable tickets.

RULES:
1. Each suggested ticket must describe engineering work (implement, fix, refactor, test).
2. Titles must start with: Implement, Add, Fix, Update, Refactor, Migrate, Remove, Integrate, or Test.
3. Do not suggest tickets that only describe writing or updating documentation. Documentation is managed by Nyx automatically.
```

### 5. Fix `detectDrift` suggestions framing

**File:** `apps/api/src/services/ai.service.ts`, line 179

**Current:**
```
{"hasDrift": <boolean>, "driftScore": <number 0-10>, "details": "<description>", "suggestions": ["fix1", "fix2", ...]}
```

The `suggestions` field is open-ended, causing the model to suggest spec updates instead of code fixes.

**Proposed — add clarifying instruction:**
```
You are a code-spec drift detector. Compare the specification with the code and identify any mismatches.
The "suggestions" field must list CODE CHANGES needed to bring the implementation in line with the spec — not documentation updates.
Each suggestion should read like a brief engineering task: e.g., "Add input validation for the email field in UserService" not "Update spec to document email validation".
Respond ONLY with valid JSON in this exact format: {"hasDrift": <boolean>, "driftScore": <number 0-10>, "details": "<description>", "suggestions": ["fix1", "fix2", ...]}
```

---

## Testing Plan

### Unit / Integration Tests (Vitest)

For each of the 4 modified prompt-bearing functions, add a test case in `apps/api/src/services/__tests__/ai.service.test.ts` (or create it if absent) that:

1. **Mocks** the Anthropic client to return fixture JSON
2. **Asserts** that the system prompt string passed to the mock **does not contain** the strings: `"documentation gap"`, `"Update documentation"`, `"Write documentation"`, `"documentation updates"`
3. **Asserts** that the system prompt string **does contain** `"code"` or `"CODE CHANGE"` or `"engineering verb"`

These are prompt-content tests — they verify we don't regress back to the old wording.

### Manual QA Checklist

- [ ] Open a document at `execution` stage with known drift → bulk generate tickets → confirm none say "update documentation"
- [ ] Edit a spec section (change a requirement) → trigger `generateTicketFromDiff` via `POST /api/ai/generate-ticket` → confirm ticket title starts with an engineering verb
- [ ] Open a document at `conception` stage → bulk generate → confirm doc-only tickets appear only for genuinely missing sections, not for every gap
- [ ] Trigger webhook push on a repo with drift → check drift `suggestions[]` in timeline event → confirm suggestions describe code fixes not spec edits

### E2E Test (Playwright)

Add a test in `e2e/ticket-generation.spec.ts` that:
1. Signs in as the test user
2. Opens a seeded document with known content
3. Triggers bulk ticket generation
4. Asserts that at least 80% of generated ticket titles begin with one of the expected engineering verbs

---

## Rollout Notes

- No migration required — prompt changes take effect immediately on the next API call
- Existing pending `ticketSuggestions` rows in the database are unaffected
- BYOK teams will see the updated behaviour on their next suggestion generation call
- The change is fully reversible by reverting the prompt strings

---

## Open Questions

1. **Should we add a server-side filter** that rejects any generated ticket title not starting with a known engineering verb, falling back to a retry? This adds latency but provides a hard guarantee. Recommended as a follow-up (not in this PR).
2. **Should `conception` and `definition` stages be allowed doc-only tickets more freely?** Those stages are legitimately about shaping requirements, so some spec-gap tickets make sense. Current plan preserves this — the stricter rules only block "write a doc about code that already exists".
3. **Telemetry:** Should we log a `ticket_type` dimension (code vs. documentation) on suggestion generation events to measure improvement? Useful post-launch signal.
