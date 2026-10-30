# Repo scan / onboarding / indexing (AI-67)

Rust port of the scan, onboarding, embedding and job services. Module: `crates/nyx-core/src/scan/`. Migration `0167_repo_scan.sql`.

## Layout

| File | Contents |
| --- | --- |
| `filter.rs` | `FileFilter` presets (`for_index`, `for_specs`, `for_onboarding`), ignore dirs/extensions, size and binary checks, `Language` detection |
| `chunker.rs` | `chunk_code_file`: declaration-aligned segments per language, packed to 1500 chars, oversize segments fall back to `intake::chunking::chunk_text` (150 overlap), `// File: <path>` prefix as in the TS |
| `source.rs` | `RepoSource` trait; `GitProviderSource` (any `GitProvider`), `LocalFolderSource` (offline, jailed, never follows symlinks), `MemorySource` (tests) |
| `plan.rs` | `plan_scan`: added / modified / unchanged / removed / skipped / over-limit against the stored manifest |
| `embed.rs` | `Embedder` trait, deterministic `FakeEmbedder`, `HttpEmbedder` (OpenAI-compatible wire format over `ai::HttpTransport`), `embed_texts` (batching, dedupe by SHA-256, persistent `embedding_cache`) |
| `meter.rs` | `ScanMeter`, `NoMeter`, `CountingMeter`, `LedgerMeter` (reserve + commit on the credit ledger) |
| `indexer.rs` | `index_repo`: the pipeline, `ScanEvent` progress, cancellation hook, `IndexReport` |
| `jobs.rs` | `background_jobs` store (enqueue/claim/progress/complete/fail/requeue/cancel/retry), `JobRunner`, `ScanJobHandler` |
| `onboarding.rs` | `onboarding_progress`, module grouping, smart sampling, `scan_repository` (via `ai::Advisor`), `ScanCache`, `save_scan_documents` |
| `specs.rs` | spec-vs-code scan (`SpecScanner`), `search_code`, `fetch_relevant_code_for_document` + `RelevantCodeCache` |
| `store.rs` | manifest, repo state, embedding cache, per-file chunk deletion |

Chunks are written through the existing `store::ChunkRepo::insert_code_chunk`; vectors are the existing f32 BLOB format. The only direct SQL on `code_chunks` is the per-file delete in `scan/store.rs` (the repo API only deletes per repository).

## How a scan works

1. `source.head_token()`: if it equals the head of the last *complete* scan, return `up_to_date` without listing.
2. List, filter (`FileFilter`), cap at `max_files` (200, shallowest paths first so the choice is deterministic), compare with the manifest by revision token.
3. Delete chunks of removed / newly-ignored files. Read added and changed files, reject binary / oversize / empty, chunk.
4. Embed in batches (default 50, never above `Embedder::max_batch`), identical texts once, cached vectors free. `ScanMeter::charge(n)` runs before each batch that really hits the embedder.
5. Per file, in one savepoint: delete old chunks, insert new chunks with vectors, upsert manifest. Work finished before a failure is kept; a retry resumes.
6. Record repo state. The head token is stored only if no file failed to read, so a partial scan is re-listed next time.

Files rejected after reading are recorded in the manifest with `chunk_count = 0` so they are not fetched again while unchanged.

## Revision tokens and the incremental limit

