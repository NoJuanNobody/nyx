# Network edge: `nyx_core::net` and `nyx-net`

`nyx-core` opens no sockets. Everything network-shaped builds an `HttpRequest` (plain data), hands
it to an `HttpTransport` and parses the `HttpResponse`. This page covers the unified seam in core
and the live implementation in the new `nyx-net` crate.

## 1. One transport seam: `nyx_core::net`

Before this change there were two copies (`ai::transport` and `git_provider::transport`) with
different shapes (string vs byte body, no response headers on one, no PUT on the other). Now:

| Item | Notes |
| --- | --- |
| `HttpMethod` | `Get`, `Post`, `Put`, `Patch`, `Delete`, `as_str()` |
| `Headers` | case-insensitive; `get`, `push`, `remove`, `retry_after_secs()` (delta-seconds and HTTP-date) |
| `HttpRequest` | `method`, `url`, `headers`, `body: Option<Vec<u8>>`, `timeout_secs: Option<u64>`; builders `new`, `header`, `json`, `with_body`, `with_timeout`; getter `header_value`. `Debug` redacts `authorization`, `x-api-key`, `proxy-authorization`, cookies and any `*token*` header (`net::is_sensitive_header`) |
| `HttpResponse` | `status`, `headers`, `body`; `text()`, `json()`, `retry_after_secs()` |
| `NetError` | `Transport`, `Blocked` (policy), `TooLarge`, `Parse`, `Exhausted` (fake ran dry) |
| `HttpTransport` | `fn send(&self, &HttpRequest) -> Result<HttpResponse, NetError>`; non-2xx is **not** an error |
| `FakeTransport` | scripted queue + request log: `push`, `push_json(status, headers, body)`, `push_text(status, body)`, `push_error`, `requests()` |

`ai::transport` and `git_provider::transport` are now one-line re-exports (`Method` is an alias of
`HttpMethod`), so old imports compile. `NetError` converts into `GitError`, `LlmError`,
`IntegrationError` and `crate::Error`, so `?` keeps working at every call site.

Source-visible changes for callers: the request-header *getter* is `header_value(name)` (the
builder keeps `header(name, value)`); FakeTransport's two-argument `push(status, body)` of the old
`ai` copy is `push_text`; `HttpRequest.body` is bytes and `timeout_secs` is optional.

## 2. One `Embedder`: `nyx_core::ai::embedder`

`sync::retrieval::Embedder` and `scan::embed::Embedder` were two traits with different error types.
There is now one (the scan shape, with `max_batch()` and `EmbedError::{Transient, Permanent}`),
re-exported from `ai`, `scan` and `sync`. `EmbedError` converts to `crate::Error`, so sync code
using `?` is unchanged.

- `HashingEmbedder`: offline feature hashing (moved from `sync`), the default everywhere.
- `FakeEmbedder`: stays in `scan::embed` (failure injection, batch log).
- `HttpEmbedder`: OpenAI-compatible `/embeddings` over `Arc<dyn HttpTransport>`. Pure
  `build_embeddings_request` / `parse_embeddings_response` with fixtures
  (`src/ai/fixtures/embeddings_*.json`). Errors: 429, 5xx and transport failures are transient;
  other statuses and malformed bodies are permanent. **Constructor change:** it takes an
  `Arc<dyn HttpTransport>` instead of `&dyn HttpTransport`.

## 3. `nyx-net`

Workspace member `crates/nyx-net`, depends on `nyx-core`. New dependencies: `ureq 3.5` (rustls +
ring, embedded Mozilla roots, no default features), which adds `ureq`, `ureq-proto`, `utf8-zero`,
`webpki-roots` to `Cargo.lock` (rustls, ring, http, httparse were already there via Tauri).
`cargo deny check` passes with **no change to `deny.toml`** (webpki-roots is CDLA-Permissive-2.0,
already allowed). `ureq`'s resolver/connector hooks are explicitly unversioned and changed between
3.4 and 3.5, hence the `~3.5` pin.

### `UreqTransport` (`nyx_net::transport`)

