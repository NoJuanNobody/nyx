# Service facade, MCP server and CLI (`nyx-app`, `nyx-mcp`, `nyx-cli`)

Ticket AI-74. The agent-native interface to Nyx: one `nyx` binary (CLI plus `nyx mcp` stdio server) and a standalone `nyx-mcp` binary, both over the `nyx-app` service facade, which wraps every `nyx-core` module. The later Tauri shell calls the same facade.

## Architecture

```text
 Claude Code / Cursor / scripts            humans
        | MCP (JSON-RPC, stdio)                | clap
   crates/nyx-mcp  ----------------+     crates/nyx-cli
                                    \             /
                              crates/nyx-app  (NyxApp::call_tool: JSON in, JSON out)
        guards: rate limit -> schema validation -> capability check -> credit metering
                -> handler -> redacted errors / redacted call log
                                    |
                            crates/nyx-core (+ nyx-net live transports)
```

- `nyx-app` owns the tool catalogue (`registry::registry()`): name, JSON Schema, cost class, capability need, handler. MCP `tools/list`, `nyx tools` and the table below are generated from it, so they cannot drift.
- `NyxApp::open(AppOptions)` opens the SQLite DB (default `<OS app-data>/nyx.db`, override with `--db`/`NYX_DB`/`--data-dir`), runs migrations, creates the local owner and the `local` team, seeds the built-in lifecycle pipelines, and makes the first-run credit grant. It holds the `SecretStore` (OS keychain, or an encrypted file when `NYX_SECRETS_PASSPHRASE` is set) and a `Services` bundle.
- `Services` (trait objects): model provider, embedder, web search, ticket trackers. `Services::offline()` reaches no network: model/search/tracker tools answer `not_configured` instead of fabricating output (tests inject a scripted `FakeLlm`). `Services::live(secrets)` is what the binaries use (`AppOptions::live = true`): `nyx-net`'s SSRF-guarded `ureq` transport; BYOK model calls where the provider is picked per call from the keys in the secret store (so `nyx byok set` works without a restart; `NYX_PROVIDER` forces one); Tavily search when a `tavily` key is stored; GitHub/GitLab/Bitbucket trackers reading tokens per call. A plain-http loopback URL (local Ollama) is refused by the transport by design, so keyless local providers are not auto-selected.

## Guards applied to every call

| Guard | Behaviour |
| --- | --- |
| Rate limit | `security::RateLimiter`, default 600 calls/minute per caller (agent id); `rate_limited` with `retry_after_ms`. `NYX_RATE_LIMIT` overrides. |
| Schema validation | Arguments are validated against the published JSON Schema (types, required, enum, bounds, `additionalProperties`). Errors name the tool and field. Ids, titles and text additionally go through `security::validate` (control characters, NUL, size caps). |
| Path jail | `nyx_read_file`, `nyx_list_files`, `nyx_scan`, `nyx_drift_check`, export `path`, CLI `--file`/`--out` all resolve through `WorkspaceJail` rooted at `--workspace`/`NYX_WORKSPACE`/cwd: `..`, absolute paths outside, symlink escapes and backslashes give `path_rejected` (CLI exit 7). The TS server could read any path; this is a deliberate tightening. |
| Redaction | Every error message and structured error data passes through `security::redact` (API keys, tokens, JWTs, `password=`); the optional call log (`NYX_LOG=1`, stderr) records redacted, truncated arguments. Database and I/O errors are reduced to a first line. |
| Secrets | Credentials are never accepted as tool or CLI arguments: `nyx byok set` / `nyx integration secret` read one line from stdin into the keychain; `nyx_integration_set` rejects config keys that look like credentials; `nyx_integrations_list` redacts. |
| Capability check | Tools that need a model or search backend fail with `not_configured` before any credit is reserved. |

## Credit metering

Credits are agent-native utility tokens: metered and spent by agents, never sold; there is no purchase, plan or price surface. Contract: `docs/credits/utility-tokens-spec.md`. Backed by the hash-chained `nyx_core::ledger` in the same SQLite file, so the CLI, the MCP server and the desktop app share one ledger safely (`BEGIN IMMEDIATE` appends, tail check, retry on a lost race).

