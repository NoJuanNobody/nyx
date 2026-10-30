# Git provider integration (AI-66)

Rust port of the GitHub / GitLab / Bitbucket integration. Module: `crates/nyx-core/src/git_provider/`.

## Layout

| File | Contents |
| --- | --- |
| `mod.rs` | `GitProvider` trait (owned by AI-66), normalised types, `GitError`, `ProviderKind`, `new_provider` |
| `transport.rs` | Re-export of `crate::net` (`HttpTransport`, `HttpRequest`/`HttpResponse`/`Headers`, scripted `FakeTransport`) |
| `github.rs`, `gitlab.rs`, `bitbucket.rs` | Pure request builders + response parsers (serde) + a provider struct per host |
| `webhook.rs` | Signature verification and normalised event parsing (push, issues, issue comment) |
| `pagination.rs` | `Link` header and Bitbucket `next` pagination, cross-origin guard, `fetch_pages` |
| `rate_limit.rs` | Rate-limit header parsing for all three hosts |
| `util.rs` | Percent-encoding, HMAC-SHA256 (RFC 4231 tested), constant-time compare, patch line counts |

Providers are synchronous and take an `Arc<dyn HttpTransport>` plus an `Arc<dyn SecretStore>`. The access token is read
per call from `SecretKey::access_token(..)` (GitHub: `Provider::GitHub`; GitLab/Bitbucket: `Provider::Other("gitlab"|"bitbucket")`),
never cached or logged. `HttpRequest`'s `Debug` redacts `Authorization`.

## Webhooks

- GitHub: `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, raw body), constant-time compare (port of `verifyGitHubSignature`).
- GitLab: `X-Gitlab-Token` equals the shared secret (constant-time).
- Bitbucket Cloud: `X-Hub-Signature` HMAC-SHA256 when the hook was created with a secret.
- `peek_repo_full_name` + `find_verified_secret` support the TS per-integration secret lookup (caller supplies the candidate secrets from the integrations store).
- Always verify against the raw bytes, not re-serialised JSON.

## TS source mapping

| TS | Rust |
| --- | --- |
| `git-provider.interface.ts` | `GitProvider` trait + types in `mod.rs` |
| `github.service.ts` list/tree/content/issues/webhooks/oauth/user/createRepo | `github.rs` |
| `github.service.ts` `handlePushWebhook` | `webhook::parse_github` (`WebhookEvent::Push`, de-duped `changed_files`) |
| `gitlab.service.ts` (incl. self-hosted `baseUrl`) | `gitlab.rs` (`GitLabProvider::new(.., Some(base_url))`) |
| `bitbucket.service.ts` | `bitbucket.rs` |
| `routes/webhooks.ts` signature check + issue status mapping | `webhook.rs` (`IssueStatus::from_action`) |
| `*TokenExpiredError`, 403 rate-limit branch, 404 messages | `GitError::{Unauthorized, RateLimited, NotFound}` (messages preserved) |

New vs TS: commits list, per-commit diffs, branch creation, PR/MR creation, GitLab/Bitbucket webhook parsing, pagination, rate-limit parsing.

## Deliberate deviations / parity gaps

- Dropped: GitHub Projects v2 GraphQL helpers (`listProjects`, `getProjectItems`, `updateProjectItemStatus`), `getGitHubTokenForTeam` (DB lookup; replaced by the `SecretStore`), and the route's drift detection / audit / codebase-scan side effects (those belong to other modules; the route only needs `parse_webhook`).
- GitHub `listIssues` drops pull requests (GitHub returns them from `/issues`); the TS did not.
- Webhook registration subscribes to push + issues + issue comments on GitHub/GitLab (TS: GitHub push only, GitLab push + issues) because the parser handles them. Bitbucket hooks now send a `secret` (TS relied on URL tokens).
- Bitbucket tree listing passes `max_depth=20` so it is recursive (TS listed the root only).
- Lists follow pagination up to 10 pages (TS fetched one page of 100).
- GitHub tree responses flagged `truncated` (very large repos) are not paged; GitHub commit-detail `files` is capped at 300 by the API and not paged.
- Bitbucket push payloads carry no per-file lists, so `PushEvent::changed_files` is empty there; Bitbucket issues ignore labels.
- GitLab `Provider` has no dedicated variant in `profile::Provider`; `Other("gitlab")` is used (no change to the profile module).

## TODO

- The real transport is `nyx-net::UreqTransport` (TLS, timeouts, redirects with credential stripping). Tests never touch the network.
- `GitTreeEntry::sha` carries the git blob id for GitHub (`sha`) and GitLab (`id`); Bitbucket Cloud's `src` listing exposes none, so it is `None` there and scans fall back to content hashing.
- Expose through MCP/CLI/Tauri (AI-74); unify with any `GitProvider` stubs other modules defined locally.
