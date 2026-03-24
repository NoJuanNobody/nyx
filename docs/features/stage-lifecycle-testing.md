# Stage Lifecycle Testing

Nyx integrates a first-class testing system into the stage lifecycle so that documentation quality is verified automatically at every transition. Tests are configured per-stage, run whenever a document attempts to advance, and their results gate forward movement — replacing ad-hoc manual checks with a structured, auditable quality pipeline.

---

## 1. Problem Statement

Today, the gatekeeper service applies three static checks before a document can advance to the next stage: content must be non-empty, it must exceed 100 characters, and the target stage must be the immediate next one in sequence. These checks are hard-coded and identical for every lifecycle and every team.

This leaves several gaps:

- Teams cannot define quality criteria that match their own standards (e.g. "all sections must be filled", "must include an acceptance-criteria block").
- There is no traceability: if a document is rejected, there is no record of which checks failed or when.
- Testing concerns live entirely outside the lifecycle — if a team runs AI quality checks or doc-lint tools today, those happen outside Nyx.
- There is no way to make some checks advisory (warnings) vs. blocking (errors).

---

## 2. Goals

| # | Goal |
|---|------|
| G1 | Teams can define a **test suite** for each stage transition in their active lifecycle. |
| G2 | Test suites run automatically when a document is submitted for stage advancement. |
| G3 | Failing **required** tests block the transition; failing **advisory** tests produce warnings but allow advancement. |
| G4 | Every test run is persisted and visible in the document's audit trail. |
| G5 | The system ships with a library of built-in test types covering common documentation quality needs. |
| G6 | Custom test rules can be added by workspace admins without writing code. |
| G7 | The existing static gatekeeper checks are migrated into the test suite framework so all validation is unified. |

### Non-goals

- Running tests against external codebases (that is drift detection — a separate system).
- Executing arbitrary code (tests are rule-based, not scripted).
- Replacing CI pipelines for software builds.

---

## 3. Core Concepts

### 3.1 Stage Test Suite

A **StageTestSuite** is a named, ordered list of test rules that applies to a specific `(lifecycle, fromStage, toStage)` triple. It answers the question: "What must be true about a document before it can move from stage A to stage B?"

A suite is attached to a lifecycle stage pair, not to an individual document. All documents in a team that share the same lifecycle inherit the suite unless overridden at the document level (advanced usage, Phase 2).

### 3.2 Test Rule

A **TestRule** is a single executable check. It has a **type** (which determines its logic), a **severity** (`required` | `advisory`), and optional configuration parameters.

```
TestRule {
  id
  type: TestRuleType       // e.g. 'min_word_count'
  severity: 'required' | 'advisory'
  label: string            // human-readable name shown in UI
  config: Record<string, unknown>   // type-specific parameters
  sortOrder: number
}
```

### 3.3 Test Run

A **TestRun** is an immutable record of one execution of a suite against a specific document version. It captures:

- Which suite was run
- The document ID and content snapshot hash at time of execution
- Per-rule results (pass / fail / warning, message, duration)
- Whether the overall run passed (all required rules passed)
- Who triggered it and when

### 3.4 Severity Levels

| Severity | Behavior |
|----------|----------|
| `required` | Document **cannot** advance if this rule fails. |
| `advisory` | Document **can** advance; a warning is shown and the run is flagged. |

---

## 4. Built-in Test Rule Types

The following rule types ship out of the box. All are configurable via `config`.

### 4.1 Content Structure

| Type | Description | Config |
|------|-------------|--------|
| `min_word_count` | Document body must contain at least N words | `{ min: number }` |
| `max_word_count` | Document body must not exceed N words | `{ max: number }` |
| `min_section_count` | Document must have at least N markdown headings (H1–H3) | `{ min: number, level?: 1\|2\|3 }` |
| `required_section` | A heading with the given text (case-insensitive) must exist | `{ heading: string }` |
| `no_placeholder_text` | Document must not contain common placeholder strings (`TODO`, `TBD`, `FIXME`, `[insert`, `…`) | `{ patterns?: string[] }` |
| `no_empty_sections` | Every heading must be followed by at least one paragraph before the next heading | — |

### 4.2 Metadata & Compliance

| Type | Description | Config |
|------|-------------|--------|
| `required_field` | A frontmatter or metadata field must be present and non-empty | `{ field: string }` |
| `title_length` | Document title must be within a character range | `{ min?: number, max?: number }` |
| `has_owner` | Document must have an assigned owner (from the team members list) | — |

### 4.3 Link & Reference Quality

| Type | Description | Config |
|------|-------------|--------|
| `no_broken_markdown_links` | All `[text](url)` links must resolve (internal) or have reachable host (external) | `{ checkExternal?: boolean }` |
| `internal_links_valid` | All `[[wiki-style]]` links must reference existing documents in the workspace | — |

### 4.4 AI-Assisted Quality (requires Claude API)

| Type | Description | Config |
|------|-------------|--------|
| `ai_readability` | Claude scores the document for clarity and flags confusing sections | `{ minScore?: number (0–100) }` |
| `ai_completeness` | Claude evaluates whether the document covers the topics expected for its stage | `{ lifecycle: string, stage: string }` |
| `ai_consistency` | Claude checks that terminology is used consistently throughout | — |
| `ai_acceptance_criteria` | For implementation-stage docs, Claude verifies acceptance criteria are specific and testable | — |

