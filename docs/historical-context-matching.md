# Historical Context Matching

Historical context matching lets Nyx cross-reference new input against the full history of past specs and inputs before generating output. It surfaces recurring signals, flags contradictions, and detects scope creep — turning Nyx into a system that compounds in value over time.

## How It Works

1. A new input arrives via Chaos Ingestion
2. Nyx embeds the input as a vector using `text-embedding-3-small`
3. A semantic similarity search runs against the existing corpus of specs and past inputs (pgvector)
4. The top matching records are retrieved and classified:
   - **Signal validation** — the same signal has been mentioned in N prior inputs
   - **Contradiction** — the new input conflicts with an accepted spec version
   - **Scope creep** — the new input significantly expands what a prior spec defined
5. The classified matches are injected as a `Historical Context` section in the generated output
6. Each callout links back to the original spec or input so the user can click through

```
New input
    │
    ▼
Embed (text-embedding-3-small)
    │
    ▼
Semantic search → document_embeddings (pgvector cosine similarity)
    │
    ▼
Classify matches (signal / contradiction / scope creep)
    │
    ▼
Inject context callouts into spec output
```

## Context Callout Types

### Signal Validation
Shown when the same theme appears in 3 or more prior inputs.

> **Historical signal** — This theme has appeared in 4 prior inputs (most recent: March 5). It may be ready for a spec.

### Contradiction Detection
Shown when the new input conflicts with a published spec version.

> **Contradiction** — This conflicts with v2.1 of _Auth Flow_ (accepted March 2). Review before proceeding.

### Scope Creep Warning
Shown when the new input expands a prior spec by a significant margin.

> **Scope creep** — This request has expanded 3× from its original spec in _Onboarding v1.0_. Consider a separate spec.

## Setup

### 1. Enable pgvector on your Postgres instance

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

For hosted Postgres (Railway, Neon, Supabase), enable the `pgvector` extension in the dashboard or via:

```bash
psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 2. Add the OpenAI API key

Historical context matching uses `text-embedding-3-small` from the OpenAI embeddings API. Add to `.env`:

```env
OPENAI_API_KEY=sk-...
```

### 3. Push the database schema

```bash
pnpm --filter @syncdocs/api exec drizzle-kit push --force
```

This creates the `document_embeddings` and `chaos_inputs` tables (see Architecture below).

### 4. Restart the dev server

```bash
pnpm dev
```

## API Endpoints

### `POST /api/chaos/ingest`

Ingest a new unstructured input. Embeds it, runs historical matching, and returns a spec draft with context callouts.

**Request:**
```json
{
  "content": "Users keep asking for bulk export to CSV",
  "sourceType": "customer_call",
  "sourceLabel": "Q1 check-in — Acme Corp"
}
```

**Response:**
```json
{
  "inputId": "uuid",
  "spec": "## Feature: Bulk Export\n\nUsers want...",
  "historicalContext": [
    {
      "type": "signal_validation",
      "matchCount": 4,
      "message": "This theme has appeared in 4 prior inputs this month.",
      "relatedInputIds": ["uuid1", "uuid2", "uuid3", "uuid4"]
    }
  ]
}
```

### `GET /api/chaos/inputs`

List all past chaos inputs for the team (paginated).

### `GET /api/chaos/inputs/:id`

Get a single input with its embeddings metadata and matched context.

### `GET /api/documents/:id/context-matches`

Run a one-off historical match against an existing document. Returns the top similar specs and inputs without regenerating the spec.

## Matching Thresholds

| Signal | Threshold | Notes |
| --- | --- | --- |
| Semantic similarity (general match) | cosine ≥ 0.82 | Top 10 results surfaced |
| Signal validation trigger | 3+ prior matches | Explicitly called out in output |
| Contradiction trigger | cosine ≥ 0.90 + conflicting sentiment | Flagged before output is finalized |
| Scope creep trigger | new token count ≥ 3× matched spec | Approximate; uses token ratio |

Thresholds are configurable via environment variables (see Architecture).

## Privacy

All embeddings are scoped per workspace (`teamId`). Similarity search is always filtered by `teamId` — no cross-tenant leakage is possible at the query level. Embeddings are stored in Postgres alongside existing data and follow the same retention policy.

## Architecture

| Component | File |
| --- | --- |
| Embedding service | `apps/api/src/services/embedding.service.ts` |
| Historical match service | `apps/api/src/services/historical-match.service.ts` |
| Chaos ingestion service | `apps/api/src/services/chaos.service.ts` |
| Route handlers | `apps/api/src/routes/chaos.ts` |
| DB schema (new tables) | `apps/api/src/db/schema.ts` (`documentEmbeddings`, `chaosInputs`) |
| DB migration | `apps/api/drizzle/0011_historical_context.sql` |
| Unit tests | `apps/api/src/services/__tests__/historical-match.service.test.ts` |
| E2E tests | `e2e/chaos-ingestion.spec.ts` |

### New DB Tables

**`chaos_inputs`**

Stores each raw input ingested via Chaos Ingestion.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| team_id | uuid | FK → teams |
| created_by_id | uuid | FK → users |
| content | text | Raw input text |
| source_type | text | e.g. customer_call, slack, email |
| source_label | text | Human-readable source label |
| processed_at | timestamptz | When embedding + matching ran |
| created_at | timestamptz | |

**`document_embeddings`**

Stores vector embeddings for both documents (versioned) and chaos inputs.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| team_id | uuid | FK → teams — used for all similarity queries |
| source_type | text | `document_version` or `chaos_input` |
| source_id | uuid | FK to the relevant source table |
| embedding | vector(1536) | text-embedding-3-small output |
| content_hash | text | SHA-256 of content — skip re-embedding unchanged content |
| created_at | timestamptz | |

Index: `HNSW` index on `embedding` for fast approximate nearest-neighbour search.

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for embeddings |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | Embedding model name |
| `MATCH_SIMILARITY_THRESHOLD` | No | `0.82` | Minimum cosine similarity for a match |
| `SIGNAL_MENTION_THRESHOLD` | No | `3` | Minimum mentions to trigger signal callout |
| `CONTRADICTION_THRESHOLD` | No | `0.90` | Similarity floor for contradiction check |

## Limitations & Future Work

- **Cold start** — the feature is low-signal on day 1 and grows in value with volume. The UI should communicate this to new users.
- **Embedding freshness** — when a document is edited, its embedding is re-computed asynchronously. There is a short window where the old embedding is returned. A `content_hash` column prevents stale re-embeds.
- **Contradiction detection accuracy** — contradiction detection uses similarity + a lightweight Claude prompt to check for semantic conflict. False positives are possible; the callout is framed as a flag, not a block.
- **Scope creep heuristic** — the current heuristic uses token-count ratio, which is a proxy. A future iteration could use a dedicated Claude prompt to compare scope more precisely.
- **Chaos Ingestion dependency** — this feature requires Chaos Ingestion (#87) to be live for the full ingestion flow. The `GET /api/documents/:id/context-matches` endpoint works independently for document-to-document matching.