| Concern | Behaviour |
| --- | --- |
| SSRF | `UrlPolicy::strict()` on the request URL and on **every redirect target**: https only, no userinfo, public addresses only, no internal names, optional host allow-list (`NetConfig::allowed_hosts`). Violations are `NetError::Blocked`, raised before a socket is opened |
| DNS pinning | `ureq` is built with a custom resolver that calls `UrlPolicy::resolve_pinned`: every answer must pass and those exact addresses are the ones connected to (no second lookup). An unvetted host cannot resolve (fail closed). DNS lookups have a deadline |
| Redirects | followed by us, not `ureq`: max 3, no https to http, 301/302/303 become body-less GET, 307/308 replay method and body but never to another origin (`Blocked`). Different scheme, host or port = different origin: `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `*token*` headers are dropped |
| Timeouts | per-hop connect timeout (10 s) and one overall deadline across hops: the request's `timeout_secs`, else 60 s |
| Size cap | 16 MiB default; `Content-Length` over the cap is refused unread, unframed or lying streams are cut at the cap (`TooLarge`) |
| User-Agent | `nyx/<version>` unless the request sets its own |
| Retry-After | response headers are preserved; `HttpResponse::retry_after_secs()` reads seconds or an HTTP-date. 429/503 are normal responses, retry policy stays in the callers (`integrations::http::Http`) |
| Proxy | `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` + `NO_PROXY` honoured (`NetConfig::use_env_proxy`) |
| Errors | never contain request headers or the URL query |

**Test-only loopback.** The guard blocks loopback by design. The tests need a mock server on
`127.0.0.1`, so `UreqTransport::allow_loopback_for_tests` exists, `pub(crate)` and `#[cfg(test)]`:
it is compiled out of every non-test build, and no config, feature flag or public API can switch
the guard off. The tests (32) cover redirects, header stripping, body replay rules, size cap,
timeouts, `Retry-After`, the production transport refusing loopback / metadata / private / odd
schemes without ever reaching the server, and the resolver's vetting.

### `LoopbackListener` (`nyx_net::oauth`)

Implements the new `integrations::oauth::CallbackReceiver` trait (`redirect_uri()`,
`wait_for_code(state, timeout)`). Binds `127.0.0.1:0`, one-shot, validates with
`oauth::parse_callback` (constant-time state compare, provider `error=`), serves a static "you can
close this tab" page (or a static failure page) with `no-store`, `no-referrer` and
`default-src 'none'`. Nothing from the request is echoed. Other requests (404 wrong path, 405 not
GET, 400 foreign `Host`) are answered but do not consume the flow; a state mismatch does (start a
new sign-in). Silent clients cannot hold it past the deadline.

### `live_services()` (`nyx_net::services`)

Returns `LiveServices { transport, embedder }` plus constructors that share the transport:
`with_http_embedder`, `llm(config, secrets)`, `web_search(key)`, `linear_tracker(key)`.
`nyx-app` already defines its own `Services`, and `nyx-net` must not depend on it, so this is a
thin bundle the orchestrator maps onto it (mapping table in the module docs). Nothing reads
secrets at construction.

## Reconciling with `nyx-app` (AI-74), for the orchestrator

- `TrackerKind::ticket_provider()` now returns `TicketProvider`, not `Option`. `nyx-app`
  `ops/tickets.rs` does `.ticket_provider().ok_or_else(..)?`: drop the `ok_or_else`.
- `scan::Embedder` and `sync::Embedder` are the same trait now. `nyx-app`'s `ScanEmbedder` adapter
  in `ops/scan.rs` compiles still but is redundant: pass `Arc<dyn Embedder>` straight through.
- `GitTreeEntry` has a new `sha` field: struct-literal constructions need `sha: None`.

## Gaps (honest list)

- **Never run against a live service.** Everything is tested against a local mock server and
  fixtures. No real TLS handshake is exercised by the tests (the mock is plain http); rustls is
  `ureq`'s, not ours.
- **No local model servers.** `http://localhost:11434` (Ollama) is refused by design. Supporting it
  needs an explicit owner decision (for example a per-port opt-in in settings), not a flag here.
- **Through a proxy, no DNS pinning** (the proxy resolves the target); only syntactic checks apply.
  The proxy itself is trusted configuration.
- **TLS trust = embedded Mozilla roots only.** A TLS-intercepting corporate proxy or a private CA
  fails. The `platform-verifier` feature would fix it at the cost of more dependencies.
- **No HTTP/2, no cookie jar, no response decompression** (no `Accept-Encoding` sent), no streaming
  responses (whole body in memory up to the cap), no client certificates.
- **DNS resolution can race the OS**: the vetted addresses are used for the connection, but a
  hostname is looked up once per hop with `getaddrinfo` on a helper thread; a timed-out lookup
  leaves that thread running until the OS gives up.
- **Retry policy is not in the transport.** Callers decide (`integrations::http::Http` retries
  429/503; the LLM and git clients surface the status).
- `OAuth` listener: IPv4 loopback only (`127.0.0.1`), per RFC 8252; a provider that only allows
  `localhost` redirect URIs needs a decision. Slack still needs its https relay (see
  `integrations.md`).
- Windows/macOS/Linux behaviour of the listener and transport was only exercised on macOS.
