# Implementation Plan: Historical Context Matching (Issue #90)

## Overview

This plan breaks the implementation of historical context matching into sequential phases. Each phase is independently shippable and testable. The feature depends on Chaos Ingestion (#87) for the full ingestion flow, but the embedding infrastructure and document-to-document matching can be built and validated first.

**Build order in the sequence:** 4th (after Chaos Ingestion)
**Estimated complexity:** Medium-high (new infrastructure, but builds on existing patterns)

---

## Prerequisites

Before starting:

- [ ] Chaos Ingestion (#87) merged and deployed
- [ ] pgvector extension available on the Postgres instance
- [ ] OpenAI API key added to `.env` and Railway/Render environment

---

## Phase 1 — Embedding Infrastructure

**Goal:** Stand up the vector storage layer and a reusable embedding service. No user-visible changes yet.

### 1.1 Add pgvector dependency

```bash
pnpm --filter @syncdocs/api add openai
```

> Note: `text-embedding-3-small` is accessed via the OpenAI SDK, not Anthropic. This is a second AI SDK dependency.

### 1.2 Write the DB migration

Create `apps/api/drizzle/0011_historical_context.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chaos_inputs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by_id UUID REFERENCES users(id),
  content     TEXT NOT NULL,
  source_type TEXT,
  source_label TEXT,
  processed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_embeddings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  source_type  TEXT NOT NULL,  -- 'document_version' | 'chaos_input'
  source_id    UUID NOT NULL,
  embedding    vector(1536) NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

CREATE INDEX ON document_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX ON document_embeddings (team_id);
CREATE INDEX ON chaos_inputs (team_id);
```

### 1.3 Add Drizzle schema definitions

In `apps/api/src/db/schema.ts`, add:

```typescript
import { vector } from 'drizzle-orm/pg-core'; // requires drizzle-orm >= 0.31

export const chaosInputs = pgTable('chaos_inputs', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  createdById: uuid('created_by_id').references(() => users.id),
  content: text('content').notNull(),
  sourceType: text('source_type'),
  sourceLabel: text('source_label'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentEmbeddings = pgTable('document_embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(), // 'document_version' | 'chaos_input'
  sourceId: uuid('source_id').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  contentHash: text('content_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqSource: unique().on(t.sourceType, t.sourceId),
}));
```

> Check `drizzle-orm` version; `vector` type support was added in 0.31.0. If not available, use `customType` to define the column.

### 1.4 Create `embedding.service.ts`

`apps/api/src/services/embedding.service.ts`:

Responsibilities:
- `embedText(text: string): Promise<number[]>` — calls OpenAI `text-embedding-3-small`
- `hashContent(text: string): string` — SHA-256 hash to detect unchanged content
- `upsertEmbedding(params)` — insert or update `document_embeddings`, skipping if `content_hash` unchanged
- `searchSimilar(params: { teamId, embedding, threshold, limit })` — runs pgvector cosine similarity query filtered by `teamId`

Key implementation notes:
- Batch embedding requests where possible (OpenAI supports up to 2048 inputs per call)
- Catch and log OpenAI errors — embedding failure should not block the main request; degrade gracefully
- Use `crypto.createHash('sha256')` from Node built-ins for content hashing

### 1.5 Unit tests for embedding service

`apps/api/src/services/__tests__/embedding.service.test.ts`:

- Mock OpenAI client
- Test `upsertEmbedding` skips re-embed when `content_hash` matches
- Test `searchSimilar` constructs correct SQL with `teamId` filter
- Test graceful degradation when OpenAI throws

**Deliverable:** Schema migrated, embedding service tested, no user-visible change.

---

## Phase 2 — Embed Existing Corpus

**Goal:** Backfill embeddings for all existing document versions so the matcher has corpus data to work with from day 1.

### 2.1 Create a backfill script

`apps/api/scripts/backfill-embeddings.ts`:

- Query all `document_versions` grouped by `team_id`
- For each version, call `embeddingService.upsertEmbedding`
- Rate-limit: 50 req/s (OpenAI tier default) with exponential backoff
- Log progress: `Embedded N/M versions`
- Idempotent: safe to re-run (content_hash check prevents duplicate work)

Run with:

```bash
pnpm --filter @syncdocs/api exec tsx scripts/backfill-embeddings.ts
```

### 2.2 Hook new document version saves

In the existing document version creation path (find in `apps/api/src/routes/documents.ts` or the service that creates `document_versions`):

- After saving a new version, call `embeddingService.upsertEmbedding` asynchronously (fire-and-forget, log errors)
- Do not block the version-save response on embedding

**Deliverable:** All existing and new document versions are embedded automatically.

---

## Phase 3 — Historical Match Service

**Goal:** Implement the matching logic that classifies retrieved results into signal validation, contradiction, and scope creep callouts.

### 3.1 Create `historical-match.service.ts`

`apps/api/src/services/historical-match.service.ts`:

```typescript
interface MatchResult {
  type: 'signal_validation' | 'contradiction' | 'scope_creep';
  message: string;
  matchCount?: number;
  relatedIds: string[];
  relatedTitles: string[];
}

interface RunHistoricalMatchParams {
  teamId: string;
  content: string;
  sourceType: 'document_version' | 'chaos_input';
  sourceId?: string; // exclude from results if re-matching an existing doc
}

async function runHistoricalMatch(params: RunHistoricalMatchParams): Promise<MatchResult[]>
```

**Internal logic:**

1. `embeddingService.embedText(content)` → embedding vector
2. `embeddingService.searchSimilar({ teamId, embedding, threshold: MATCH_THRESHOLD, limit: 10 })`
3. Classify results:
   - **Signal validation:** count unique inputs with cosine ≥ threshold. If count ≥ `SIGNAL_MENTION_THRESHOLD` (default 3), emit a `signal_validation` callout.
   - **Contradiction:** for matches with cosine ≥ `CONTRADICTION_THRESHOLD` (default 0.90) that come from `document_version` sources, call a lightweight Claude prompt: `"Does the following input contradict this spec? Answer yes or no with a one-sentence reason."` If yes, emit a `contradiction` callout.
   - **Scope creep:** if a matched spec exists and the new content token count is ≥ `SCOPE_CREEP_RATIO` (default 3.0×) the matched spec's token count, emit a `scope_creep` callout.
4. Return all emitted callouts.

**Config (from env):**

```typescript
const MATCH_THRESHOLD = parseFloat(process.env.MATCH_SIMILARITY_THRESHOLD ?? '0.82');
const SIGNAL_MENTION_THRESHOLD = parseInt(process.env.SIGNAL_MENTION_THRESHOLD ?? '3');
const CONTRADICTION_THRESHOLD = parseFloat(process.env.CONTRADICTION_THRESHOLD ?? '0.90');
const SCOPE_CREEP_RATIO = parseFloat(process.env.SCOPE_CREEP_RATIO ?? '3.0');
```

### 3.2 Unit tests for match service

`apps/api/src/services/__tests__/historical-match.service.test.ts`:

- Mock `embeddingService.searchSimilar` and AI client
- Test signal validation fires at threshold (3 matches) but not below (2 matches)
- Test contradiction check invokes Claude prompt only above `CONTRADICTION_THRESHOLD`
- Test scope creep triggers on 3× token expansion
- Test that `sourceId` exclusion works (a document doesn't match itself)

**Deliverable:** Historical match service tested in isolation.

---

## Phase 4 — Chaos Ingestion Integration

**Goal:** Wire the match service into the Chaos Ingestion flow so every new input gets context callouts.

### 4.1 Update `chaos.service.ts`

After the new input is saved to `chaos_inputs`:

1. Call `embeddingService.upsertEmbedding` for the new input
2. Call `historicalMatchService.runHistoricalMatch` with `sourceType: 'chaos_input'`
3. Pass the returned `MatchResult[]` to the AI spec-generation prompt as additional context:
   ```
   Historical context (do not modify, inject verbatim as a callout section):
   {{matchResults}}
   ```
4. Return `historicalContext` alongside `spec` in the API response

### 4.2 Update the Chaos Ingestion API response type

In `packages/shared/src/types.ts` (or equivalent), extend the response type:

```typescript
interface ChaosIngestResponse {
  inputId: string;
  spec: string;
  historicalContext: MatchResult[];
}
```

### 4.3 Update `POST /api/chaos/ingest` route handler

Pass `historicalContext` in the JSON response. No schema migration needed.

**Deliverable:** End-to-end flow from raw input → embedded → matched → spec with callouts.

---

## Phase 5 — Document Context Match Endpoint

**Goal:** Expose on-demand historical matching for existing documents (independent of Chaos Ingestion).

### 5.1 Add `GET /api/documents/:id/context-matches`

Route: `apps/api/src/routes/documents.ts`

- Fetch the latest published version of the document
- Call `historicalMatchService.runHistoricalMatch` with `sourceType: 'document_version'`, `sourceId: version.id`
- Return `MatchResult[]`

This endpoint is useful for:
- Running a manual "what's changed around this spec?" check
- Agent workflows that want historical context before drift detection

### 5.2 Add `search_historical_context` agent tool

In `apps/api/src/services/agent/tools.ts`, add a new tool:

```typescript
{
  name: 'search_historical_context',
  description: 'Search for historical inputs and specs similar to a given document. Returns signal validation, contradiction flags, and scope creep warnings.',
  input_schema: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: 'The document to match against history' },
    },
    required: ['document_id'],
  },
}
```

Wire it to `historicalMatchService.runHistoricalMatch` in `executor.ts`.

Add it to the `full_spec_review` workflow in `workflows.ts` (read-only, no write permission needed).

**Deliverable:** Agents and manual API calls can trigger historical context matching for any document.

---

## Phase 6 — Frontend UI

**Goal:** Surface context callouts in the spec editor and chaos input view.

### 6.1 Historical Context Callout component

`apps/web/src/components/HistoricalContextCallout.tsx`

Props:
```typescript
interface HistoricalContextCalloutProps {
  type: 'signal_validation' | 'contradiction' | 'scope_creep';
  message: string;
  relatedIds: string[];
  relatedTitles: string[];
  onClickThrough: (id: string) => void;
}
```

Renders:
- An info/warning/alert banner (color-coded by type: blue / orange / yellow)
- The human-readable message
- A list of linked related specs/inputs (clickable)

### 6.2 Wire callouts into Chaos Ingestion view

After a chaos input is processed, display `HistoricalContextCallout` components above the generated spec for each item in `historicalContext`.

### 6.3 Wire callouts into document sidebar

On the document detail page, add a "Historical Matches" panel in the sidebar that calls `GET /api/documents/:id/context-matches` and renders any results.

### 6.4 Add E2E selectors

In `e2e/fixtures/selectors.ts`, add:

```typescript
historicalContext: {
  callout: '[data-testid="historical-context-callout"]',
  calloutType: (type: string) => `[data-testid="historical-context-callout-${type}"]`,
  relatedLink: '[data-testid="historical-context-related-link"]',
}
```

**Deliverable:** Users see context callouts inline in the product.

---

## Phase 7 — E2E Tests

`e2e/chaos-ingestion.spec.ts` (extend or create):

- Seed a set of past inputs (3+) with similar content to a new input
- Ingest a new matching input
- Assert that a `signal_validation` callout is shown with correct count
- Assert that a contradiction callout appears when an input conflicts with a seeded spec version
- Assert that clicking a related link navigates to the correct historical record

`e2e/document-context-matches.spec.ts`:

- Open a document with seeded similar documents
- Assert that the "Historical Matches" sidebar panel shows at least one result

---

## Dependencies & Ordering

```
Phase 1 (Embedding Infrastructure)
    │
    ├── Phase 2 (Backfill) ──────────────────────────────┐
    │                                                     │
    └── Phase 3 (Match Service)                          │
            │                                             │
            ├── Phase 4 (Chaos Integration) ←── needs #87│
            │                                             │
            └── Phase 5 (Document Endpoint + Agent Tool) ┘
                    │
                    └── Phase 6 (Frontend UI)
                            │
                            └── Phase 7 (E2E Tests)
```

Phases 1 and 3 can be built and tested without Chaos Ingestion. Phase 4 is the only hard dependency on #87.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| OpenAI embeddings API outage | Low | Medium | Degrade gracefully — skip context callouts rather than blocking ingestion |
| pgvector extension not available on host | Low | High | Check Railway/Render pgvector support before starting Phase 1; Neon and Supabase both support it |
| High embedding latency on large corpus backfill | Medium | Low | Run backfill as a one-off script with rate limiting; doesn't affect user-facing latency |
| False-positive contradictions | Medium | Medium | Frame contradiction callouts as flags ("may conflict"), not hard blocks; user makes final call |
| Cold start UX confusion | High | Low | Add inline tooltip: "Matches improve as more inputs are added" |
| drizzle-orm vector type compatibility | Medium | Medium | Check version; use `customType` fallback if `vector` type not in current drizzle-orm version |

---

## Acceptance Criteria Checklist

- [ ] New input is embedded and compared against historical specs and inputs
- [ ] Matching past inputs/specs are surfaced in the output with relevance context
- [ ] Contradictions with existing versioned specs are flagged before output is finalized
- [ ] Recurring themes (3+ mentions) are explicitly called out in output
- [ ] Scope creep warning triggered when new input significantly expands a prior spec
- [ ] Historical context callouts are clearly separated from the generated spec
- [ ] User can click through to the referenced historical spec/input
- [ ] All embeddings are scoped per workspace — no cross-tenant leakage
- [ ] Embedding failure degrades gracefully (no 500s)
- [ ] E2E tests cover signal validation, contradiction, and click-through
