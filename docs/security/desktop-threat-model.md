# Nyx desktop threat model (AI-77)

Scope: the Tauri 2 shell (`apps/desktop`), `nyx-core` (`crates/nyx-core`), the CLI (`nyx-cli`) and the MCP server (`nyx-mcp`). Ported from the hosted web app's security audit items; hosted-only concerns (Clerk, Stripe, multi-tenant authz, Vercel/Railway headers) are dropped with the product code. Implementation lives in `crates/nyx-core/src/security/` (docs: `docs/rust-core/security.md`).

Posture: single local user, local-first data, deny-by-default. The webview is treated as **semi-trusted** (it renders user and agent-authored content), MCP/CLI callers as **untrusted agents** acting with the user's authority but bounded by credits, rate limits and the workspace jail.

## Trust boundaries

| # | Boundary | Untrusted side | Trusted side | Controls |
|---|---|---|---|---|
| B1 | Webview to core (Tauri IPC) | Rendered content, any script that runs in the webview | Rust commands | CSP, capability allow-list, app-manifest command permissions, input validation |
| B2 | MCP / CLI to core | Agent-supplied tool arguments, prompts, file paths, URLs | Core services | `validate`, `WorkspaceJail`, `UrlPolicy`, `RateLimiter`, credit ledger |
| B3 | Core to filesystem | Paths, symlinks, files in a shared workspace | Core file API | `WorkspaceJail` (root jail, symlink-safe, size cap, atomic write) |
| B4 | Core to network | Remote hosts, DNS answers, redirects, response bodies | Core HTTP clients | `UrlPolicy` + `resolve_pinned` (DNS-rebinding aware), redirect re-check |
| B5 | Local network to local endpoint | Other local processes, browser pages hitting `127.0.0.1` | Optional HTTP MCP endpoint | `OriginPolicy`, `is_allowed_loopback_host`, rate limit |
| B6 | Secrets at rest | Disk, backups, other users | Keychain, encrypted file | OS keychain, `EncryptionKey` + AEAD envelope, `redact` |

Out of scope (accepted risk): a malicious process running as the same OS user (it can read the keychain prompt-free on some OSes and swap directories mid-operation, R-2), physical access to an unlocked machine, compromised OS or toolchain.

## STRIDE

