# nyx-core data model (Drizzle to Rust/SQLite)

Ticket: AI-60. Source of truth for the old schema: `apps/api/src/db/schema.ts`. Ledger contract: `docs/credits/utility-tokens-spec.md` sections 8 and 9.

## Layout

| Path | Role |
|---|---|
| `crates/nyx-core/migrations/NNNN_*.sql` | Embedded, versioned, forward-only SQL migrations |
| `src/store/migrate.rs` | Runner: `schema_migrations` table with sha256 checksums; refuses edited migrations, unknown (newer) versions and out-of-order versions; one transaction per migration |
| `src/store/db.rs` | `Db::open(path)` / `Db::open_in_memory()`; sets `foreign_keys=ON`, WAL for files; `Db::transaction(\|conn\| ...)` (BEGIN IMMEDIATE, rollback on `Err`) |
| `src/model/*.rs` | One file per aggregate: serde types, `New*` inputs, string enums |
| `src/store/<aggregate>.rs` | One file per aggregate: repository trait + `Sqlite*` impl borrowing a `&Connection` (a `&Transaction` derefs to one, so repos compose inside `Db::transaction`) |
| `src/ledger.rs` | Pure ledger fold, `LedgerStore` trait, `LedgerService` |
| `src/store/credits.rs` | `SqliteLedgerStore` |
| `src/store/import.rs` | Postgres JSON export importer |

Adding an aggregate (for sibling tickets): add `model/<x>.rs` + `store/<x>.rs`, register both in their `mod.rs`, add the next numbered SQL file and a `Migration` entry in `CORE_MIGRATIONS` (or pass your own list to `Db::open_with`). Never edit an applied migration.

## Type conventions

| Postgres/Drizzle | SQLite | Rust |
|---|---|---|
| `uuid` PK (`defaultRandom`) | `TEXT` | `String` (`model::Id`, uuid v4 via `new_id()`) |
| `timestamp with time zone` (`defaultNow`) | `INTEGER` unix ms UTC | `i64` (`model::Timestamp`, `now_ms()`) |
| `boolean` | `INTEGER` 0/1 with CHECK | `bool` |
| `jsonb` | `TEXT` with `CHECK (json_valid(..))` | `serde_json::Value` (or typed `Vec<String>` for `lifecycle_stages.docs`) |
| `pgEnum` | `TEXT` with `CHECK (col IN (..))` | enum via `string_enum!` (serde + `FromStr` + rusqlite `ToSql/FromSql`); tests assert every variant passes its CHECK |
| `vector(1536)` | `BLOB` (LE f32) + `embedding_dim` + `embedding_model` | `Option<Vec<f32>>` |

## Table mapping

