//! Desktop security hardening, ported from the web security audit (AI-77).
//!
//! Every submodule is pure (no global state, no network): callers in the CLI,
//! MCP server and Tauri shell compose them. Deny-by-default throughout.
//!
//! | Module | Purpose | TS source |
//! |---|---|---|
//! | [`validate`] | Text/id/name validation, filename sanitising | `sanitizeFilename`, zod schemas, API error sanitising (#263) |
//! | [`paths`] | [`WorkspaceJail`]: traversal- and symlink-safe file access | export filename handling |
//! | [`ssrf`] | Outbound URL guard, DNS-rebinding aware | `llm.ts` / integration fetches |
//! | [`sanitize`] | HTML allow-list sanitiser, markdown URL policy | DOMPurify in `MarkdownPreview` (#258) |
//! | [`ratelimit`] | Keyed fixed-window limiter for the local endpoint | `@fastify/rate-limit` in `app.ts` |
//! | [`origin`] | Origin / Host allow-list (CSRF + DNS rebinding on loopback) | `lib/cors.ts` |
//! | [`crypto`] | AEAD sealing with HKDF-derived keys | `lib/encryption.ts`, `encryption.service.ts` |
//! | [`redact`] | Secret redaction for logs and error text | `config.ts` placeholder guards, audit patterns |
//! | [`config`] | Refuse insecure runtime flags in release builds | `config.ts` `superRefine`, `DEV_AUTH_BYPASS` guard |

pub mod config;
pub mod crypto;
pub mod origin;
pub mod paths;
pub mod ratelimit;
pub mod redact;
pub mod sanitize;
pub mod ssrf;
pub mod validate;

pub use crypto::{open, seal, verify_hmac_sha256_hex, EncryptionKey};
pub use paths::WorkspaceJail;
pub use ratelimit::{Decision, RateLimiter};
pub use redact::{redact_json, redact_text};
pub use ssrf::{UrlPolicy, UrlTarget};