`SourceEntry::sha` is a token known from the listing. `MemorySource` and local sources derive it from content (`sha256:<hex>`, not git's sha1 blob id: only sha2 is a dependency). `GitProvider` tree entries carry no blob sha (AI-66 owns that type), so for git hosts an unchanged repo is detected by the commit sha (`list_commits(limit 1)`), and after a new commit every known file is re-fetched and compared by content hash: no re-chunking, re-embedding or credits for unchanged files, but still one fetch per file. TODO: carry the blob sha in `GitTreeEntry` (small AI-66 follow-up) to remove those fetches, and add a tarball download for first scans (#348).

## Jobs

`JobRunner::run_next(conn)` claims the oldest pending job of a registered type and runs its handler. Outcomes: `Ok` -> completed (progress 100, result JSON); `JobError::Retryable` -> back to `pending` until `max_attempts`, then failed ("gave up after N attempts"); `Fatal` -> failed; `Cancelled` -> cancelled. `request_cancel` cancels pending jobs at once and flags running ones (`cancel_requested`), which `ScanJobHandler` polls between files and before each embedding batch. `retry` re-queues failed or cancelled jobs with attempts reset. Retryable = transient embedder error (429/5xx/network), I/O, provider rate limit on listing. Not retried: out of credits, bad key, malformed response, bad input.

The runner is synchronous and owns no thread: run it from a worker thread holding the `Db` (the wiring wave should `spawn_blocking`). Progress is persisted on the job row (`progress`, `progress_message`), so UI/MCP/CLI poll `jobs::get` / `list_by_team`; `ScanEvent`s are also available live through `ScanHooks::on_event`.

## Onboarding

Steps and routes: `completed_steps` (`GET /progress`), `mark_step_complete` (`POST /progress/:step`, whitelist `VALID_STEPS`), `scan_repository` + `save_scan_documents` (`POST /scan`). Module patterns, scoring, 8 per module / 80 total, small-repo (<5 files) single prompt, 6-wide model concurrency (scoped threads) and the 10 minute `owner/repo@head` cache are ported as-is. Prompts and parsing live in `ai::Advisor` (AI-75).

## TS source mapping

| TS | Rust |
| --- | --- |
| `codebase-scanner.service.ts` `scanAndFillSpecs`, `scanDocument`, `_matchCodeFiles`, `_analyzeAndGenerate` | `specs::SpecScanner::{scan_all, scan_document}` |
| `code-embedding.service.ts` `indexRepo` | `indexer::index_repo` |
| `code-embedding.service.ts` `searchCode`, `fetchRelevantCodeForDocument`, cache | `specs::{search_code, fetch_relevant_code_for_document, RelevantCodeCache}` |
| `embedding.service.ts` | `embed::{Embedder, HttpEmbedder}` |
| `embedding-pipeline.service.ts` (doc chunk indexing) | already `intake::chunking::store_doc_chunks`; this module adds the embedder + cache it needs (`embed::embed_texts`) |
| `job.service.ts` | `jobs.rs` |
| `onboarding.service.ts`, `routes/onboarding.ts` | `onboarding.rs` |
| `routes/scanner.ts` | `index_repo` / `SpecScanner` (`/scan`, `/scan-document`, `/index`); `/results` needs the proposal sink |
| `routes/jobs.ts` | `jobs::{list_by_team, get, request_cancel, retry}` |

## Deviations and parity gaps

- **Not tree-sitter.** Needs one C grammar crate per language (build time, `cc`, binary size). The structural splitter is regex based at column 0, so a nested declaration is never a boundary and unusual layouts (e.g. C functions with brace on the next line) degrade to size-based splitting. A grammar backed `segments()` can replace it without API changes.
- **Delete-then-insert is gone.** The TS deleted every chunk of a repo before inserting; here updates are per file and incremental.
- **Spec-scan proposals.** The TS inserted a bare `change_proposals` row; Rust proposals are branch backed, so findings go to a `SpecProposalSink` (`RecordingSink` for tests). Wiring decides the target branch. `GET /scanner/results` therefore has no direct equivalent yet.
- 6 s soft timeout on `fetchRelevantCodeForDocument` dropped (local synchronous search). Documents are scanned in `list_live` order, not newest first.
- No `.gitignore` handling in `LocalFolderSource` (only the built-in ignore list).
- Model-call usage records are not passed through the threaded module-doc calls (`Advisor` is built per thread without a `UsageSink`).
- Embedding dimension is whatever the embedder returns; the TS fixed 1536 (pgvector). Search skips chunks of another dimension (existing `ChunkRepo` behaviour), so switching models requires a forced re-index (the cache is keyed by model).
- `HttpEmbedder` has no real transport: the same `ai::HttpTransport` TODO as the other providers (AI-74). Local embedding models are out of scope; implement `Embedder`.
- GitHub rate-limit and the `GitProvider` per-file fetch make first scans of large repos slow (#348 tarball download not done).
- Git `commit_sha` is stored on chunks from `head_token` (the TS stored none).

## Agent-native surface (for the wiring wave, AI-74)

Nothing is exposed through MCP/CLI/Tauri yet. Suggested commands: `scan.start {repo, source}` (enqueue `repo_scan`), `scan.status {job_id}`, `scan.cancel`, `scan.retry`, `code.search {query}`, `onboarding.progress`, `onboarding.scan`. A `ScanMeter` built with `LedgerMeter` charges the calling agent's budget per newly embedded chunk.
