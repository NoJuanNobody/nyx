# Jira, Confluence and Slack integrations (AI-71)

Rust port of `atlassian.service.ts`, `jira.service.ts`, `slack.service.ts`, `routes/integrations/atlassian.ts` and
`routes/slack.ts`. Module: `crates/nyx-core/src/integrations/`. `social-publish.service.ts` is skipped: it is a stub
that returns mock post URLs, not an integration.

## Layout

| File | Contents |
| --- | --- |
| `mod.rs` | `IntegrationError` (-> `crate::Error`), re-exports of the shared transport types |
| `http.rs` | `Http` = transport + `RetryPolicy` + `Sleeper`; `Retry-After` handling; status classification |
| `oauth.rs` | PKCE (S256), state, loopback redirect URI + `parse_callback`, `PendingAuths` (10 min, one-time), refresh window |
| `atlassian/oauth.rs` | authorise URL, exchange/refresh/revoke requests, token + accessible-resources parsers, `begin_/complete_authorization` |
| `atlassian/connection.rs` | `AtlassianMeta` in `store::integrations` (type `jira`), tokens in `SecretStore`, `valid_session` (refresh), `disconnect` |
| `atlassian/jira.rs` | Jira REST v3 builders + parsers + `JiraClient` |
| `atlassian/confluence.rs` | Confluence REST v2 builders + parsers + `ConfluenceClient` (spaces, pages, labels, import) |
| `atlassian/adf.rs` | Markdown -> ADF (`text_to_adf`), `parse_inline_marks`, `adf_to_text` (exact port of the TS algorithm) |
| `atlassian/storage.rs` | Markdown -> Confluence storage format via pulldown-cmark (code macro, tables, escaping) |
| `atlassian/webhook.rs` | Jira webhook HMAC check and payload -> `JiraWebhookAction` |
| `slack/api.rs` | `chat.postMessage`, `conversations.list`, `auth.test`, `response_url` replies, `SlackClient` |
| `slack/blocks.rs` | Block Kit builders with Slack length limits, `escape_mrkdwn` |
| `slack/events.rs` | `X-Slack-Signature` verification (+5 min replay window), Events API + slash command parsing, routing rules |
| `slack/oauth.rs` | install URL, `oauth.v2.access` request/parser |
| `slack/store.rs` | `slack_connections` repo (migration 0171); bot token goes to the secret store |

## Public Jira API (for the AI-69 ticket tracker)

Pure builders/parsers (own the transport): `jira::create_issue_request(&JiraAuth, &NewIssue)`,
`jira::search_request(&JiraAuth, &SearchQuery)`, `update_issue_request`, `transition_request`, ... with matching
`parse_created`, `parse_search`, `parse_issue`, ...

Or the client: `JiraClient::new(Http, JiraAuth)` with `create_issue(&NewIssue) -> CreatedIssue`,
`search_issues(&SearchQuery) -> SearchPage`, `get_issue`, `update_issue(&IssueUpdate)`, `add_comment`,
`transition_issue_by_name(key, "Done")`, `list_projects`, `list_issue_types`. `JiraIssue::ticket_status()` maps to
`model::TicketStatus`; `jira::status_to_ticket_status` is the port of `JIRA_STATUS_TO_NYX`. Get a `JiraAuth` from
`connection::valid_session(..)?.auth()` (OAuth) or `JiraAuth::basic(site_url, email, token)` (API token).

## Security model

- Tokens never touch SQLite. Access/refresh: `SecretKey::{access,refresh}_token(Provider::Jira)`; OAuth client secret:
  `api_key(Provider::Jira)`; Jira webhook secret: `api_key(Other("jira-webhook"))`; Slack bot token:
  `access_token(Provider::Slack)`; Slack signing secret: `api_key(Provider::Slack)`. One Atlassian and one Slack
  connection per profile (the TS had one per user / team).
- Metadata: Jira/Confluence use the existing `integrations` table (`config` JSON, no secrets). Slack is not an
  `IntegrationType` (and SQLite cannot widen a CHECK), so migration `0171_slack_connections.sql` adds a small table.
- Inputs that end up in URL paths or JQL (project keys, issue keys, page/space ids, cloud ids, transition ids) are
  validated. Basic-auth site URLs go through `security::ssrf::UrlPolicy::strict`. Slack `response_url` must be
  `https://hooks.slack.com`. Markdown links in ADF/storage are limited to http(s)/mailto; raw HTML is escaped.