- **Local single-user defaults**: workspace `local`; first run grants 1000 to the pool (`cfg:init`, idempotent); the first time an agent is seen it receives up to `auto_allocate` (500, `NYX_AUTO_ALLOCATE`) from the pool (`auto:<agent>`, idempotent, so spending to zero never re-allocates). Later agents get what the pool has left (possibly 0). The owner tops up with `nyx credits grant` and `nyx credits allocate <agent> <n>` (CLI only; grant and allocate are owner actions, not MCP tools).
- **Agent identity**: `--agent`/`NYX_AGENT_ID`, else the MCP `clientInfo.name`, else `default`. Any agent may name another `agent_id` in the credit tools (single trusted local user; there is no per-agent authentication).
- **Every `tools/call` goes through `call_tool`.** Priced tools do `reserve(price)`, run, then `commit(price)` on success or `release` on failure; an exhausted budget returns `insufficient_credits` with `available` and `required` and the work never starts. A reservation that is never settled expires by TTL (5 minutes).
- **Default prices** (declared per tool in the catalogue; override in `<data dir>/costs.json` such as `{"nyx_search": 1}`, or `AppOptions::cost_overrides`; 0 makes a tool free): `nyx_check_quality` 3, `nyx_detect_drift` 2, `nyx_drift_check` 2, `nyx_create_ticket` 2, `nyx_web_search` 1, `nyx_scan` 1 per embedded chunk. Local document, version, branch, export, tree and audit operations default to 0 (the spec meters compute-heavy operations). So "metering is enforced on every call" means: every call passes the metering wrapper and honours the owner's price table, not that every call costs credits by default. To meter everything, set a price for each tool.
- **Credit tools** (`nyx_credits_{balance,reserve,commit,release,spend}`, plus read-only `nyx_credits_history`) use the argument names of `packages/mcp-server/src/credits.ts` and its zod `.strict()` semantics (unknown arguments rejected; `idempotency_key` 8 to 200 chars). The same key and payload replays the original entry (`replayed: true`); a different payload gives `idempotency_conflict`. `nyx_credits_spend` derives `<key>:reserve` and `<key>:commit`.
- **Scan metering differs from `scan::LedgerMeter`**: that meter charges per batch but needs a `Send + Sync` ledger executor, and a borrowed SQLite connection is not `Sync`. `nyx_scan` instead runs against a `CountingMeter` budget (balance divided by price) and settles the exact usage with one idempotent `spend` afterwards (also when the scan stops early). A crash mid-scan leaves that scan unpaid. Documented gap.
- `docs/credits/mcp-cli-usage.md` describes the HTTP contract of the TS clients (`NYX_API_KEY`, `/api/credits/*`). The Rust clients talk to the local ledger directly; those variables are not used.

## MCP server

