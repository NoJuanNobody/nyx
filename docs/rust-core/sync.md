# Live sync: drift detection, impact map, semantic retrieval (AI-68)

Module: `crates/nyx-core/src/sync/`. Migration `0168_sync.sql` (version 168) adds `impact_edges` and `drift_records`; chunks, audit trail, documents and integrations come from the existing store.

## TS source mapping

| TS | Rust |
|---|---|
| `impact-graph.service.ts` (+ route) | `impact::build_audit_graph`, `document_audit_graph` (intent inference, 14-day no-downstream-commit flag) |
| ImpactMap "what does this affect" | `impact::ImpactGraph` (specs/files/tickets, weighted edges, `traverse`, `affected_by`), persisted by `SqliteImpact` |
| `trace.service.ts` | `trace::{build_trace, Trace::summary, Trace::lineage}` |
| `retrieval.service.ts` | `retrieval::{retrieve_chunks, search_documents}` (+ keyword and hybrid), `index_document`, `index_code_file`, `retrieve_code` |
| `query.service.ts` | `query::query_docs` (streams through `LlmProvider::complete_stream`) |
| `search.service.ts` | `search::{WebSearch, TavilySearch}` (stub without key) |
| `context-matching.service.ts` | `context::ContextMatcher` |
| `routes/webhooks.ts` push flow + `ai.detectDrift` | `drift::{ChangeSet, DriftEngine, process_webhook}`, `matching::match_specs` |
| new (acceptance: file watcher) | `watch::{Watcher, scan, diff, DirCodeSource}` |

## Drift pipeline

`push webhook | Watcher::poll` -> `ChangeSet` (paths + idempotency key) -> `match_specs` (impact edges, path/name/stem mentions, optional chunk similarity) -> one `prompts::drift` call per matched spec -> `parse_verdict` -> `drift_records`.

- **Idempotent**: unique `(run_key, document_id, doc_version)`. Same push redelivered: no model call, no second record, no duplicate `code_commit` audit event. Editing the spec makes the same push judgeable again.
- **Malformed model output** is a per-spec failure in `DriftRunReport::failures` and is retried on replay; it is never stored as "no drift" (the TS did that).
- `parse_verdict` accepts bare/fenced/prose-wrapped JSON, `"true"` strings, numeric strings, clamps score to 0..10, derives the flag from the score when `hasDrift` is absent, rejects everything else.
- `process_webhook` verifies the signature (per-integration `webhookSecret`, optional deployment-wide fallback) before parsing, then processes only the teams whose secret verified.

## Retrieval

Brute-force cosine over the newest chunk version of each live document, streamed from SQLite (no per-row allocation), top-k with deterministic tie-break. Modes: semantic (default, threshold 0.3 like the TS), keyword (term coverage) and hybrid (`w*cos + (1-w)*keyword`). Measured by the `ten_thousand_chunks_search_is_fast` test: 10k x 128-d chunks under 200 ms in release (about 30 ms here; the assertion only runs in release builds). FTS5 is deliberately not used (see module docs); `sqlite-vec` remains the TODO from GH #285. `HashingEmbedder` is an offline, lexical embedder so everything works without a key; a provider-backed `Embedder` is the wiring wave's job.

## Gaps vs the TS / for the wiring wave (AI-74)

- Specs are pre-filtered by path matching; the TS judged every team document. `MatchConfig::fallback_all_docs` restores that.
- No `timeline_events` (table not ported): a drift finding is the `drift_records` row; `notify::DriftDetected` is not emitted here, the caller can map `DriftRunReport::drifted()` to it.
- `code_commit` audit events are written for matched specs only (TS: every team doc).
- No OS file-watch hook (poll API only), Tavily and the OpenAI-compatible embedder run over the `nyx-net` transport (fixture-tested only), `Embedder` is now the single `ai::embedder::Embedder` trait, no `CodeSource` backed by the git provider contents API (a local checkout works via `DirCodeSource`). The `codebase-scanner` that fills code chunks from a repo is another ticket; `index_code_file` is the building block.
- Generative drift panels / `ImpactMap.tsx` / `ContextMatches.tsx` are UI (web ticket); the data they need is exposed here as serde types (`camelCase` where the TS API was).
- Route-level permission checks are not applicable (single-user desktop core).
