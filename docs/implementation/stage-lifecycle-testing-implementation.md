# Stage Lifecycle Testing — Implementation Execution Plan

This document provides a sequenced, task-level plan for building the stage lifecycle testing system defined in [`docs/features/stage-lifecycle-testing.md`](../features/stage-lifecycle-testing.md). Each phase produces a shippable increment. Phases 0–3 constitute the MVP; Phases 4–5 add the AI rules and admin UI.

---

## Phase 0: Prerequisites & Migration Prep

Before writing any test-suite code, verify these are in place and create a migration strategy for the existing gatekeeper.

**Checklist:**
- [ ] Confirm `lifecycles` and `lifecycle_stages` tables exist and are seeded (`apps/api/src/db/seed-lifecycles.ts`)
- [ ] Confirm `gatekeeper.service.ts` tests all pass (`pnpm --filter api test`)
- [ ] Add a feature flag `STAGE_TESTING_ENABLED=false` to `apps/api/src/config.ts` so the new system can be deployed dark and enabled per environment

```ts
// apps/api/src/config.ts  (add to existing config object)
stageTestingEnabled: env.STAGE_TESTING_ENABLED === 'true',
```

- [ ] Document the migration plan: when `STAGE_TESTING_ENABLED=true`, the gatekeeper delegates to the test suite runner instead of its static checks. The two legacy checks (`legacy_not_empty`, `legacy_min_length`) are seeded as required rules in every default suite so behaviour is preserved.

---

## Phase 1: Database Schema

**Goal:** Add four tables — `test_suites`, `test_rules`, `test_runs`, `test_run_results` — and expose them via Drizzle.

### 1.1 Write Drizzle Schema

File: `apps/api/src/db/schema.ts` (add alongside existing tables)

```ts
export const testSuites = pgTable('test_suites', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  lifecycleId: uuid('lifecycle_id').notNull().references(() => lifecycles.id, { onDelete: 'cascade' }),
  fromStage: text('from_stage').notNull(),
  toStage: text('to_stage').notNull(),
  label: text('label').notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('test_suites_team_lifecycle_transition_idx').on(t.teamId, t.lifecycleId, t.fromStage, t.toStage),
]);

export const testRules = pgTable('test_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  suiteId: uuid('suite_id').notNull().references(() => testSuites.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),          // 'min_word_count' | 'required_section' | etc.
  label: text('label').notNull(),
  severity: text('severity').notNull().default('required'),  // 'required' | 'advisory'
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  isEnabled: boolean('is_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const testRuns = pgTable('test_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  suiteId: uuid('suite_id').references(() => testSuites.id, { onDelete: 'set null' }),
  suiteSnapshot: jsonb('suite_snapshot').$type<unknown>().notNull(),  // frozen copy of suite+rules at run time
  contentHash: text('content_hash').notNull(),   // SHA-256 of document content at time of run
  triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  triggerType: text('trigger_type').notNull().default('stage_advance'),  // 'stage_advance' | 'manual'
  passed: boolean('passed').notNull(),
  hasWarnings: boolean('has_warnings').notNull().default(false),
  fromStage: text('from_stage').notNull(),
  toStage: text('to_stage').notNull(),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const testRunResults = pgTable('test_run_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id').references(() => testRules.id, { onDelete: 'set null' }),
  ruleType: text('rule_type').notNull(),
  severity: text('severity').notNull(),
  passed: boolean('passed').notNull(),
  message: text('message').notNull().default(''),
  details: jsonb('details').$type<unknown>(),
  durationMs: integer('duration_ms'),
  sortOrder: integer('sort_order').notNull().default(0),
});
```

### 1.2 Push Schema to DB

```bash
pnpm --filter api db:push
```

### 1.3 Export New Types

Add Drizzle `InferSelectModel` / `InferInsertModel` types for all four tables at the bottom of `schema.ts`, following the existing pattern.

---

## Phase 2: Test Rule Engine

**Goal:** A pure, side-effect-free service that executes a list of rules against a document content string.

### 2.1 Create Rule Executor Interface

File: `apps/api/src/services/test-rules/types.ts`

```ts
export interface RuleContext {
  content: string;
  title: string;
  metadata: Record<string, unknown>;
}

export interface RuleResult {
  passed: boolean;
  message: string;
  details?: unknown;
  durationMs: number;
}

export type RuleExecutor = (config: Record<string, unknown>, ctx: RuleContext) => Promise<RuleResult>;
```

