# AI providers and Advisor (`nyx-core::ai`)

Ticket AI-75. Rust port of the non-chat AI surface. No agent loop, no chat, no Nyx-hosted key.

## Module map

| Rust (`crates/nyx-core/src/ai/`) | TS source | Notes |
|---|---|---|
| `provider.rs` | `lib/llm.ts` (client type), `generateComplete` in `ai.service.ts` | Shared `LlmProvider` trait (sync; `complete`, optional `complete_stream`), `FakeLlm`, `complete_full` (max_tokens continuation, 6 retries) |
| `wire.rs` | OpenRouter adapter in `lib/llm.ts` | Pure Anthropic Messages + OpenAI-compatible builders/parsers (serde types). `length` maps to `MaxTokens` |
| `transport.rs` | - | Re-export of the canonical `crate::net` seam (`HttpTransport`, `FakeTransport`, `HttpRequest`/`HttpResponse`; `Method` = `HttpMethod`). Live impl: `nyx-net` (see `net.md`) |
| `embedder.rs` | `embedding.service.ts` | The one `Embedder` trait (+ `EmbedError`), `HashingEmbedder`, OpenAI-compatible `HttpEmbedder` with fixtures in `src/ai/fixtures/` |
| `config.rs` | `routes/ai-keys.ts`, provider switch in `llm.ts` | `ProviderKind` (anthropic, openai, openrouter, ollama, openai-compatible), `ProviderConfig` (no secrets), `ByokKeys` add/rotate/remove/status over `profile::SecretStore`, `select_provider`, `normalize_model_slug` |
| `client.rs` | - | `HttpLlm` = config + `SecretStore` + `HttpTransport`; key read per call so rotation is immediate (replaces `teamClientCache`/`invalidateTeamClient`) |
| `models.rs` | `routes/models.ts` | OpenRouter catalog normalise, fallback list, 1h cache, `parse_params_b` |
| `prompts.rs` | `ai.service.ts` | Embedded prompt consts + builders (`Prompt` = system, messages, max_tokens, tier) |
| `parse.rs` | `ai.service.ts` | Tolerant parsers with the TS fallbacks; fences, prose wrapping, truncated arrays |
| `advisor.rs` | `ai.service.ts` | `Advisor`: spec quality, drift, ticket-from-diff, generate/edit document, change analysis, missing sections, decision weight, meeting quality/apply, seed next stage, bulk tickets, expand ticket, bootstrap/module/merge docs, notification reply |
| `quality.rs` | `AIQualityPanel.tsx`, `AIAdvisor.tsx` | Score bands (>=7 good, >=4 needs improvement) and `QualityGate` (GH #130) |
| `insights.rs` | `claude-insights.service.ts` | `parse_claude_comment`, `is_claude_comment`, `latest_insight` (pure half) |
| `store.rs` + `migrations/0175_ai.sql` | `team_ai_keys`, `ai_usage_log`, `ticket_suggestions` | `ai_provider_configs` (no keys), `ai_usage_log` + summary, `ticket_suggestions` lifecycle |

## BYOK design

- Keys live only in `profile::SecretStore` at `<provider>/api-key`. `ProviderConfig`, `KeyStatus`, `HttpRequest` and `HttpLlm` implement `Debug`/`Serialize` without key material; `HttpRequest` redacts `Authorization`/`x-api-key`. `KeyStatus` exposes only the last four characters (the old `keySuffix`).
- `select_provider(configs, active, store)`: an explicit active provider without a key is an error, never a silent switch to another vendor (that would send documents somewhere the user did not choose). With no active provider, first usable in order anthropic, openrouter, openai, ollama, openai-compatible.
- Ollama needs no key. `openai-compatible` requires `base_url`.

## Usage

```rust
let cfg = ProviderConfig::new(ProviderKind::Anthropic);
let llm = HttpLlm::new(cfg.clone(), secrets, transport)?;   // transport: your HttpTransport
let models = cfg.models();
let q = Advisor::new(&llm, &models).analyze_spec_quality(&doc, Some("definition"))?;
let verdict = QualityGate::default().check(&q);
```

## Gaps vs the TS service (honest list)

- **Real transport lives in `nyx-net`** (`ureq` + rustls, SSRF-guarded); `nyx-core` still links no HTTP stack. The strict guard refuses loopback, so a local Ollama (`http://localhost:11434`) does not work through it by design; that needs an owner decision (see `net.md`).
- **Streaming**: trait method exists with a one-chunk default; no SSE implementation yet (TS only streamed for the RAG query path, which is out of scope).
- **Not ported**: `generateSuggestions` (AI chat panel chips), `generateNewsArticle` (marketing toy), `routes/ai.ts` grounded retrieval (`codeEmbeddingService`; the Advisor takes `CodeFile`s, the caller retrieves), rate limits (`20/min`; local single user), `resolveTeamModels` (per-team model prefs; replaced by `ProviderConfig.model/fast_model`), platform key fallback and team keys.
- **Not ported (GitHub half)**: `claudeInsightsService.refreshForTicket` / webhook handler fetch comments from GitHub; that needs `GitProvider` (AI-66). Feed comments to `insights::latest_insight` and store with `TicketRepo::update(.., insights)`.
- **Suggestions**: `SqliteSuggestions` covers create/list/update/expand/approve/dismiss state. Creating the ticket on approve, `generateSuggestions(documentId)` (needs document versions) and folder-level suggestions are orchestration the wiring layer composes from `Advisor` + `DocumentRepo` + `TicketRepo`. `bulkApprove`'s 500 ms rate-limit sleep is the caller's concern.
- **Parallelism**: bulk ticket expansion is sequential (TS used `Promise.all`).
- **Stricter parsing than TS**: scores are clamped to 0-10 and decision-weight signals to 0-20; partial JSON objects get field defaults instead of passing through `undefined`; truncated ticket arrays are salvaged from the whole tail (TS lost the salvage when a label list closed after the last full object).
- **Model slug migration** (`normalize_model_slug`, #448/#471) is a conservative heuristic (anthropic/openai prefixes, dotted versions), not a lookup table.
- **Credits**: metering AI calls through the credit ledger belongs to the MCP/CLI wiring (AI-74); `UsageSink` / `ai_usage_log` provide the token counts.
- `Provider::Other("ollama")` etc. are used for secret slugs; no change to `profile::secrets`.

## Migration note for the orchestrator

`0175_ai.sql` is registered as `CORE_MIGRATIONS` version 175. The existing test `tests/migrations.rs::extra_migrations_extend_core_and_foreign_keys_are_on` registers an *extra* migration with version 100, which is now below the core maximum and fails ("strictly increasing"). Any sibling that follows the "100+NN" convention breaks it the same way; bump that test's version (e.g. to 9000) once when merging.