`nyx mcp` or `nyx-mcp`: JSON-RPC 2.0, one message per line on stdin/stdout, implemented on `std::io` with `serde_json` (no async runtime, no MCP SDK dependency; the ticket suggested `rmcp`, a hand-written transport keeps the dependency tree small and the behaviour fully testable). Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`; notifications are accepted and answered with nothing; batches are answered as batches. Protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05` (the client's is echoed when known, otherwise the newest; `annotations` with `readOnlyHint` are only sent to clients that negotiated 2025-03-26 or later). Tool results are `content: [{type: "text"}]`; failures are `isError: true` with `Error: <code>: <message>` (and the structured JSON when there is data, for example `available`/`required`). Protocol errors use -32700/-32600/-32601/-32602. Resources mirror the TS server (`nyx://docs`, `nyx://docs/{id}`, `nyx://docs/{id}/versions`, `nyx://teams`, `nyx://teams/{id}`, `file://{path}` jailed); `resources/list` also enumerates up to 200 live documents (the TS server returned an empty list). Not implemented: Streamable HTTP / remote connect-by-URL (GH #485), prompts, logging, sampling, resource subscriptions.

Text rendering of the TS tools is ported from `formatter.ts` (`nyx_mcp::formatter`); timestamps are unix ms rendered as dates, and version/ticket lines also carry ids. All other tools return pretty JSON.

## CLI

`nyx <command>`; global flags `--json`, `--db`, `--data-dir`, `--workspace`, `--agent`, `--team`. With `--json` results and errors are JSON on stdout. Exit codes: 0 ok, 1 error, 2 usage/invalid input, 3 not found, 4 conflict (including a merge that still has conflicts), 5 insufficient credits, 6 rate limited, 7 path rejected, 8 capability not configured.

Every subcommand builds the same JSON arguments as the matching tool and calls `NyxApp::call_tool`: `doc`, `team`, `version`, `branch`, `diff`, `merge` (`--resolve ours|theirs|base|both` or `--resolutions FILE`, `--dry-run`), `snapshot`, `tree`, `folder`, `pipeline`, `template`, `export`, `bundle`, `ticket`, `scan`, `drift`, `search`, `code-search`, `index`, `impact`, `audit`, `notifications`, `approval`, `integration`, `byok`, `profile`, `credits` (`balance|reserve|commit|release|spend|history|usage|verify|grant|allocate|deallocate`), `quality`, `secrets`, `whoami`, `tools`, plus `tool <name> [json]` for any tool and `completions <bash|zsh|fish|elvish|powershell>`. `nyx credits` generates an idempotency key per invocation unless `--idempotency-key` is given.

## Tool catalogue (82 tools)

"TS parity": `exact` = same name and JSON schema as the TS server (credit tools also add length bounds); `extended` = same name plus extra optional properties; `new` = no TS equivalent. "Metered" shows the default price; unpriced tools still pass the metering wrapper.

| Tool | Source module (`nyx-core`) | Metered | TS parity | Kind |
| --- | --- | --- | --- | --- |
| `nyx_search_docs` | `store::documents`, `vcs::version` | no (price 0, owner can set) | exact | read |
| `nyx_read_doc` | `store::documents`, `vcs::version` | no (price 0, owner can set) | exact | read |
| `nyx_create_doc` | `store::documents`, `vcs::version` | no (price 0, owner can set) | exact | write |
| `nyx_update_doc` | `store::documents`, `vcs::version` | no (price 0, owner can set) | exact | write |
| `nyx_delete_doc` | `store::documents`, `vcs::version` | no (price 0, owner can set) | exact | write |
| `nyx_restore_doc` | `store::documents`, `vcs::version` | no (price 0, owner can set) | new | write |
| `nyx_list_teams` | `store::identity` | no (price 0, owner can set) | exact | read |
| `nyx_get_team` | `store::identity` | no (price 0, owner can set) | exact | read |
| `nyx_create_team` | `store::identity` | no (price 0, owner can set) | exact | write |
| `nyx_list_versions` | `vcs::version` | no (price 0, owner can set) | exact | read |
| `nyx_get_timeline` | `vcs::timeline` | no (price 0, owner can set) | extended | read |
| `nyx_create_version` | `vcs::version`, `vcs::diff`, `vcs::timeline` | no (price 0, owner can set) | new | write |
| `nyx_get_version` | `vcs::version`, `vcs::diff`, `vcs::timeline` | no (price 0, owner can set) | new | read |
| `nyx_diff_versions` | `vcs::version`, `vcs::diff`, `vcs::timeline` | no (price 0, owner can set) | new | read |
| `nyx_diff_text` | `vcs::diff` | no (price 0, owner can set) | new | read |
| `nyx_restore_version` | `vcs::version`, `vcs::diff`, `vcs::timeline` | no (price 0, owner can set) | new | write |
| `nyx_create_branch` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | write |
| `nyx_list_branches` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | read |
| `nyx_get_branch` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | read |
| `nyx_update_branch` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | write |
| `nyx_branch_review` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | write |
| `nyx_diff_branch` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | read |
| `nyx_merge_branch` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | write |
| `nyx_sync_branch` | `vcs::branch`, `vcs::merge` | no (price 0, owner can set) | new | write |
| `nyx_create_snapshot` | `vcs::snapshot` | no (price 0, owner can set) | new | write |
| `nyx_list_snapshots` | `vcs::snapshot` | no (price 0, owner can set) | new | read |
| `nyx_restore_snapshot` | `vcs::snapshot` | no (price 0, owner can set) | new | write |
| `nyx_diff_snapshot` | `vcs::snapshot` | no (price 0, owner can set) | new | read |
| `nyx_get_tree` | `tree` | no (price 0, owner can set) | new | read |
| `nyx_create_folder` | `tree` | no (price 0, owner can set) | new | write |
| `nyx_rename_folder` | `tree` | no (price 0, owner can set) | new | write |
| `nyx_move_folder` | `tree` | no (price 0, owner can set) | new | write |
| `nyx_delete_folder` | `tree` | no (price 0, owner can set) | new | write |
| `nyx_move_doc` | `tree` | no (price 0, owner can set) | new | write |
| `nyx_list_pipelines` | `lifecycle` | no (price 0, owner can set) | new | read |
| `nyx_get_pipeline` | `lifecycle` | no (price 0, owner can set) | new | read |
| `nyx_set_stage` | `lifecycle::transition`, `store::documents` | no (price 0, owner can set) | new | write |
| `nyx_list_templates` | `lifecycle` | no (price 0, owner can set) | new | read |
| `nyx_create_from_template` | `lifecycle` | no (price 0, owner can set) | new | write |
| `nyx_template_completeness` | `lifecycle` | no (price 0, owner can set) | new | read |
| `nyx_export_doc` | `export` | no (price 0, owner can set) | new | read |
| `nyx_export_bundle` | `export` | no (price 0, owner can set) | new | read |
| `nyx_generate_deliverable` | `export` | no (price 0, owner can set) | new | write |
| `nyx_create_ticket` | `tickets::tracker`, `tickets::draft` (traceability), `store::tickets` | yes, default 2 | extended | write |
| `nyx_list_tickets` | `tickets::tracker`, `store::tickets` | no (price 0, owner can set) | new | read |
| `nyx_set_ticket_status` | `tickets::tracker`, `store::tickets` | no (price 0, owner can set) | new | write |
| `nyx_stage_gate` | `tickets::gatekeeper` | no (price 0, owner can set) | new | read |
| `nyx_assess_readiness` | `tickets::gatekeeper` | no (price 0, owner can set) | new | read |
| `nyx_check_quality` | `ai::Advisor::analyze_spec_quality` | yes, default 3 | exact | read |
| `nyx_detect_drift` | `ai::Advisor::detect_drift` | yes, default 2 | exact | read |
| `nyx_drift_check` | `sync::drift::DriftEngine` | yes, default 2 | new | write |
| `nyx_list_drift` | `sync::drift` | no (price 0, owner can set) | new | read |
| `nyx_set_drift_status` | `sync::drift` | no (price 0, owner can set) | new | write |
| `nyx_index_docs` | `sync::retrieval`, `intake` | no (price 0, owner can set) | new | write |
| `nyx_search` | `sync::retrieval` | no (price 0, owner can set) | new | read |
| `nyx_impact_link` | `sync::impact` | no (price 0, owner can set) | new | write |
| `nyx_impact_unlink` | `sync::impact` | no (price 0, owner can set) | new | write |
| `nyx_impact` | `sync::impact` | no (price 0, owner can set) | new | read |
| `nyx_scan` | `scan`, `sync::retrieve_code` | per chunk, default 1 | new | write |
| `nyx_search_code` | `sync::retrieve_code` | no (price 0, owner can set) | new | read |
| `nyx_audit_log` | `governance::audit`, `sync::trace` | no (price 0, owner can set) | new | read |
| `nyx_audit_export` | `governance::audit`, `sync::trace` | no (price 0, owner can set) | new | read |
| `nyx_audit_trace` | `sync::trace` | no (price 0, owner can set) | new | read |
| `nyx_notifications` | `notify` | no (price 0, owner can set) | new | read |
| `nyx_notifications_mark_read` | `notify` | no (price 0, owner can set) | new | write |
| `nyx_approval_request` | `governance::approvals` | no (price 0, owner can set) | new | write |
| `nyx_approval_review` | `governance::approvals` | no (price 0, owner can set) | new | write |
| `nyx_approvals_list` | `governance::approvals` | no (price 0, owner can set) | new | read |
| `nyx_scan_secrets` | `governance::secrets` | no (price 0, owner can set) | new | read |
| `nyx_integrations_list` | `store::integrations` | no (price 0, owner can set) | new | read |
| `nyx_integration_set` | `store::integrations` | no (price 0, owner can set) | new | write |
| `nyx_integration_remove` | `store::integrations` | no (price 0, owner can set) | new | write |
| `nyx_read_file` | `security::paths` (WorkspaceJail) | no (price 0, owner can set) | exact | read |
| `nyx_list_files` | `security::paths` (WorkspaceJail) | no (price 0, owner can set) | exact | read |
| `nyx_web_search` | `sync::search` | yes, default 1 | exact | read |
| `nyx_whoami` | `profile`, `store` | no (price 0, owner can set) | new | read |
| `nyx_credits_balance` | `ledger`, `store::credits` | ledger tool (not wrapped) | exact | read |
| `nyx_credits_reserve` | `ledger`, `store::credits` | ledger tool (not wrapped) | exact | write |
| `nyx_credits_commit` | `ledger`, `store::credits` | ledger tool (not wrapped) | exact | write |
| `nyx_credits_release` | `ledger`, `store::credits` | ledger tool (not wrapped) | exact | write |
| `nyx_credits_spend` | `ledger`, `store::credits` | ledger tool (not wrapped) | exact | write |
| `nyx_credits_history` | `ledger`, `store::credits` | ledger tool (not wrapped) | new | read |

## Parity with the TypeScript MCP server and CLI

Ported with identical name and schema: `nyx_search_docs`, `nyx_read_doc`, `nyx_check_quality`, `nyx_detect_drift`, `nyx_create_doc`, `nyx_update_doc`, `nyx_delete_doc`, `nyx_list_versions`, `nyx_list_teams`, `nyx_get_team`, `nyx_create_team`, `nyx_web_search`, `nyx_read_file`, `nyx_list_files`, the five credit tools; with extra optional properties: `nyx_get_timeline`, `nyx_create_ticket`.

Intentionally dropped (removed product surfaces): `nyx_join_meeting`, `nyx_leave_meeting`, `nyx_meeting_status`, `nyx_generate_meeting_doc` (voice agent: no Rust voice module exists), and the CLI commands `chat`, `ai` agent flows, billing/Stripe, `admin`, `apikeys`, `permissions`, `features` (hosted-only concepts).

### Gaps (core capability exists or is planned, not yet exposed or not live)

- **Not exposed as tools/commands although `nyx-core` has the module**: change proposals (`vcs::proposal`), bulk ticket draft/review/post (`tickets::draft`, `tickets::review`), sprint capacity and defer (`tickets::sprint`), orchestration pipelines and locks (`tickets::orchestration`), compliance check and policy engine (`governance::compliance`, `governance::policy`; they need analyzers wired to the LLM), document intake/import and OCR (`intake`), RAG `query` (`sync::query`), document generation and AI edit flows (`ai::Advisor::generate_document`, `edit_document`, meeting quality, expand ticket), file watcher (`sync::watch`; only the one-shot `nyx_drift_check`), background scan job runner (`scan::jobs`), onboarding (`scan::onboarding`), approval-gated merge (`approval::is_approved` is not combined with `nyx_merge_branch`), notification preferences and digests, Jira/Confluence/Slack clients (`integrations`), Postgres import (`store::import`), and the TS `slash`/`registry`/`voice`/`watch`/`orchestrate`/`bulk`/`intake`/`jobs`/`sprint`/`proposals`/`query`/`check` commands.
- **Not live in `Services::live`**: Jira and Linear trackers (their credentials sit in integration config and need a per-call DB lookup), GitHub-hosted repo scans (`GitProviderSource`), provider-backed embeddings (the lexical hashing embedder is used, so search quality is lexical), keyless local model servers, per-provider model/base-URL settings (the `ProviderConfig::new` defaults are used), streaming.
- `nyx_create_ticket` needs a destination: pass `destination` or store `{"repo": "owner/name"}` / `{"projectKey": "KEY"}` with `nyx_integration_set`. The tool keeps the TS `github|jira` provider enum, so GitLab/Bitbucket/Linear destinations are not selectable even though the trackers exist.
- Single local user: the HTTP-era roles (`requireRole`), API keys and multi-tenant teams are not modelled; all callers share the owner identity (additional teams can be created and addressed with `team_id`).
- The ledger is loaded and hash-verified on every credit operation (O(entries)); fine for a local file, a checkpoint is needed past roughly 10^5 entries.
- TS tool schemas keep `team_id` required for `nyx_search_docs` and `nyx_create_doc` (schema parity); use `nyx_list_teams` to find it (the CLI defaults it).
- Model-backed commands are tested through the binaries only for the `not_configured` path; the metered success and failure paths run in `nyx-app` tests with a scripted provider. No test reaches the network, so the live transports are only covered by `nyx-net`'s own tests.

## Verification

```text
cargo fmt --check
cargo clippy -p nyx-app -p nyx-mcp -p nyx-cli --all-targets -- -D warnings
cargo test -p nyx-app -p nyx-mcp -p nyx-cli
cargo deny check
```

`crates/nyx-mcp/tests/e2e.rs` spawns the built `nyx-mcp` binary: initialize, `tools/list` schema validity, document/version/branch conflict/merge/export round trips, credit reserve/commit idempotency and exhaustion, guard rejections, protocol errors and cross-process persistence. `crates/nyx-cli/tests/cli.rs` spawns `nyx` (including `nyx mcp`). `crates/nyx-app/tests/app.rs` covers the facade directly, including metering with a scripted `FakeLlm`.