### 2.2 Implement Built-in Rule Executors

Create one file per logical group under `apps/api/src/services/test-rules/`:

**`content-structure.ts`** — implements:
- `min_word_count`: split on whitespace, compare length to `config.min`
- `max_word_count`: compare to `config.max`
- `min_section_count`: count `#`, `##`, `###` headings, filtered by `config.level`
- `required_section`: case-insensitive search for heading matching `config.heading`
- `no_placeholder_text`: regex scan for TODO/TBD/FIXME/`[insert`/`…` + custom `config.patterns`
- `no_empty_sections`: parse heading structure, verify each heading has following content

**`metadata.ts`** — implements:
- `required_field`: check `ctx.metadata[config.field]` is present and non-empty
- `title_length`: check `ctx.title.length` is within `config.min`/`config.max`
- `has_owner`: check `ctx.metadata.ownerId` is set

**`links.ts`** — implements:
- `no_broken_markdown_links`: extract `[text](url)` with regex; for internal `/...` paths check document list; for external URLs optionally HEAD-request
- `internal_links_valid`: extract `[[...]]` references, verify against document slug list

**`legacy.ts`** — implements:
- `legacy_not_empty`: `ctx.content.trim().length > 0`
- `legacy_min_length`: `ctx.content.length >= 100`

**`ai-quality.ts`** — implements (stubs in Phase 2, wired in Phase 4):
- `ai_readability`, `ai_completeness`, `ai_consistency`, `ai_acceptance_criteria`
- All return `{ passed: true, message: 'AI rules require Claude API — skipped' }` until Phase 4

### 2.3 Create Rule Registry

File: `apps/api/src/services/test-rules/registry.ts`

```ts
import type { RuleExecutor } from './types';
import * as contentStructure from './content-structure';
import * as metadata from './metadata';
import * as links from './links';
import * as legacy from './legacy';
import * as aiQuality from './ai-quality';

const REGISTRY: Record<string, RuleExecutor> = {
  min_word_count: contentStructure.minWordCount,
  max_word_count: contentStructure.maxWordCount,
  min_section_count: contentStructure.minSectionCount,
  required_section: contentStructure.requiredSection,
  no_placeholder_text: contentStructure.noPlaceholderText,
  no_empty_sections: contentStructure.noEmptySections,

  required_field: metadata.requiredField,
  title_length: metadata.titleLength,
  has_owner: metadata.hasOwner,

  no_broken_markdown_links: links.noBrokenMarkdownLinks,
  internal_links_valid: links.internalLinksValid,

  legacy_not_empty: legacy.notEmpty,
  legacy_min_length: legacy.minLength,

  ai_readability: aiQuality.readability,
  ai_completeness: aiQuality.completeness,
  ai_consistency: aiQuality.consistency,
  ai_acceptance_criteria: aiQuality.acceptanceCriteria,
};

export function getExecutor(type: string): RuleExecutor {
  const executor = REGISTRY[type];
  if (!executor) throw new Error(`Unknown test rule type: ${type}`);
  return executor;
}

export function listRuleTypes(): string[] {
  return Object.keys(REGISTRY);
}
```

### 2.4 Write Unit Tests for Every Rule Executor

File: `apps/api/src/services/__tests__/test-rules/`

For each rule type, write at minimum:
- A passing case with minimal valid content
- A failing case with content that violates the rule
- An edge case (empty string, unicode, very long content)

Tests are pure — no DB or network required. Target: 90% line coverage on the rule files.

---

## Phase 3: Test Suite Runner & Gatekeeper Integration

**Goal:** A service that loads a suite from the DB, runs all rules, persists the result, and an updated gatekeeper that delegates to it.

### 3.1 Create Test Suite Runner Service

File: `apps/api/src/services/test-suite-runner.service.ts`

