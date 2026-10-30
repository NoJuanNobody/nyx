# nyx-core `security` module (AI-77)

Ported from the web security audit. Threat model and finding mapping: `docs/security/desktop-threat-model.md`. All modules are pure and deny-by-default; nothing here touches the network and none of it is wired into MCP/CLI/Tauri yet (AI-74).

| Module | Public API | TS source |
|---|---|---|
| `validate` | `check_text`, `check_name`, `check_id`, `sanitize_filename`, `public_error_message` | `sanitizeFilename`, zod limits, #263 |
| `paths` | `WorkspaceJail::{new, resolve, read, read_to_string, write, create_dir_all}` | export filename handling |
| `ssrf` | `UrlPolicy::{strict, allow_loopback_http, with_hosts, check_url, resolve_pinned, check_redirect}`, `Resolver`, `classify_ip` | #262 redirect checks, outbound fetches |
| `sanitize` | `HtmlPolicy`, `sanitize_html`, `MarkdownPolicy`, `sanitize_markdown`, `is_safe_url`, `escape_html` | DOMPurify, #258 |
| `ratelimit` | `RateLimiter::{new, with_allow_list, check, check_now}`, `Decision` | `@fastify/rate-limit`, #255, #283 |
| `origin` | `OriginPolicy`, `is_allowed_loopback_host` | `lib/cors.ts` |
| `crypto` | `EncryptionKey::{derive, generate}`, `seal`, `open`, `seal_str`, `open_str`, `verify_hmac_sha256_hex` | `lib/encryption.ts`, `encryption.service.ts`, #260 |
| `redact` | `redact_text`, `redact_json`, `Redacted<T>` | audit patterns, `config.ts` guards |
| `config` | `validate_environment`, `is_placeholder_secret` | `lib/config.ts`, `middleware/auth.ts` |

## Usage rules for callers

- Files: build one `WorkspaceJail` per workspace and use only its `read*/write/create_dir_all`. Never pass caller paths to `std::fs`.
- URLs: `UrlPolicy::resolve_pinned(url, &SystemResolver)` then connect to `PinnedTarget::addrs` only (set `Host`/SNI from the URL). Follow redirects manually via `check_redirect`. Local model servers: `UrlPolicy::allow_loopback_http()`; cloud metadata stays blocked.
- Rendering: sanitize with `sanitize_markdown` before markdown to HTML, then `sanitize_html(..., &HtmlPolicy::rich_text())` on the HTML; code highlighter output uses `HtmlPolicy::code_highlight()`.
- Start-up: call `config::validate_environment(!cfg!(debug_assertions), |k| std::env::var(k).ok())` and abort on error.
- Secrets: derive keys from keychain-held high-entropy material (not passphrases; those use Argon2 in `profile`). Always pass an AAD naming the record (`"integration:<id>"`).

## Tauri config (`apps/desktop/src-tauri`)

- `tauri.conf.json`: strict object-form CSP, `freezePrototype`, asset protocol off, only the `default` capability enabled.
- `capabilities/default.json`: `allow-core-hello`, `updater:allow-check`, `updater:allow-download-and-install`, `process:allow-restart`.
- `build.rs`: `APP_COMMANDS` registers app commands in the Tauri app manifest so each needs an explicit `allow-<command>` grant. New commands: add to `generate_handler!`, `APP_COMMANDS` and the capability file; `tests/security_config.rs` fails if they drift.

## Parity gaps

- Not wire-compatible with TS AES-256-GCM blobs (ChaCha20-Poly1305 chosen because it is already in the tree). No legacy decryptor.
- No approval-gate, role/permission middleware or API-key auth (hosted/multi-user concepts).
- HTML sanitiser is a purpose-built allow-list escaper, not a full HTML5 parser; it is stricter than DOMPurify (unknown or malformed markup becomes text) and drops `style`. Entity handling is pass-through for well-formed entities.
- Jail is path-based (TOCTOU residual, see threat model R-2). Windows junction and reserved-name behaviour is untested on CI (unix symlink tests only).
- Rate limiting is fixed-window (like `@fastify/rate-limit` default), allowing up to 2x burst at a window edge.
- Tauri `isolation` pattern and a real `SystemResolver`-backed HTTP client are not included; the SSRF guard returns vetted addresses for the future HTTP layer to pin.
