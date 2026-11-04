# Notifications, governance, audit and feedback (AI-76)

Rust port in `crates/nyx-core/src/notify/` and `crates/nyx-core/src/governance/`. Migration `0176_notifications_governance.sql` (version 176) adds `notifications`, `notification_preferences`, `email_delivery_log`, `approvals`, `approval_reviews`, `feedback_submissions`. The audit table already existed (`store/audit.rs`, append-only triggers).

## TS source mapping

| TypeScript | Rust |
|---|---|
| `notification-events.ts` | `notify::events::NotificationEvent` (11 typed events), `EventFilter` (inbox `review` / category / exact) |
| `pubsub.service.ts` | `notify::bus::EventBus` on `std::sync::mpsc` (core is synchronous rusqlite, no tokio). Per-user `Subscription`, unsubscribes on drop |
| `notification.service.ts` | `notify::service::NotificationService`: `inApp` preference filter, 10 minute de-dup by entity, publish `notification.created/updated`. Slack delivery replaced by the `Notifier` trait (OS notifications) |
| `routes/notifications.ts` | Service methods `inbox` (filters, cursor, unread count), `mark_read`, `mark_all_read`, `delete`, `preferences`, `replace_preferences` (PUT), `update_preference` (PATCH) |
| `notification-email.service.ts` | `notify::mailer`: `Mailer` trait + `FakeMailer`, `queue_or_send` (instant / daily / weekly / off), `send_digest`, HTML builders |
| `governance.service.ts` | `governance::policy::PolicyEngine::validate_action` (quality gate >= 7 via `QualityAnalyzer`, secret scan, delete needs admin, principle warnings), `governance::secrets` |
| `approval.service.ts` | `governance::approvals::ApprovalService` (create/approve/reject/check/list/get, 7 day expiry) |
| `compliance.service.ts` | `governance::compliance`: `SpecRetriever` + `ComplianceAnalyzer` traits, prompt builders, tolerant JSON parser (fails open like TS) |
| `audit.service.ts` | `governance::audit::AuditService`: `record_event`, `trail_for_document`, `trace_chain`, `team_activity`, plus `query`/`count`/`export` |
| `feedback.service.ts`, `routes/feedback.ts` | `governance::feedback`: rate limit (5 / rolling day), `IssueSubmitter` + `FormattedFeedback` parsing, records |

## Behaviour notes

- Audit kinds are those of `AuditEventType`; `agent_workflow` is gone. Filters: team, event types, actor, document, ticket, snapshot, commit, inclusive time range, metadata substring (LIKE wildcards escaped), paging, order. Export: JSON, JSONL, CSV (RFC 4180, leading `= + - @` neutralised against spreadsheet formula injection).
- Inbox cursor is `"<created_at>:<rowid>"` (TS used `created_at` only, which can skip rows sharing a millisecond).
- Email HTML escapes title, body and CTA, and only renders `http(s)` links (TS interpolated raw). Digest subject/grouping match TS.
- Time comes from an injectable `notify::Clock` so windows and expiries are testable.

## Extensions beyond TS

- **Approval rules / required reviewers** (`ApprovalRule`): `min_approvals`, named `reviewer_ids` (all must approve, only they may review), `allow_self_approval` (default false under a rule; TS-compatible default when no rule matches), per-rule expiry. Rules come from `PolicyConfig.approval_rules` (loaded from `governance.json` `approval_rules`). `PolicyEngine::evaluate_gated` blocks an action until the latest approval for the resource is approved.
- Forbidden paths and allowed env files from `governance.json` (`PolicyEngine::forbidden_path`).
- `PolicyConfig::from_agentpolicy_dir` loads `.agentpolicy/*.json` (missing or malformed files are ignored, like TS).
- `HeuristicFormatter`: offline feedback formatter (the in-app LLM formatter is dropped).

## Gaps / TODO

- No real `Mailer` (SMTP, for example `lettre`, credentials in the keychain) and no real `Notifier` (Tauri notification plugin lives in the desktop shell). Both are traits with fakes.
- `QualityAnalyzer`, `ComplianceAnalyzer`: no LLM-backed impl; wire to `LlmProvider` (AI-75) when merged. `SpecRetriever` needs a `doc_chunks` backed impl once an embedding source exists.
- `IssueSubmitter`: no real GitHub impl (`GitProvider`, AI-66). Feedback is always stored locally first-class; tracker failure is returned as `submit_error`.
- Not ported: the HTTP/WebSocket route layer and auth checks (front-ends call the services; wiring is AI-74). No scheduler: something must call `send_digest` daily/weekly.
- `tests/migrations.rs`: the "extra migrations" test used version 100, which now collides with the out-of-order check once core versions exceed 100; it uses 10000.
