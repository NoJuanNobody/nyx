//! End-to-end tests for the live-sync drift pipeline (AI-68): changed paths -> matched specs ->
//! verdict parse -> drift records, including idempotent replays and the signed-webhook entry.

#![allow(
    clippy::assert_is_empty,
    clippy::float_cmp,
    clippy::cloned_ref_to_slice_refs,
    clippy::manual_assert_eq,
    clippy::unwrap_used,
    clippy::expect_used,
    missing_docs
)]

mod common;

use common::{fixture, new_doc, Fixture};
use nyx_core::ai::{FakeLlm, ModelPair};
use nyx_core::git_provider::transport::Headers;
use nyx_core::git_provider::util::hmac_sha256;
use nyx_core::git_provider::ProviderKind;
use nyx_core::model::{AuditEventType, IntegrationType, NewIntegration};
use nyx_core::store::{
    AuditRepo, DocumentRepo, IntegrationRepo, SqliteAudit, SqliteDocuments, SqliteIntegrations,
};
use nyx_core::sync::drift::{parse_verdict, VerdictError};
use nyx_core::sync::impact::{Edge, NodeRef};
use nyx_core::sync::{
    process_webhook, ChangeSet, DriftConfig, DriftEngine, DriftStatus, MemoryCode, SqliteDrift,
    SqliteImpact, WebhookOutcome,
};
use serde_json::json;

const DRIFT: &str = r#"{"hasDrift": true, "driftScore": 7, "details": "login now uses OAuth", "suggestions": ["Update the auth section"]}"#;
const CLEAN: &str = r#"{"hasDrift": false, "driftScore": 0, "details": "", "suggestions": []}"#;

fn models() -> ModelPair {
    ModelPair {
        default: "m".into(),
        fast: "f".into(),
    }
}

fn code() -> MemoryCode {
    MemoryCode(
        [(
            "src/auth/login.rs".to_string(),
            "fn login_with_oauth() {}".to_string(),
        )]
        .into(),
    )
}

fn push_change(sha: &str) -> ChangeSet {
    ChangeSet {
        run_key: format!("push:o/r:refs/heads/main:{sha}"),
        source: "push".into(),
        repo_full_name: Some("o/r".into()),
        git_ref: Some("refs/heads/main".into()),
        commit_sha: Some(sha.into()),
        changed_files: vec!["src/auth/login.rs".into()],
        commits: vec![nyx_core::sync::drift::CommitInfo {
            sha: sha.into(),
            message: "switch login to oauth".into(),
            author: "Ada".into(),
        }],
    }
}

fn setup() -> (Fixture, String, String) {
    let f = fixture();
    let auth = new_doc(
        &f,
        "Auth",
        "Login is implemented in `src/auth/login.rs` using passwords.",
    );
    let billing = new_doc(&f, "Billing", "Invoices and credits only.");
    (f, auth.id, billing.id)
}