### 4.5 Legacy / Migration

| Type | Description |
|------|-------------|
| `legacy_not_empty` | Migrated form of the old "content not empty" gatekeeper check |
| `legacy_min_length` | Migrated form of the old "100 character minimum" gatekeeper check |

---

## 5. Default Test Suites (software_development lifecycle)

When a team activates the `software_development` lifecycle, these suites are seeded automatically.

| Transition | Required Rules | Advisory Rules |
|-----------|---------------|----------------|
| conception → definition | `no_placeholder_text`, `min_word_count (50)` | `ai_readability` |
| definition → architecture | `required_section (Acceptance Criteria)`, `min_word_count (150)`, `no_placeholder_text` | `ai_completeness`, `ai_acceptance_criteria` |
| architecture → implementation | `min_section_count (3)`, `required_section (Data Model)` OR `required_section (API Design)`, `no_empty_sections` | `ai_consistency` |
| implementation → execution | `no_placeholder_text`, `min_word_count (200)`, `has_owner` | `ai_readability`, `ai_completeness` |

---

## 6. Gatekeeper Integration

The existing `gatekeeperService.evaluateGate()` function is extended to execute the team's active test suite for the transition **in addition to** (or replacing, via migration flag) its static checks.

**Flow when a document is submitted for stage advancement:**

```
PATCH /api/documents/:id  { stage: 'definition' }
  │
  ├─ Load document + team's active lifecycle
  ├─ Load test suite for (lifecycle, fromStage, toStage)
  ├─ Execute each test rule in order
  │   ├─ Record result per rule
  │   └─ Short-circuit on first required failure (configurable)
  ├─ Persist TestRun record (always, pass or fail)
  ├─ If any required rule failed → 422 with test run ID and results
  └─ If all required rules passed → advance stage, emit timeline event
```

The `PATCH` response always includes the `testRunId` so the client can display results inline.

---

## 7. API Surface

### 7.1 Test Suite Management

```
GET    /api/test-suites?lifecycleId=X&fromStage=Y&toStage=Z
POST   /api/test-suites
PATCH  /api/test-suites/:id
DELETE /api/test-suites/:id

POST   /api/test-suites/:id/rules
PATCH  /api/test-suites/:id/rules/:ruleId
DELETE /api/test-suites/:id/rules/:ruleId
PUT    /api/test-suites/:id/rules/order          # reorder rules
```

### 7.2 Test Execution

```
POST   /api/test-suites/:id/run?documentId=X     # manual / dry-run trigger
GET    /api/documents/:id/test-runs              # history for a document
GET    /api/test-runs/:id                        # single run with per-rule results
```

### 7.3 Test Rule Type Library

```
GET    /api/test-rule-types                      # built-in rule type catalog with schemas
```

---

## 8. UI

### 8.1 Stage Transition Dialog

When a user clicks **Advance Stage**, the existing stage-transition action is replaced by a two-step dialog:

1. **Running tests** — animated checklist of rules with pass/fail indicators in real time (streamed via SSE or polled).
2. **Results** — summary with per-rule status. Required failures are highlighted in red; advisory warnings in yellow. A **Proceed anyway** option is shown only when no required rules failed.

### 8.2 Document Timeline

Test runs appear as timeline events:

- `test_run.passed` — all required rules passed, stage advanced
- `test_run.failed` — one or more required rules failed, stage not advanced
- `test_run.warning` — all required passed but advisory warnings exist, stage advanced with flag

Each timeline entry links to the full test run report.

### 8.3 Test Suite Configuration (Admin)

A new **Testing** tab in workspace Settings > Lifecycle lets admins:

- View the active test suites per stage transition
- Add, edit, reorder, and delete rules
- Toggle severity between required/advisory
- Enable/disable AI-assisted rules (requires Claude API key configured)
- Preview what rules a document would run against before saving

### 8.4 Document Health Indicator

A small badge on each document card (in the file tree and dashboard) shows:

- Green check — last test run passed
- Yellow warning — last run passed with advisory warnings
- Red X — last run failed (stage transition blocked)
- Grey — no test run recorded yet

---

## 9. Permissions

| Action | Minimum Role |
|--------|-------------|
| View test run results | viewer |
| Run tests manually (dry run) | editor |
| Trigger stage advance (which runs tests) | editor |
| Configure test suites and rules | admin |
| Enable AI test rules | admin |

---

## 10. Audit & Observability

- Every test run is persisted with full input hash, rule configs (snapshotted at run time), and per-rule output.
- Test run records are immutable after creation.
- Audit service emits `test_run.created` events.
- Test run results are included in document export (Markdown and PDF) as an appendix.

---

## 11. Future Considerations (out of scope for v1)

- **Per-document rule overrides** — allow a document owner to disable a specific advisory rule.
- **Scheduled re-runs** — re-run the current-stage test suite on a cron to catch regressions in long-lived documents.
- **External test hooks** — call a user-defined webhook as a test rule type (e.g. invoke a linter or CI check).
- **Test suite versioning** — snapshot suite config at the time of each run so historical results remain interpretable after config changes.
- **Cross-document consistency rules** — check that terminology in one document matches its companion documents.