- `HttpRequest`'s `Debug` redacts `Authorization`; token types are `SecretString`.

## Rate limits

`Http::send` retries `429` (and `503` with `Retry-After`) up to 3 attempts, waiting `Retry-After` seconds or 1s/2s/4s,
and fails fast with `RateLimited { retry_after_secs }` when the server asks for more than 30s. `Sleeper` is injected,
tests use `RecordingSleeper`. Slack's `ok:false, error:"ratelimited"` maps to the same error.

## TS to Rust mapping

| TS | Rust |
| --- | --- |
| `generateCodeVerifier/Challenge/StateToken`, `pkce_challenges` | `oauth::{generate_code_verifier, code_challenge, generate_state}`, `PendingAuths` |
| `buildAuthUrl`, `exchangeCodeForTokens`, `getAccessibleResources`, `refreshAccessToken`, `revokeToken` | `atlassian::oauth::*` |
| `storeConnection`, `getValidToken`, `getConnectionStatus`, `disconnect`, preferences route | `atlassian::connection::*` |
| `listJiraProjects`, `createJiraIssue`, `jira.service.ts` (list/create/search/get) | `jira::JiraClient` |
| `registerJiraWebhook/deleteJiraWebhook`, `validateJiraWebhookSignature`, `/jira/webhook` route | `JiraClient::{register,delete}_webhook`, `webhook::{verify_signature, parse_webhook}` |
| `textToAdf/parseInlineMarks/adfToText` | `adf::*` (all vitest cases ported) |
| `listConfluenceSpaces/exportToConfluence/importFromConfluence` | `ConfluenceClient::{list_spaces, export_page, import_page}` |
| `verifySlackSignature`, `processSlackMessage`, `sendSlackResponse`, `sendSlackChannelMessage` | `slack::events`, `slack::api` |
| `/slack/command`, `/slack/events` routing, `/install`, `/callback`, `/connection` | `events::{parse_slash_command, parse_events_body, intake_for_event}`, `slack::oauth`, `slack::store` |

## New vs TS

Jira: issue update (PUT), comments, transitions (by id or name), issue types, paginated projects, Basic auth + OAuth in
one client. Confluence: storage-format writes, labels, title lookup, version-bump update with 409 -> `Conflict`. Slack:
Block Kit builders, channel listing, `auth.test`.

## Deliberate deviations and parity gaps

- Search uses `POST /rest/api/3/search/jql` (Atlassian removed `GET /search`); results are token-paginated.
- `registerJiraWebhook` required no JQL in TS (`jqlFilter: ''`); Jira rejects that, so `jql_filter` is now required.
  Dynamic webhooks expire after 30 days: the refresh job is not implemented (needs a scheduler, wiring wave).
- Confluence pages are written as storage XHTML, not ADF; import still reads ADF. Create/update errors are surfaced
  (`register_webhook` too) instead of swallowed.
- Slack events: the TS re-serialised parsed JSON before verifying the signature; here callers pass the raw bytes.
  Unparsable timestamps are rejected (TS let `NaN` pass the replay check). `message_changed/deleted/bot_message`
  subtypes are not ingested. `processSlackMessage` is still only a summary (the TS never wired it to AI intake).
- `JIRA_WEBHOOK_SECRET` unset means "accept" (dev mode, as in TS): production wiring should refuse to start without it.
- Not ported: user-id based connection lookup (single profile), `FRONTEND_URL` redirects (UI concern), the Jira
  route's ticket DB updates (the caller applies `JiraWebhookAction` to its tickets).
- Added `HttpMethod::Put` to `git_provider::transport` (one enum variant) because Jira/Confluence updates need it and
  the brief's `ai::HttpTransport` has neither PUT/DELETE nor response headers (needed for `Retry-After`). Both transports are now one: `crate::net`.

## TODO (wiring wave, AI-74)

- Done in `nyx-net`: the real `HttpTransport` and `LoopbackListener` (implements `oauth::CallbackReceiver`, feeds `parse_callback`). See `net.md`.
- Slack OAuth v2 only accepts https redirect URLs: the desktop app needs an https relay page forwarding `code`/`state`
  to the loopback listener, or manual bot-token entry (`slack::store::connect_with_token` after `auth.test`).
- Expose through MCP/CLI/Tauri; persist the signing/webhook secrets via `SecretStore` keys listed above.