#[test]
fn verdict_parsing_accepts_variants() {
    let v = parse_verdict(DRIFT).unwrap();
    assert!(v.has_drift && v.drift_score == 7.0 && v.suggestions == ["Update the auth section"]);

    let fenced = parse_verdict("```json\n{\"hasDrift\": false, \"driftScore\": 1}\n```").unwrap();
    assert!(!fenced.has_drift);

    let prose = parse_verdict("Here you go: {\"note\": {}} then {\"hasDrift\": \"true\", \"driftScore\": \"4.5\", \"details\": \"x\"} bye {").unwrap();
    assert!(prose.has_drift && prose.drift_score == 4.5);

    // Score is clamped, score-only derives the flag, suggestions keep only non-empty strings.
    let hi =
        parse_verdict(r#"{"driftScore": 99, "suggestions": ["a", 3, "", null, " b "]}"#).unwrap();
    assert!(hi.has_drift && hi.drift_score == 10.0 && hi.suggestions == ["a", "b"]);
    let zero = parse_verdict(r#"{"driftScore": 0.4}"#).unwrap();
    assert!(!zero.has_drift);
    assert_eq!(
        parse_verdict(r#"{"driftScore": -3, "hasDrift": false}"#)
            .unwrap()
            .drift_score,
        0.0
    );
}

#[test]
fn verdict_parsing_rejects_malformed_output() {
    assert_eq!(parse_verdict("   "), Err(VerdictError::Empty));
    assert_eq!(
        parse_verdict("I could not determine that."),
        Err(VerdictError::NoJson)
    );
    assert_eq!(
        parse_verdict("{\"hasDrift\": true, \"driftScore\": "),
        Err(VerdictError::NoJson)
    );
    assert_eq!(parse_verdict("[1, 2, 3]"), Err(VerdictError::NoJson));
    for bad in [
        r#"{"details": "no verdict fields"}"#,
        r#"{"hasDrift": [true]}"#,
        r#"{"hasDrift": "maybe", "driftScore": 3}"#,
        r#"{"driftScore": "high"}"#,
        r#"{"hasDrift": null, "driftScore": null}"#,
    ] {
        assert!(
            matches!(parse_verdict(bad), Err(VerdictError::Invalid(_))),
            "{bad}"
        );
    }
}

#[test]
fn pipeline_flags_only_matched_specs_and_stores_records() {
    let (f, auth, billing) = setup();
    let llm = FakeLlm::with_texts(&[DRIFT]);
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let report = engine
        .run(f.db.conn(), &f.team.id, &push_change("abc123"))
        .unwrap();

    assert_eq!(report.matched.len(), 1);
    assert_eq!(report.matched[0].document_id, auth);
    assert_eq!(llm.call_count(), 1, "unmatched specs cost no model call");
    assert_eq!(report.evaluated.len(), 1);
    let rec = &report.evaluated[0];
    assert!(rec.has_drift && rec.status == DriftStatus::Open);
    assert_eq!(rec.document_id, auth);
    assert_eq!(rec.doc_version, 1);
    assert_eq!(rec.commit_sha.as_deref(), Some("abc123"));
    assert_eq!(rec.changed_files, ["src/auth/login.rs"]);
    assert_eq!(report.drifted().len(), 1);

    // The prompt carried both the spec and the changed code.
    let sent = &llm.requests()[0].messages[0].content;
    assert!(sent.contains("passwords") && sent.contains("login_with_oauth"));
    assert!(sent.contains("### src/auth/login.rs"));

    let drift = SqliteDrift::new(f.db.conn());
    assert_eq!(drift.list_open(&f.team.id).unwrap().len(), 1);
    assert!(drift.list_for_document(&billing).unwrap().is_empty());

    // Commit recorded in the document's audit trail.
    let events = SqliteAudit::new(f.db.conn())
        .list_by_document(&auth, 10)
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, AuditEventType::CodeCommit);
    assert_eq!(events[0].commit_sha.as_deref(), Some("abc123"));
    assert_eq!(report.commits_recorded, 1);

    // Resolve it.
    let done = drift.set_status(&rec.id, DriftStatus::Resolved).unwrap();
    assert!(done.resolved_at.is_some());
    assert!(drift.list_open(&f.team.id).unwrap().is_empty());
}

#[test]
fn rerun_on_the_same_push_is_idempotent() {
    let (f, auth, _) = setup();
    let llm = FakeLlm::with_texts(&[DRIFT, DRIFT]);
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let change = push_change("abc123");

    let first = engine.run(f.db.conn(), &f.team.id, &change).unwrap();
    assert_eq!(first.evaluated.len(), 1);
    let second = engine.run(f.db.conn(), &f.team.id, &change).unwrap();
    assert!(second.evaluated.is_empty());
    assert_eq!(second.skipped_existing, [auth.clone()]);
    assert_eq!(second.commits_recorded, 0);
    assert_eq!(llm.call_count(), 1, "replay makes no model call");
    assert_eq!(
        SqliteDrift::new(f.db.conn())
            .list_for_document(&auth)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        SqliteAudit::new(f.db.conn())
            .list_by_document(&auth, 10)
            .unwrap()
            .len(),
        1
    );

    // A different push is a new run...
    let third = engine
        .run(f.db.conn(), &f.team.id, &push_change("def456"))
        .unwrap();
    assert_eq!(third.evaluated.len(), 1);
    // ...and editing the spec makes the same push worth judging again.
    SqliteDocuments::new(f.db.conn())
        .save_content(
            &auth,
            "Login now uses OAuth in `src/auth/login.rs`.",
            None,
            &f.user.id,
        )
        .unwrap();
    llm.push_text(CLEAN);
    let fourth = engine.run(f.db.conn(), &f.team.id, &change).unwrap();
    assert_eq!(fourth.evaluated.len(), 1);
    assert_eq!(fourth.evaluated[0].doc_version, 2);
    assert!(!fourth.evaluated[0].has_drift);
    assert_eq!(
        SqliteDrift::new(f.db.conn())
            .list_for_document(&auth)
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn malformed_reply_is_a_retryable_failure_not_a_stored_verdict() {
    let (f, auth, _) = setup();
    let llm = FakeLlm::with_texts(&["Looks fine to me!", DRIFT]);
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let change = push_change("abc123");

    let r1 = engine.run(f.db.conn(), &f.team.id, &change).unwrap();
    assert!(r1.evaluated.is_empty());
    assert_eq!(r1.failures.len(), 1);
    assert_eq!(r1.failures[0].document_id, auth);
    assert!(r1.failures[0].reason.contains("unusable model reply"));
    assert!(SqliteDrift::new(f.db.conn())
        .list_for_document(&auth)
        .unwrap()
        .is_empty());

    // Retrying the same push gets another chance and now succeeds.
    let r2 = engine.run(f.db.conn(), &f.team.id, &change).unwrap();
    assert_eq!(r2.evaluated.len(), 1);
    assert!(r2.failures.is_empty());
    assert_eq!(llm.call_count(), 2);
}

#[test]
fn provider_error_is_collected_per_spec() {
    let (f, _, _) = setup();
    let llm = FakeLlm::new(); // exhausted: every call fails
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let r = engine
        .run(f.db.conn(), &f.team.id, &push_change("abc"))
        .unwrap();
    assert_eq!(r.failures.len(), 1);
    assert!(r.failures[0].reason.contains("provider error"));
}

#[test]
fn explicit_impact_link_selects_spec_and_deleted_files_are_described() {
    let (f, _, billing) = setup();
    SqliteImpact::new(f.db.conn())
        .link(
            &f.team.id,
            &Edge {
                src: NodeRef::spec(billing.clone()),
                dst: NodeRef::file("src/ledger/post.rs"),
                relation: "implements".into(),
                weight: 1.0,
            },
        )
        .unwrap();
    let llm = FakeLlm::with_texts(&[CLEAN]);
    let src = MemoryCode::default(); // file was deleted
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let change = ChangeSet::from_watch("local", &[("src/ledger/post.rs".into(), "removed".into())]);
    let r = engine.run(f.db.conn(), &f.team.id, &change).unwrap();
    assert_eq!(r.matched.len(), 1);
    assert_eq!(r.matched[0].document_id, billing);
    assert!(llm.requests()[0].messages[0]
        .content
        .contains("deleted or unreadable"));
    assert_eq!(r.evaluated[0].source, "watch");
    assert!(r.commits_recorded == 0);
}

#[test]
fn empty_change_set_does_nothing() {
    let (f, _, _) = setup();
    let llm = FakeLlm::new();
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let mut c = push_change("x");
    c.changed_files.clear();
    let r = engine.run(f.db.conn(), &f.team.id, &c).unwrap();
    assert!(r.matched.is_empty() && llm.call_count() == 0);
}

// --- webhook entry ----------------------------------------------------------------------------

fn push_body() -> Vec<u8> {
    json!({
        "ref": "refs/heads/main",
        "repository": {"full_name": "o/r"},
        "commits": [{
            "id": "abc123", "message": "switch login to oauth", "timestamp": "2026-01-01T00:00:00Z",
            "author": {"name": "Ada", "email": "a@x.io"},
            "added": [], "removed": [], "modified": ["src/auth/login.rs"]
        }]
    })
    .to_string()
    .into_bytes()
}

fn signed(body: &[u8], secret: &str, event: &str) -> Headers {
    let sig = format!(
        "sha256={}",
        hex::encode(hmac_sha256(secret.as_bytes(), body))
    );
    Headers::from_pairs([
        ("x-github-event", event),
        ("x-hub-signature-256", sig.as_str()),
    ])
}

fn connect(f: &Fixture, secret: &str) {
    SqliteIntegrations::new(f.db.conn())
        .create(&NewIntegration {
            team_id: f.team.id.clone(),
            r#type: IntegrationType::Github,
            config: json!({"selectedRepos": [{"fullName": "o/r"}], "webhookSecret": secret}),
        })
        .unwrap();
}

#[test]
fn webhook_verifies_signature_then_runs_and_redelivery_is_a_noop() {
    let (f, auth, _) = setup();
    connect(&f, "s3cret");
    let llm = FakeLlm::with_texts(&[DRIFT, DRIFT]);
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let body = push_body();

    let bad = process_webhook(
        f.db.conn(),
        &engine,
        ProviderKind::GitHub,
        &signed(&body, "wrong", "push"),
        &body,
        None,
    )
    .unwrap();
    assert!(matches!(bad, WebhookOutcome::Rejected(_)));
    let unsigned = process_webhook(
        f.db.conn(),
        &engine,
        ProviderKind::GitHub,
        &Headers::from_pairs([("x-github-event", "push")]),
        &body,
        None,
    )
    .unwrap();
    assert!(matches!(unsigned, WebhookOutcome::Rejected(_)));
    assert_eq!(llm.call_count(), 0);

    let h = signed(&body, "s3cret", "push");
    let WebhookOutcome::Processed(out) =
        process_webhook(f.db.conn(), &engine, ProviderKind::GitHub, &h, &body, None).unwrap()
    else {
        panic!("expected Processed");
    };
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].0, f.team.id);
    assert_eq!(out[0].1.evaluated.len(), 1);
    assert_eq!(out[0].1.evaluated[0].document_id, auth);

    // GitHub redelivers the identical payload.
    let WebhookOutcome::Processed(again) =
        process_webhook(f.db.conn(), &engine, ProviderKind::GitHub, &h, &body, None).unwrap()
    else {
        panic!("expected Processed");
    };
    assert!(again[0].1.evaluated.is_empty());
    assert_eq!(again[0].1.skipped_existing, [auth.clone()]);
    assert_eq!(llm.call_count(), 1);
    assert_eq!(
        SqliteDrift::new(f.db.conn())
            .list_for_document(&auth)
            .unwrap()
            .len(),
        1
    );

    let ping_body = br#"{"repository":{"full_name":"o/r"}}"#;
    let ping = process_webhook(
        f.db.conn(),
        &engine,
        ProviderKind::GitHub,
        &signed(ping_body, "s3cret", "ping"),
        ping_body,
        None,
    )
    .unwrap();
    assert_eq!(ping, WebhookOutcome::Ignored("ping".into()));
}

#[test]
fn webhook_fallback_secret_and_unknown_repo() {
    let (f, auth, _) = setup();
    connect(&f, "team-secret");
    let llm = FakeLlm::with_texts(&[DRIFT]);
    let src = code();
    let m = models();
    let engine = DriftEngine::new(&llm, &m, &src, DriftConfig::default());
    let body = push_body();

    // Global secret verifies, teams are resolved by repo.
    let h = signed(&body, "global", "push");
    let WebhookOutcome::Processed(out) = process_webhook(
        f.db.conn(),
        &engine,
        ProviderKind::GitHub,
        &h,
        &body,
        Some("global"),
    )
    .unwrap() else {
        panic!("expected Processed");
    };
    assert_eq!(out[0].1.evaluated[0].document_id, auth);

    // Repo nobody connected: authenticated by the global secret but no team to process.
    let other = String::from_utf8(body.clone())
        .unwrap()
        .replace("o/r", "x/y")
        .into_bytes();
    let WebhookOutcome::Processed(none) = process_webhook(
        f.db.conn(),
        &engine,
        ProviderKind::GitHub,
        &signed(&other, "global", "push"),
        &other,
        Some("global"),
    )
    .unwrap() else {
        panic!("expected Processed");
    };
    assert!(none.is_empty());

    // A wrong signature never falls through.
    let bad = process_webhook(
        f.db.conn(),
        &engine,
        ProviderKind::GitHub,
        &signed(&body, "nope", "push"),
        &body,
        Some("global"),
    )
    .unwrap();
    assert!(matches!(bad, WebhookOutcome::Rejected(_)));
}