```ts
export interface RunSuiteOptions {
  documentId: string;
  content: string;
  title: string;
  metadata: Record<string, unknown>;
  fromStage: string;
  toStage: string;
  triggeredBy: string | null;
  triggerType: 'stage_advance' | 'manual';
  db: Database;
}

export interface SuiteRunOutcome {
  passed: boolean;
  hasWarnings: boolean;
  testRunId: string;
  results: Array<{
    ruleType: string;
    severity: string;
    passed: boolean;
    message: string;
    details?: unknown;
  }>;
}

export const testSuiteRunnerService = {
  async run(opts: RunSuiteOptions): Promise<SuiteRunOutcome> {
    // 1. Load suite + rules for (lifecycleId, fromStage, toStage) from DB
    // 2. If no suite found, fall back to legacy checks
    // 3. Snapshot suite config
    // 4. Hash content (SHA-256)
    // 5. Execute each enabled rule via getExecutor()
    // 6. Collect results
    // 7. Compute passed = all required rules passed
    // 8. Compute hasWarnings = any advisory rules failed
    // 9. Persist testRuns + testRunResults rows in a transaction
    // 10. Return SuiteRunOutcome
  },
};
```

### 3.2 Update Gatekeeper Service

File: `apps/api/src/services/gatekeeper.service.ts`

Extend `evaluateGate` to accept an optional `testSuiteRunner` dependency and `db` parameter. When `config.stageTestingEnabled` is true and a suite exists, delegate to the runner. When disabled or no suite found, fall back to static checks.

```ts
export const gatekeeperService = {
  async evaluateGate(
    document: { id: string; content: string; stage: string | null; title: string },
    targetStage: string,
    options: {
      stageOrder?: string[];
      db?: Database;
      triggeredBy?: string | null;
      testSuiteRunner?: typeof testSuiteRunnerService;
    } = {}
  ): Promise<GateResult & { testRunId?: string }> {
    // ... existing sequential check logic ...
    // then if stageTestingEnabled:
    //   const outcome = await options.testSuiteRunner.run(...)
    //   map outcome to GateResult checks
  },
};
```

### 3.3 Update Document PATCH Route

File: `apps/api/src/routes/documents.ts`

When stage is changing, pass `db` and `triggeredBy` into `evaluateGate`. Include `testRunId` in the 422 error body and in the 200 success body.

```ts
// In PATCH handler, where stage transition is evaluated:
const gateResult = await gatekeeperService.evaluateGate(doc, body.stage, {
  db,
  triggeredBy: request.user.id,
  testSuiteRunner: testSuiteRunnerService,
});
if (!gateResult.passed) {
  return reply.status(422).send({
    error: 'Stage transition blocked',
    testRunId: gateResult.testRunId,
    checks: gateResult.checks,
  });
}
```

Also record a `test_run.passed` or `test_run.failed` timeline event.

### 3.4 Seed Default Test Suites

File: `apps/api/src/db/seed-test-suites.ts`

```ts
// Called from seed.ts or a new migration fixture.
// Creates one TestSuite row per transition in software_development lifecycle,
// then inserts the default TestRule rows per the table in the feature doc.
// Guard with: if (await db.select().from(testSuites).limit(1)) → skip
```

Call this from `apps/api/src/db/seed.ts` after lifecycles are seeded.

### 3.5 Write Integration Tests

File: `apps/api/src/__tests__/integration/stage-lifecycle-testing.test.ts`

Cover:
- Document advances when all required rules pass
- Document blocked when required rule fails; correct `testRunId` returned in 422
- Advisory failure does not block transition, `hasWarnings=true` on the testRun
- Test run is persisted with correct content hash and rule results
- Fall-through to legacy checks when no suite is configured

---

## Phase 4: REST API Endpoints

**Goal:** CRUD for test suites and rules; test run history endpoints.

### 4.1 Create Routes File

File: `apps/api/src/routes/test-suites.ts`

Implement the endpoints defined in the feature doc §7, using Fastify + Zod schemas for request/response validation.

```
GET    /api/test-suites
POST   /api/test-suites
PATCH  /api/test-suites/:id
DELETE /api/test-suites/:id
POST   /api/test-suites/:id/rules
PATCH  /api/test-suites/:id/rules/:ruleId
DELETE /api/test-suites/:id/rules/:ruleId
PUT    /api/test-suites/:id/rules/order
POST   /api/test-suites/:id/run
GET    /api/documents/:id/test-runs
GET    /api/test-runs/:id
GET    /api/test-rule-types
```

All mutation routes require `admin` role (use `requireRole('admin')` middleware). Read routes require `viewer`.

### 4.2 Register Routes

File: `apps/api/src/app.ts`

```ts
import testSuitesRoutes from './routes/test-suites';
app.register(testSuitesRoutes, { prefix: '/api' });
```