| Drizzle table | SQLite table | Rust model / repo | Notes |
|---|---|---|---|
| `users` | `users` | `User` / `UserRepo` | Dropped `clerk_id` (hosted auth) |
| `teams` | `teams` | `Team` / `TeamRepo` | Dropped `default_model`, `fast_model` (in-app LLM prefs) |
| `team_members` | `team_members` | `TeamMember` / `TeamRepo` | Added `UNIQUE(team_id,user_id)`; last owner cannot be demoted/removed |
| `lifecycles` | `lifecycles` | `Lifecycle` / `LifecycleRepo` | Added partial unique index: at most one default |
| `lifecycle_stages` | `lifecycle_stages` | `LifecycleStage` / `LifecycleRepo` | `docs` jsonb -> `Vec<String>`; cascade on lifecycle delete |
| `documents` | `documents` | `Document` / `DocumentRepo` | Soft delete via `deleted_at`; `create` also writes version 1 |
| `document_versions` | `document_versions` | `DocumentVersion` / `DocumentRepo` | Added `UNIQUE(document_id,version)`, `version >= 1`, immutability trigger |
| `document_branches` | `document_branches` | `DocumentBranch` / `BranchRepo` | `status` free text -> `BranchStatus` enum + CHECK; added `UNIQUE(document_id,name)` |
| `snapshots` | `snapshots` | `Snapshot` / `SnapshotRepo` | |
| `integrations` | `integrations` | `Integration` / `IntegrationRepo` | `config` JSON; keep secrets in the OS keychain (TODO, not stored by this crate) |
| `tickets` | `tickets` | `Ticket` / `TicketRepo` | `claude_insights` column kept for import fidelity, exposed as `insights` |
| `audit_trail` | `audit_trail` | `AuditEvent` / `AuditRepo` | Append-only triggers; `agent_workflow` event type dropped |
| `doc_chunks` (pgvector) | `doc_chunks` | `DocChunk` / `ChunkRepo` | HNSW index dropped; brute-force cosine in Rust. TODO: `sqlite-vec` (GH #285) |
| `code_chunks` (pgvector) | `code_chunks` | `CodeChunk` / `ChunkRepo` | same |
| `credit_entries`, `credit_postings` (SQLite draft, AI-56) | same names | `LedgerEntry`, `Posting`, `Ledger`, `SqliteLedgerStore` | Spec section 8 triggers; see "Ledger" below |
| `credit_balances`, `credit_transactions`, `team_credit_balances` | not ported | | Superseded by the ledger (spec section 8) |

Not ported (out of scope or removed with agent/Stripe/chat): `meeting_documents`, `document_templates`, `timeline_events`, `change_proposals`, `team_invitations`, `waitlist_signups`, `api_keys`, `ticket_suggestions`, `intake_sessions`, `slack_connections`, `notifications`, `notification_preferences`, `email_delivery_log`, `feedback_submissions`, `deliverables`, feature-request tables, `project_showcases`, `social_posts`, `team_ai_keys`, `ai_usage_log`, `user_pipeline_access`, `atlassian_connections`, `pkce_challenges`, `background_jobs`, `approvals`, `onboarding_progress`. Later tickets can add any of them as new migrations.

## Semantics worth knowing

- **Versions:** `DocumentRepo::save_content` appends version `n+1` and updates the head; identical content is a no-op; deleted documents refuse writes. `restore_version` appends a new version, history is never rewritten.
- **Branches:** fork from a version (default latest), status machine `draft -> in_review -> approved|rejected`, `merged` only via `merge`. Merge needs `approved`; if the document advanced past the base version it fails with `Error::Conflict` unless `MergeStrategy::Overwrite`. TODO: three-way text merge.
- **Atomicity:** multi-statement operations (`create`, `save_content`, `merge`) are atomic when run in `Db::transaction`; the repos do not open their own transactions so callers control scope.
- **Errors:** UNIQUE violations become `Error::Conflict`, FK/CHECK violations `Error::Invalid`, missing rows `Error::NotFound`.

## Ledger

- `Ledger` is a pure in-memory fold (no I/O); `Ledger::from_entries` re-validates seq, hash chain, zero-sum, non-negative balances, workspace isolation, reservation/refund rules. Hashes use canonical JSON (keys sorted explicitly, not dependent on serde_json feature flags) and are verified against golden values produced by the TypeScript reference (`tests/ledger.rs::hashes_match_the_typescript_reference_implementation`).
- `LedgerService<S: LedgerStore>` persists every accepted command before returning. `SqliteLedgerStore::append` runs in `BEGIN IMMEDIATE` (or a savepoint inside a caller transaction), re-checks the stored tail, and loses safely with `Error::Conflict` if another writer extended the chain; the service then reloads and retries once. Idempotent replays are never re-persisted.
- Amounts are `i64` credits, capped at 2^53-1 for TS parity. Credits are never sold, transferable across workspaces, or expiring; no API for any of that exists.
- Open item: `LedgerService::open` loads the full ledger once; fine for a local desktop file, revisit with a snapshot/checkpoint if ledgers grow past ~10^6 entries.

## Postgres import

`store::import::import_postgres_json(&mut Db, &serde_json::Value)` consumes `{ "<table>": [ {col: value} ] }` using the Postgres column names (see the module doc for a `psql` export recipe). Timestamps (RFC 3339 / Postgres) become unix ms, pgvector text becomes f32 BLOBs (model recorded as `imported-pgvector`), unknown tables/columns are ignored and reported, credits are never imported. Rows violating a constraint are skipped and listed in `ImportReport.skipped`; the import is one transaction. Not yet done: a CLI subcommand (`nyx import-postgres`) wrapping this function belongs to `crates/nyx-cli`.