| ID | Threat | Cat. | Boundary | Mitigation | Test |
|---|---|---|---|---|---|
| T-IPC-1 | Webview script calls a privileged command or plugin it should not reach | E | B1 | Capability `default` grants only `allow-core-hello`, updater check/install, `process:allow-restart`; no `core:default`, fs, shell, http, dialog, opener. App commands are registered in `build.rs` `APP_COMMANDS` so un-granted commands are denied | `tests/security_config.rs::capabilities_are_least_privilege`, `::every_registered_command_is_granted_and_nothing_else`; build fails on unknown permission ids |
| T-IPC-2 | XSS or injected markup executes script, eval or loads remote code | E, T | B1 | CSP: `default-src 'none'`, `script-src 'self'`, no `unsafe-eval`/`unsafe-inline`, no remote hosts, `connect-src` only Tauri IPC, `frame-ancestors/object-src/base-uri 'none'`; `freezePrototype`; asset protocol off; no remote capability origins | `security_config.rs::csp_is_strict` |
| T-IPC-3 | Rendered HTML or markdown carries script (stored XSS from documents or agent output) | T, E | B1 | `sanitize_html` allow-list (escape, never repair), `sanitize_markdown` (raw HTML escaped, link/image scheme allow-list), `is_safe_url` (control chars, entity-encoded schemes) | `sanitize::tests::*` (scripts, handlers, javascript:/data:, entity and tab tricks, quote breakout, code fences untouched) |
| T-IPC-4 | Malformed or oversized command arguments | T, D | B1, B2 | `validate::check_text/check_name/check_id`, bidi-control rejection, length caps | `validate::tests::*` |
| T-FS-1 | Path traversal (`../`, absolute, `\`, `:stream`, NUL) reads or writes outside the workspace | T, I | B3 | `WorkspaceJail::resolve` rejects lexically, then canonicalises and verifies the prefix | `paths::tests::rejects_traversal_variants` |
| T-FS-2 | Symlink or junction inside the workspace points outside (file, directory, dangling) | T, I | B3 | Deepest existing ancestor canonicalised; dangling links refused; `create_dir_all` re-verified | `paths::tests::rejects_symlink_escapes`, `::allows_symlink_that_stays_inside` |
| T-FS-3 | Hostile document title becomes a dangerous filename (reserved device names, dots, length) | T | B3 | `sanitize_filename` (port of `sanitizeFilename`, hardened for Windows) + jail on write; atomic temp-file rename | `validate::tests::filenames`, `paths::tests::reads_and_writes_inside` |
| T-FS-4 | Huge file read exhausts memory | D | B3 | `with_max_read_bytes` (default 16 MiB), regular files only | `paths::tests::read_cap_and_kind` |
| T-NET-1 | SSRF: agent or document makes the app fetch loopback, LAN, link-local or cloud metadata | I, E | B4 | `UrlPolicy::strict` (https only, public IPs only, no userinfo, internal suffixes and single-label hosts refused); metadata endpoints blocked even when loopback/private are allowed | `ssrf::tests::ipv4_ranges`, `::url_gate_basics`, `::loopback_policy_opt_in_but_metadata_never` |
| T-NET-2 | Address-spelling bypass: decimal/hex/octal/short IPv4, IPv4-mapped/compatible, NAT64, 6to4, Teredo | E | B4 | `url` crate WHATWG normalisation, then `classify_ip` unwraps embedded IPv4 | `ssrf::tests::ipv6_ranges_and_embedded_v4`, `::obfuscated_ipv4_spellings_are_normalised_and_blocked` |
| T-NET-3 | DNS rebinding / multi-A trick: name resolves public at check time, private at connect time | E | B4 | `resolve_pinned` requires every answer to pass and returns the vetted `SocketAddr`s; the client must connect to those, not re-resolve | `ssrf::tests::dns_pinning_requires_all_answers_public` |
| T-NET-4 | Open redirect chain into internal host or https downgrade | E | B4 | `check_redirect` re-runs the policy per hop, max 3 hops, no downgrade | `ssrf::tests::redirects_are_rechecked` |
| T-NET-5 | Update channel tampering | T | B4 | Updater signature verification (`pubkey`, `docs/release/signing-setup.md`); endpoint is a fixed GitHub release URL | Manual release checklist (placeholder pubkey must be replaced before release) |
| T-LOC-1 | Browser page or local process abuses the local HTTP endpoint (CSRF, DNS rebinding to `127.0.0.1`) | S, E | B5 | `OriginPolicy` exact-origin allow-list (never `*`, never reflects), `Host` check for loopback; endpoint binds loopback only | `origin::tests::*` |
| T-LOC-2 | Agent floods MCP/CLI endpoint (CPU, credit burn, disk) | D | B2 | `RateLimiter` fixed window per caller id (web default 200/min), bounded key table, allow-list for health | `ratelimit::tests::*` |
| T-SEC-1 | Stored API keys or integration tokens readable from disk | I | B6 | OS keychain via `SecretStore`; fallback Argon2id+ChaCha20-Poly1305 file; `EncryptionKey::derive` (HKDF-SHA256, per-purpose context) + `seal/open` with AAD, random nonce, zeroise on drop | `crypto::tests::*` (HKDF RFC 5869 vector, tamper, wrong key/context/AAD, generic errors) |
| T-SEC-2 | Secrets leak into logs, errors or crash reports | I | B6 | `redact_text`/`redact_json`/`Redacted<T>`, `public_error_message` (first line, redacted, capped) | `redact::tests::*`, `validate::tests::public_errors_hide_details` |
| T-SEC-3 | Dev bypass flags or placeholder secrets reach a release build | E | all | `config::validate_environment` at start-up: bypass flags fatal in release, short/placeholder secrets refused, wildcard CORS refused | `config::tests::*` |
| T-SEC-4 | Inbound callback forged (webhook-style) | S | B5 | `verify_hmac_sha256_hex`, constant time, mandatory in every environment (no dev bypass, per #260). The desktop app exposes no webhook listener today | `crypto::tests::hmac_rfc4231_case_2_and_verify` |
| T-REP-1 | Agent denies or disputes spend; ledger rewritten | R, T | B2 | Append-only credit ledger with idempotency (see `docs/credits/utility-tokens-spec.md`, `ledger.rs`) | `tests/ledger.rs` |

STRIDE legend: S spoofing, T tampering, R repudiation, I information disclosure, D denial of service, E elevation of privilege.

## Mapping: repo audit (`docs/oss/repo-audit.md`)

| Finding | Relevance to the desktop app | Mitigation / status |
|---|---|---|
| 1 db-backup workflow uploads prod dumps | Repo hygiene, not runtime | Tracked by the AI-50 follow-ups (delete workflow and artifacts). Desktop has no server DB. |
| 2 `GH_PAT` admin PAT in workflow | CI | Same; not in scope of this code. |
| 3 Claude workflow tokens on public repo | CI | Same. |
| 4 Hardcoded prod hosts in CSP, CORS, MCP URL | Direct: desktop CSP no longer names any host; `OriginPolicy` takes explicit origins | `tauri.conf.json` CSP, `origin.rs`; updater endpoint is the only fixed URL. |
| 5, 6, 10, 11, 12 internal docs, videos, personal info | Repo hygiene | Not code; AI-50 checklist. |
| 7, 8 publishable key / GA ID in history | Analytics and ad-tech | Desktop CSP forbids third-party script and connect hosts (T-IPC-2); no analytics in core. |
| 9 `.env.example` | Config surface | `config::validate_environment` documents and enforces the variables that matter. |
| 13 test-mode key guard in `config.ts` | Placeholder keys in production | Ported: `is_placeholder_secret` (`sk_test_*`, `REPLACE_WITH*`, ...). |
| 14, 15, 16 fixtures, local creds, git identities | Info | Redaction patterns derive from the fixture shapes and are tested with synthetic values. |
| Rotation list (Clerk, Stripe, OAuth secrets, `ENCRYPTION_SECRET`) | Hosted secrets | Do not exist in the desktop app; keys live in the OS keychain (T-SEC-1). Rotate hosted ones per the audit. |

## Mapping: TypeScript security items

| TS item | Source | Rust mitigation | Status |
|---|---|---|---|
| AES-256-GCM, HKDF `nyx-salt`, per-purpose info | `lib/encryption.ts`, `services/encryption.service.ts` | `security::crypto` (ChaCha20-Poly1305 already in tree, same HKDF shape, contexts `nyx-integration-encryption` / `nyx-byok-encryption`) | Ported. Not wire-compatible with old blobs (no data to migrate in a local-first app). |
| Prod-only config guards (`superRefine`), `DEV_AUTH_BYPASS` fatal (#263), `sk_test_` rejection | `lib/config.ts`, `middleware/auth.ts` | `security::config` | Ported; Clerk keys dropped. |
| Sanitised API errors (#263) | `apps/web/src/lib/api.ts` | `validate::public_error_message` | Ported. |
| `DOMPurify` allow-list `pre code span div br` (#258) | `MarkdownPreview.tsx` | `sanitize::HtmlPolicy::code_highlight` | Ported; `style` attribute intentionally dropped. |
| Redirect validation `startsWith('https://') && includes('slack.com')` (#262) | `SlackIntegration.tsx`, `Settings.tsx` | `UrlPolicy::with_hosts` (exact or subdomain match) | Replaced: the TS substring check is bypassable (`https://evil.io/slack.com`); Stripe half dropped with Stripe. |
| CSP via helmet, HSTS (#261, #282) | `app.ts`, `index.html` | Tauri CSP (above); HSTS is N/A (no HTTP origin) | Ported/adapted. |
| Rate limiting 200/min per user or IP, health allow-list (#255, #283) | `app.ts`, per-route `config.rateLimit` | `ratelimit::RateLimiter` (+ per-tool limiters by instantiating more) | Ported; per-route tiers become per-tool limiter instances at wiring time (AI-74). |
| CORS allow-list incl. regex entries | `lib/cors.ts` | `origin::OriginPolicy` | Ported; regex entries replaced by `https://*.suffix` (regex on a security boundary is a footgun). |
| Webhook signature always required (#260) | `routes/webhooks.ts` | `crypto::verify_hmac_sha256_hex` | Helper only; no listener exists. |
| `sanitizeFilename` | CLI export (swarm-notes 136) | `validate::sanitize_filename` | Ported, Windows-hardened. |
| Remote script loading (unpkg UMD in JSX preview, #341) | removed feature | CSP forbids remote script | Feature removed; regression-proof via CSP test. |
| Approval gate for destructive actions | `middleware/approval-gate.ts` | n/a | Not ported: team approval workflow, multi-user. Revisit as a user-confirm prompt in the wiring wave. |
| Role/permission middleware, team authz | `middleware/auth.ts`, `permissions.ts` | n/a | Dropped: single local user. |
| API key hashing upgrade (deferred in #263) | `middleware/auth.ts` | n/a | No API keys issued; MCP/CLI use local process trust. |

## Residual risks and follow-ups

- R-1 Wiring: none of the guards protect anything until AI-74 routes MCP/CLI/Tauri commands through them. Each file or URL argument MUST go through `WorkspaceJail` / `UrlPolicy`; reviewers should reject direct `std::fs` / `reqwest` use on caller input.
- R-2 TOCTOU: jail checks are path-based; a same-user process swapping a directory for a symlink between resolve and open can still win. Mitigated by atomic temp-file writes, not eliminated. A `cap-std`/`openat2` based backend is the upgrade path.
- R-3 Redaction is regex-based and will miss unknown token formats; keep secrets out of log call sites.
- R-4 Tauri `isolation` pattern is not enabled (needs a bundled isolation page); the UI currently has no bundler. Enable when a frontend build exists.
- R-5 `withGlobalTauri` stays `true` because the placeholder UI uses `window.__TAURI__`; switch to the npm API and set it to `false` with the real frontend.
- R-6 Updater `pubkey` is still a placeholder (T-NET-5); release must not ship before it is set.
- R-7 Rate limiter is in-memory per process; the CLI and MCP processes do not share a budget.