### 4.3 Write Route Tests

File: `apps/api/src/__tests__/routes/test-suites.test.ts`

Standard pattern using `buildTestApp()` + `injectAs()`. Cover:
- Non-admin cannot mutate suites (403)
- Creating a suite with invalid config is rejected (400)
- Manual run endpoint returns full result with per-rule breakdown
- Test run history is paginated and ordered by `createdAt` desc

---

## Phase 5: AI Rule Implementation

**Goal:** Wire the Claude API into the four `ai_*` rule types.

### 5.1 Create AI Rule Client

File: `apps/api/src/services/test-rules/ai-quality.ts` (replace stubs)

Use `@anthropic-ai/sdk` (already in the project as the drift/quality AI client). Each rule:
1. Builds a focused prompt for the specific check
2. Calls `anthropic.messages.create` with `claude-sonnet-4-6`
3. Parses the structured response (JSON schema output with `passed`, `score`, `feedback`)
4. Returns `RuleResult`

**Rate limiting:** Wrap calls in a shared `aiRateLimiter` (token bucket) to prevent runaway costs when many documents advance simultaneously.

**Cost guard:** AI rules are skipped (with advisory warning) if `ANTHROPIC_API_KEY` is not set or if the team has exhausted their monthly AI credit allocation.

### 5.2 Update Config

```ts
// apps/api/src/config.ts
aiRulesEnabled: env.ANTHROPIC_API_KEY !== undefined && env.AI_RULES_ENABLED !== 'false',
```

### 5.3 Write AI Rule Tests

Use `vi.mock('@anthropic-ai/sdk')` to stub the API. Cover:
- Passing and failing responses parsed correctly
- Missing API key causes graceful skip, not error
- Malformed API response does not crash the runner

---

## Phase 6: Frontend

**Goal:** Stage transition dialog, document health badge, timeline entries, and admin settings UI.

### 6.1 API Client Methods

File: `apps/web/src/lib/api.ts`

```ts
export async function getTestRuns(documentId: string): Promise<TestRun[]> { ... }
export async function getTestRun(runId: string): Promise<TestRunWithResults> { ... }
export async function runTestSuite(suiteId: string, documentId: string): Promise<SuiteRunOutcome> { ... }
export async function getTestSuites(lifecycleId: string): Promise<TestSuite[]> { ... }
```

### 6.2 Stage Transition Dialog

File: `apps/web/src/components/StageTransitionDialog.tsx`

Replace the current single-step confirmation (or lack thereof) in `FileTree.tsx` with a modal that:
1. Fires `PATCH /api/documents/:id { stage: newStage }`
2. Shows a spinner while the request is in-flight
3. On 422: displays the test run results with per-rule pass/fail indicators (required rules in red, advisory in yellow), and a **Fix issues** close action
4. On 200 with `hasWarnings`: shows the warnings and a **Proceed anyway** action that was already approved by the backend

Selectors (add to `e2e/fixtures/selectors.ts`):
```ts
stageTransitionDialog: '[data-testid="stage-transition-dialog"]',
stageTransitionRunning: '[data-testid="stage-transition-running"]',
stageTransitionResult: '[data-testid="stage-transition-result"]',
testRuleRow: '[data-testid="test-rule-row"]',
testRuleStatus: '[data-testid="test-rule-status"]',
```

### 6.3 Document Health Badge

File: `apps/web/src/components/DocumentHealthBadge.tsx`

A small badge (16×16) that reads the latest test run status from `GET /api/documents/:id/test-runs?limit=1`. Used in:
- `FileTree.tsx` document node
- Dashboard recent-documents list

### 6.4 Timeline Event Rendering

File: `apps/web/src/components/TimelineEvent.tsx` (or wherever timeline events are rendered)

Add rendering for `test_run.passed`, `test_run.failed`, `test_run.warning` event types. Include a link to the full test run report.

### 6.5 Admin Settings — Testing Tab

File: `apps/web/src/pages/settings/LifecycleTestingSettings.tsx`

A new tab under Settings > Lifecycle that renders the test suite configuration. Features:
- Lifecycle stage transition selector (from/to pair)
- Ordered list of rules with drag-to-reorder
- Rule editor: type picker (dropdown from `/api/test-rule-types`), severity toggle, config fields rendered dynamically from rule type schema
- Save and discard changes buttons

---

## Phase 7: E2E Tests

File: `e2e/stage-lifecycle-testing.spec.ts`

Cover the full user-facing flows:

```
✓ Stage advance blocked when required rule fails — dialog shows error per rule
✓ Stage advance succeeds when all required rules pass
✓ Advisory warning shown but does not block advance
✓ Document health badge shows red after failed run
✓ Document health badge shows green after passed run
✓ Timeline shows test_run.passed entry with link to run report
✓ Admin can add a required_section rule via settings UI
✓ Non-admin cannot access testing settings tab
✓ Manual dry-run from settings returns result without advancing stage
```

Use the `authenticatedPage` fixture. Seed a test suite with at least one required rule in `e2e/global-setup.ts` (call `pnpm --filter api db:seed` which now includes `seed-test-suites.ts`).

---

## Delivery Order Summary

| Phase | Deliverable | Dependencies |
|-------|-------------|--------------|
| 0 | Feature flag, migration plan | — |
| 1 | DB schema (4 tables) | Phase 0 |
| 2 | Rule engine + unit tests | Phase 1 |
| 3 | Suite runner, gatekeeper update, default seed, integration tests | Phase 2 |
| 4 | REST API endpoints + route tests | Phase 3 |
| 5 | AI rule implementation | Phase 4 |
| 6 | Frontend (dialog, badge, timeline, settings) | Phase 4 |
| 7 | E2E tests | Phase 6 |

Phases 0–4 (backend with no AI) are safe to ship behind the feature flag. Enable `STAGE_TESTING_ENABLED=true` in staging once Phase 3 integration tests pass. Enable in production after Phase 7 E2E suite is green in CI.

---

## File Checklist

New files to create:

```
apps/api/src/db/schema.ts                                          ← extend (Phase 1)
apps/api/src/db/seed-test-suites.ts                               ← new   (Phase 3)
apps/api/src/services/test-rules/types.ts                         ← new   (Phase 2)
apps/api/src/services/test-rules/registry.ts                      ← new   (Phase 2)
apps/api/src/services/test-rules/content-structure.ts             ← new   (Phase 2)
apps/api/src/services/test-rules/metadata.ts                      ← new   (Phase 2)
apps/api/src/services/test-rules/links.ts                         ← new   (Phase 2)
apps/api/src/services/test-rules/legacy.ts                        ← new   (Phase 2)
apps/api/src/services/test-rules/ai-quality.ts                    ← new   (Phase 2/5)
apps/api/src/services/test-suite-runner.service.ts                ← new   (Phase 3)
apps/api/src/services/__tests__/test-rules/content-structure.test.ts ← new (Phase 2)
apps/api/src/services/__tests__/test-rules/metadata.test.ts       ← new   (Phase 2)
apps/api/src/services/__tests__/test-rules/links.test.ts          ← new   (Phase 2)
apps/api/src/services/__tests__/test-rules/legacy.test.ts         ← new   (Phase 2)
apps/api/src/services/__tests__/test-rules/ai-quality.test.ts     ← new   (Phase 5)
apps/api/src/__tests__/integration/stage-lifecycle-testing.test.ts ← new  (Phase 3)
apps/api/src/routes/test-suites.ts                                ← new   (Phase 4)
apps/api/src/__tests__/routes/test-suites.test.ts                 ← new   (Phase 4)
apps/web/src/components/StageTransitionDialog.tsx                 ← new   (Phase 6)
apps/web/src/components/DocumentHealthBadge.tsx                   ← new   (Phase 6)
apps/web/src/pages/settings/LifecycleTestingSettings.tsx          ← new   (Phase 6)
e2e/stage-lifecycle-testing.spec.ts                               ← new   (Phase 7)
```

Files to modify:

```
apps/api/src/config.ts                                ← feature flag (Phase 0)
apps/api/src/services/gatekeeper.service.ts           ← extend (Phase 3)
apps/api/src/routes/documents.ts                      ← pass db/triggeredBy (Phase 3)
apps/api/src/db/seed.ts                               ← call seed-test-suites (Phase 3)
apps/api/src/app.ts                                   ← register routes (Phase 4)
apps/web/src/lib/api.ts                               ← new client methods (Phase 6)
apps/web/src/components/FileTree.tsx                  ← use StageTransitionDialog (Phase 6)
e2e/fixtures/selectors.ts                             ← add new selectors (Phase 6)
```
