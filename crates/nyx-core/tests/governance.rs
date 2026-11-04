#![allow(
    clippy::assert_is_empty,
    clippy::items_after_statements,
    clippy::many_single_char_names,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::similar_names,
    missing_docs
)]
//! Policy decisions, approvals, compliance, audit filtering/export and feedback tests.

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use common::{fixture, new_doc, Fixture};
use nyx_core::governance::approvals::{
    ApprovalRule, ApprovalService, ApprovalStatus, NewApproval, DEFAULT_EXPIRY_MS,
};
use nyx_core::governance::compliance::{CannedAnalyzer, FixedRetriever, Severity};
use nyx_core::governance::feedback::{
    FakeIssueSubmitter, FeedbackService, FormattedFeedback, HeuristicFormatter, MAX_PER_DAY,
};
use nyx_core::governance::policy::{FixedQuality, ForbiddenPath};
use nyx_core::governance::{
    check_compliance, Action, ActionRequest, AuditFilter, AuditService, ExportFormat, PolicyConfig,
    PolicyEngine, Principle,
};
use nyx_core::model::{AuditEventType, NewAuditEvent, NewUser, User};
use nyx_core::notify::Clock;
use nyx_core::store::{SqliteUsers, UserRepo};
use rusqlite::params;
use serde_json::json;

const T0: i64 = 1_700_000_000_000;

fn clock() -> (Arc<AtomicI64>, Clock) {
    let t = Arc::new(AtomicI64::new(T0));
    let t2 = t.clone();
    (t, Clock::new(move || t2.load(Ordering::SeqCst)))
}

fn user(f: &Fixture, email: &str, name: &str) -> User {
    SqliteUsers::new(f.db.conn())
        .create(&NewUser {
            email: email.into(),
            name: name.into(),
            avatar_url: None,
        })
        .unwrap()
}

// ---------- policy ----------

fn engine_with(score: f64) -> PolicyEngine {
    PolicyEngine::new(PolicyConfig::default()).with_analyzer(Arc::new(FixedQuality::score(
        score,
        &["add acceptance criteria", "name an owner"],
    )))
}

#[test]
fn publish_is_blocked_below_quality_threshold() {
    let req = ActionRequest::new("publish", "t").with_content("# Spec");
    let d = engine_with(6.0).validate_action(&req);
    assert!(!d.allowed);
    assert_eq!(d.violations.len(), 1);
    assert!(d.violations[0].contains("Quality score 6/10 is below the minimum threshold of 7"));
    assert!(d.violations[0].contains("add acceptance criteria; name an owner"));

    assert!(engine_with(7.0).validate_action(&req).allowed, "7 passes");
    assert!(engine_with(9.5).validate_action(&req).allowed);
}

#[test]
fn publish_passes_stage_and_skips_gate_without_content() {
    let q = Arc::new(FixedQuality::score(9.0, &[]));
    let engine = PolicyEngine::new(PolicyConfig::default()).with_analyzer(q.clone());
    let mut req = ActionRequest::new("publish", "t").with_content("x");
    req.stage = Some("prd".into());
    assert!(engine.validate_action(&req).allowed);
    assert_eq!(q.stages(), vec![Some("prd".to_string())]);

    let d = engine.validate_action(&ActionRequest::new("publish", "t"));
    assert!(d.allowed && d.violations.is_empty() && d.warnings.is_empty());
    assert_eq!(q.stages().len(), 1, "no content, no analysis");
}

#[test]
fn analyzer_failure_or_absence_only_warns() {
    let failing = PolicyEngine::new(PolicyConfig::default())
        .with_analyzer(Arc::new(FixedQuality::failing("no key")));
    let req = ActionRequest::new("publish", "t").with_content("x");
    let d = failing.validate_action(&req);
    assert!(d.allowed);
    assert!(
        d.warnings[0].contains("Could not run quality analysis")
            && d.warnings[0].contains("no key")
    );

    let none = PolicyEngine::new(PolicyConfig::default()).validate_action(&req);
    assert!(none.allowed);
    assert_eq!(none.warnings.len(), 1);
}

#[test]
fn edit_and_create_block_secrets_but_clean_content_passes() {
    let engine = PolicyEngine::new(PolicyConfig::default());
    for action in ["edit", "create"] {
        let d = engine.validate_action(
            &ActionRequest::new(action, "t").with_content("key AKIAIOSFODNN7EXAMPLE"),
        );
        assert!(!d.allowed, "{action}");
        assert!(d.violations[0].starts_with("Content matches secret pattern"));
        assert!(
            !d.violations[0].contains("AKIAIOSFODNN7EXAMPLE"),
            "the secret itself is never echoed"
        );
        assert!(
            engine
                .validate_action(&ActionRequest::new(action, "t").with_content("hello"))
                .allowed
        );
    }
    // Secrets in other actions are not scanned (TS parity).
    assert!(
        engine
            .validate_action(
                &ActionRequest::new("archive", "t").with_content("key AKIAIOSFODNN7EXAMPLE")
            )
            .allowed
    );
}

#[test]
fn delete_needs_admin_and_warns_when_constitution_loaded() {
    let plain = PolicyEngine::new(PolicyConfig::default());
    let d = plain.validate_action(&ActionRequest::new("delete", "t"));
    assert!(!d.allowed);
    assert!(d.violations[0].contains("admin-level authorization"));
    assert!(
        d.warnings.is_empty(),
        "no constitution, no principle warnings"
    );

    let with_constitution = PolicyEngine::new(PolicyConfig {
        principles: Some(vec![Principle {
            id: "scope-discipline".into(),
            title: "Stay Scoped".into(),
            description: String::new(),
        }]),
        ..PolicyConfig::default()
    });
    let d = with_constitution.validate_action(&ActionRequest::new("delete", "t"));
    assert!(d
        .warnings
        .iter()
        .any(|w| w.contains("Stay Scoped and Respect Sequencing")));
    let mut admin = ActionRequest::new("delete", "t");
    admin.is_admin = true;
    assert!(with_constitution.validate_action(&admin).allowed);

    let d = with_constitution.validate_action(
        &ActionRequest::new("edit", "t").with_content("token = \"abcdefgh12345\""),
    );
    assert!(!d.allowed);
    assert!(d.warnings.iter().any(|w| w.contains("Security First")));
    assert_eq!(Action::parse("publish"), Action::Publish);
    assert_eq!(Action::parse("weird").as_str(), "weird");
}

#[test]
fn forbidden_paths_with_exceptions() {
    let engine = PolicyEngine::new(PolicyConfig {
        forbidden_paths: vec![
            ForbiddenPath {
                pattern: ".env".into(),
                exception: None,
                reason: "secrets".into(),
            },
            ForbiddenPath {
                pattern: ".env.*".into(),
                exception: Some(".env.example".into()),
                reason: "secrets".into(),
            },
            ForbiddenPath {
                pattern: "secrets/*".into(),
                exception: None,
                reason: "vault".into(),
            },
        ],
        allowed_files: vec![".env.template".into()],
        ..PolicyConfig::default()
    });
    assert!(engine.forbidden_path("apps/api/.env").is_some());
    assert!(engine.forbidden_path(".env.production").is_some());
    assert!(engine.forbidden_path("a/b/.env.example").is_none());
    assert!(engine.forbidden_path(".env.template").is_none());
    assert!(engine.forbidden_path("secrets/key.pem").is_some());
    assert!(engine.forbidden_path("src/main.rs").is_none());
    let mut req = ActionRequest::new("edit", "t").with_content("fine");
    req.path = Some(".env.local".into());
    let d = engine.validate_action(&req);
    assert!(!d.allowed && d.violations[0].contains("forbidden by policy"));
}

#[test]
fn loads_agentpolicy_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("constitution.json"),
        json!({"principles": [{"id": "security-first", "title": "Security First", "description": "d"}]}).to_string(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("governance.json"),
        json!({
            "forbidden_paths": [{"pattern": ".env", "reason": "secrets"}],
            "allowed_env_files": [".env.example"],
            "approval_rules": [{"action": "publish", "min_approvals": 2}]
        })
        .to_string(),
    )
    .unwrap();
    let cfg = PolicyConfig::from_agentpolicy_dir(dir.path());
    assert_eq!(cfg.principles.as_ref().unwrap().len(), 1);
    assert_eq!(cfg.forbidden_paths.len(), 1);
    assert_eq!(cfg.allowed_files, vec![".env.example"]);
    assert_eq!(cfg.approval_rules[0].min_approvals, 2);
    assert!(cfg.rules().0.is_some() && cfg.rules().1.is_some());

    // Missing directory: defaults, no panic (TS returns null).
    let empty = PolicyConfig::from_agentpolicy_dir(&dir.path().join("missing"));
    assert!(empty.principles.is_none() && empty.rules().0.is_none());
}

#[test]
fn approval_rule_gates_action_until_approved() {
    let f = fixture();
    let reviewer = user(&f, "r@example.com", "Rita");
    let cfg = PolicyConfig {
        approval_rules: vec![ApprovalRule::new("publish")],
        ..PolicyConfig::default()
    };
    let engine =
        PolicyEngine::new(cfg.clone()).with_analyzer(Arc::new(FixedQuality::score(9.0, &[])));
    let req = ActionRequest::new("publish", &f.team.id).with_content("spec");

    let d = engine.validate_action(&req);
    assert!(
        d.allowed && d.approval.is_some(),
        "plain evaluation reports the requirement"
    );

    let gated = engine.evaluate_gated(f.db.conn(), &req, "doc-1").unwrap();
    assert!(!gated.allowed);
    assert!(gated.violations[0].contains("requires approval"));

    let svc = ApprovalService::new(f.db.conn()).with_rules(cfg.approval_rules);
    let a = svc
        .create(&NewApproval {
            action: "publish".into(),
            resource_id: "doc-1".into(),
            requested_by_id: f.user.id.clone(),
            team_id: f.team.id.clone(),
            metadata: json!({}),
            expires_in_ms: None,
        })
        .unwrap();
    let pending = engine.evaluate_gated(f.db.conn(), &req, "doc-1").unwrap();
    assert!(pending.violations[0].contains("still pending"));
    assert!(engine
        .evaluate_gated(f.db.conn(), &req, "doc-2")
        .unwrap()
        .violations[0]
        .contains("requires approval"));

    svc.approve(&a.id, &reviewer.id, Some("lgtm")).unwrap();
    assert!(
        engine
            .evaluate_gated(f.db.conn(), &req, "doc-1")
            .unwrap()
            .allowed
    );

    // An action without a rule is never gated.
    assert!(
        engine
            .evaluate_gated(
                f.db.conn(),
                &ActionRequest::new("edit", &f.team.id),
                "doc-1"
            )
            .unwrap()
            .allowed
    );
}

// ---------- approvals ----------

fn new_approval(f: &Fixture, action: &str, resource: &str) -> NewApproval {
    NewApproval {
        action: action.into(),
        resource_id: resource.into(),
        requested_by_id: f.user.id.clone(),
        team_id: f.team.id.clone(),
        metadata: json!({"k": 1}),
        expires_in_ms: None,
    }
}

#[test]
fn approval_ts_flow_approve_reject_noop_and_expiry() {
    let f = fixture();
    let rev = user(&f, "r@example.com", "Rita");
    let (t, clk) = clock();
    let svc = ApprovalService::new(f.db.conn()).with_clock(clk);

    let a = svc.create(&new_approval(&f, "publish", "d1")).unwrap();
    assert_eq!(a.status, ApprovalStatus::Pending);
    assert_eq!(a.expires_at, T0 + DEFAULT_EXPIRY_MS);
    assert_eq!(a.metadata, json!({"k": 1}));

    // TS default: the requester may approve without any rule.
    let done = svc.approve(&a.id, &f.user.id, Some("self")).unwrap();
    assert_eq!(done.status, ApprovalStatus::Approved);
    assert_eq!(done.reviewed_by_id.as_deref(), Some(f.user.id.as_str()));
    assert_eq!(done.reason.as_deref(), Some("self"));
    assert_eq!(done.reviewed_at, Some(T0));
    // Non-pending approvals are returned unchanged.
    assert_eq!(
        svc.reject(&a.id, &rev.id, Some("late")).unwrap().status,
        ApprovalStatus::Approved
    );
    assert_eq!(
        svc.approve(&a.id, &rev.id, None)
            .unwrap()
            .reviewed_by_id
            .as_deref(),
        Some(f.user.id.as_str())
    );

    let b = svc.create(&new_approval(&f, "delete", "d1")).unwrap();
    let rejected = svc.reject(&b.id, &rev.id, Some("no")).unwrap();
    assert_eq!(rejected.status, ApprovalStatus::Rejected);
    assert_eq!(rejected.reason.as_deref(), Some("no"));

    // Expiry on approve.
    let c = svc
        .create(&NewApproval {
            expires_in_ms: Some(1000),
            ..new_approval(&f, "publish", "d2")
        })
        .unwrap();
    t.store(T0 + 2000, Ordering::SeqCst);
    assert_eq!(
        svc.approve(&c.id, &rev.id, None).unwrap().status,
        ApprovalStatus::Expired
    );

    let d = svc
        .create(&NewApproval {
            expires_in_ms: Some(1000),
            ..new_approval(&f, "publish", "d3")
        })
        .unwrap();
    t.store(T0 + 10_000, Ordering::SeqCst);
    assert_eq!(svc.expire_overdue().unwrap(), 1);
    assert_eq!(svc.get(&d.id).unwrap().status, ApprovalStatus::Expired);

    assert!(svc.get("missing").is_err());
    assert!(svc.approve("missing", &rev.id, None).is_err());
}

#[test]
fn approval_check_and_list() {
    let f = fixture();
    let (t, clk) = clock();
    let svc = ApprovalService::new(f.db.conn()).with_clock(clk);
    assert!(svc.check("publish", "d1", &f.team.id).unwrap().is_none());
    let first = svc.create(&new_approval(&f, "publish", "d1")).unwrap();
    t.store(T0 + 1, Ordering::SeqCst);
    let second = svc.create(&new_approval(&f, "publish", "d1")).unwrap();
    svc.create(&new_approval(&f, "delete", "d9")).unwrap();
    assert_eq!(
        svc.check("publish", "d1", &f.team.id).unwrap().unwrap().id,
        second.id,
        "latest wins"
    );
    assert!(svc.check("publish", "d1", "other-team").unwrap().is_none());
    svc.reject(&first.id, &f.user.id, None).unwrap();

    assert_eq!(svc.list_by_team(&f.team.id, None).unwrap().len(), 3);
    assert_eq!(
        svc.list_by_team(&f.team.id, Some(ApprovalStatus::Pending))
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        svc.list_by_team(&f.team.id, Some(ApprovalStatus::Rejected))
            .unwrap()[0]
            .id,
        first.id
    );
}

#[test]
fn required_reviewers_all_must_approve_and_self_approval_is_forbidden() {
    let f = fixture();
    let r1 = user(&f, "r1@example.com", "R1");
    let r2 = user(&f, "r2@example.com", "R2");
    let outsider = user(&f, "o@example.com", "Out");
    let rule = ApprovalRule {
        reviewer_ids: vec![r1.id.clone(), r2.id.clone()],
        ..ApprovalRule::new("publish")
    };
    assert_eq!(rule.required_count(), 2);
    let svc = ApprovalService::new(f.db.conn()).with_rules(vec![rule]);
    let a = svc.create(&new_approval(&f, "publish", "d1")).unwrap();
    assert_eq!(a.min_approvals, 2);

    assert!(
        svc.approve(&a.id, &outsider.id, None).is_err(),
        "not a named reviewer"
    );
    assert!(
        svc.approve(&a.id, &f.user.id, None).is_err(),
        "requester not named, and self approval forbidden"
    );

    let after_first = svc.approve(&a.id, &r1.id, Some("ok")).unwrap();
    assert_eq!(
        after_first.status,
        ApprovalStatus::Pending,
        "one of two is not enough"
    );
    assert!(
        svc.approve(&a.id, &r1.id, None).is_err(),
        "duplicate vote is a conflict"
    );
    let after_second = svc.approve(&a.id, &r2.id, Some("fine")).unwrap();
    assert_eq!(after_second.status, ApprovalStatus::Approved);
    assert_eq!(after_second.reviewed_by_id.as_deref(), Some(r2.id.as_str()));
    let votes = svc.reviews(&a.id).unwrap();
    assert_eq!(votes.len(), 2);
    assert_eq!(votes[0].reviewer_id, r1.id);
}

#[test]
fn min_approvals_counts_distinct_reviewers_and_one_reject_ends_it() {
    let f = fixture();
    let r1 = user(&f, "r1@example.com", "R1");
    let r2 = user(&f, "r2@example.com", "R2");
    let svc = ApprovalService::new(f.db.conn()).with_rules(vec![ApprovalRule {
        min_approvals: 2,
        ..ApprovalRule::new("publish")
    }]);
    let a = svc.create(&new_approval(&f, "publish", "d1")).unwrap();
    assert!(
        svc.approve(&a.id, &f.user.id, None).is_err(),
        "self approval off under a rule"
    );
    assert_eq!(
        svc.approve(&a.id, &r1.id, None).unwrap().status,
        ApprovalStatus::Pending
    );
    assert_eq!(
        svc.reject(&a.id, &r2.id, Some("nope")).unwrap().status,
        ApprovalStatus::Rejected
    );
    assert_eq!(
        svc.approve(&a.id, &r2.id, None).unwrap().status,
        ApprovalStatus::Rejected,
        "final"
    );
}

// ---------- compliance ----------

#[test]
fn compliance_flow() {
    let retriever = FixedRetriever(vec![
        (
            "doc-1".into(),
            "Passwords must be hashed with argon2.".into(),
            0.9,
        ),
        ("doc-2".into(), "irrelevant".into(), 0.05),
    ]);
    let answer = r#"```json
{"compliant": true, "violations": [{"rule": "Hash passwords", "severity": "error", "description": "stores plaintext", "specRef": "Spec chunk 1"}, {"rule": "bad", "severity": "info", "description": "x"}]}
```"#;
    let r = check_compliance(
        &retriever,
        &CannedAnalyzer(answer.into()),
        "store(password)",
        "t",
        Some("auth.rs"),
    )
    .unwrap();
    assert!(!r.compliant);
    assert_eq!(r.violations.len(), 1);
    assert_eq!(r.violations[0].severity, Severity::Error);
    assert_eq!(r.violations[0].spec_ref, "Spec chunk 1");

    // No relevant spec chunks: compliant, and the model is never consulted.
    struct Boom;
    impl nyx_core::governance::ComplianceAnalyzer for Boom {
        fn analyze(&self, _: &str, _: &str) -> nyx_core::Result<String> {
            panic!("must not be called")
        }
    }
    let r = check_compliance(
        &FixedRetriever(vec![("d".into(), "low".into(), 0.1)]),
        &Boom,
        "code",
        "t",
        None,
    )
    .unwrap();
    assert!(r.compliant && r.violations.is_empty());

    // Garbage answer fails open.
    let r = check_compliance(
        &retriever,
        &CannedAnalyzer("sorry".into()),
        "code",
        "t",
        None,
    )
    .unwrap();
    assert!(r.compliant);
}

// ---------- audit ----------

fn insert_at(
    f: &Fixture,
    ty: AuditEventType,
    actor: Option<&str>,
    doc: Option<&str>,
    at: i64,
    meta: &serde_json::Value,
    parent: Option<&str>,
) -> String {
    let id = nyx_core::model::new_id();
    f.db.conn()
        .execute(
            "INSERT INTO audit_trail (id,team_id,event_type,actor_id,document_id,parent_event_id,metadata,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, f.team.id, ty, actor, doc, parent, meta.to_string(), at],
        )
        .unwrap();
    id
}

#[test]
fn audit_record_and_document_trail_with_actor_names() {
    let f = fixture();
    let doc = new_doc(&f, "Spec", "body");
    let doc2 = new_doc(&f, "Other", "body");
    let audit = AuditService::new(f.db.conn());
    let mut e = NewAuditEvent::new(&f.team.id, AuditEventType::DocEdit);
    e.actor_id = Some(f.user.id.clone());
    e.document_id = Some(doc.id.clone());
    e.metadata = json!({"summary": "edited"});
    let rec = audit.record_event(&e).unwrap();
    assert_eq!(rec.event_type, AuditEventType::DocEdit);
    let mut system = NewAuditEvent::new(&f.team.id, AuditEventType::SnapshotCreated);
    system.document_id = Some(doc.id.clone());
    audit.record_event(&system).unwrap();
    let mut elsewhere = NewAuditEvent::new(&f.team.id, AuditEventType::DocEdit);
    elsewhere.document_id = Some(doc2.id.clone());
    audit.record_event(&elsewhere).unwrap();

    let trail = audit.trail_for_document(&doc.id).unwrap();
    assert_eq!(trail.len(), 2);
    assert_eq!(
        trail[0].event.event_type,
        AuditEventType::SnapshotCreated,
        "newest first"
    );
    assert_eq!(trail[0].actor_name, None);
    assert_eq!(trail[1].actor_name.as_deref(), Some("Ada"));

    // The log is append-only.
    assert!(f.db.conn().execute("DELETE FROM audit_trail", []).is_err());
    // Dangling parent is rejected.
    let mut bad = NewAuditEvent::new(&f.team.id, AuditEventType::DocEdit);
    bad.parent_event_id = Some("nope".into());
    assert!(audit.record_event(&bad).is_err());
}

#[test]
fn audit_trace_chain_walks_parents_and_stops() {
    let f = fixture();
    let audit = AuditService::new(f.db.conn());
    let a = audit
        .record_event(&NewAuditEvent::new(
            &f.team.id,
            AuditEventType::ProposalCreated,
        ))
        .unwrap();
    let mut b = NewAuditEvent::new(&f.team.id, AuditEventType::ProposalApproved);
    b.parent_event_id = Some(a.id.clone());
    let b = audit.record_event(&b).unwrap();
    let mut c = NewAuditEvent::new(&f.team.id, AuditEventType::ProposalPushed);
    c.parent_event_id = Some(b.id.clone());
    let c = audit.record_event(&c).unwrap();

    let chain = audit.trace_chain(&c.id).unwrap();
    let ids: Vec<_> = chain.iter().map(|e| e.event.id.clone()).collect();
    assert_eq!(ids, [c.id.clone(), b.id, a.id]);
    assert_eq!(audit.trace_chain("missing").unwrap().len(), 0);

    // Long chains are cut at 51 events, like the TS guard.
    let mut parent = c.id;
    for _ in 0..60 {
        let mut e = NewAuditEvent::new(&f.team.id, AuditEventType::CodeCommit);
        e.parent_event_id = Some(parent);
        parent = audit.record_event(&e).unwrap().id;
    }
    assert_eq!(
        audit.trace_chain(&parent).unwrap().len(),
        nyx_core::governance::audit::MAX_TRACE
    );
}

#[test]
fn audit_filtering() {
    let f = fixture();
    let bob = user(&f, "b@example.com", "Bob");
    let doc = new_doc(&f, "Spec", "body");
    let audit = AuditService::new(f.db.conn());
    let m = |s: &str| json!({"note": s});
    insert_at(
        &f,
        AuditEventType::DocEdit,
        Some(&f.user.id),
        Some(&doc.id),
        T0,
        &m("alpha"),
        None,
    );
    insert_at(
        &f,
        AuditEventType::DocEdit,
        Some(&bob.id),
        None,
        T0 + 10,
        &m("beta_100%"),
        None,
    );
    insert_at(
        &f,
        AuditEventType::TicketCreated,
        Some(&bob.id),
        None,
        T0 + 20,
        &m("gamma"),
        None,
    );
    insert_at(
        &f,
        AuditEventType::CodeCommit,
        None,
        None,
        T0 + 30,
        &m("delta"),
        None,
    );
    let other_team = nyx_core::store::TeamRepo::create(
        &nyx_core::store::SqliteTeams::new(f.db.conn()),
        &nyx_core::model::NewTeam {
            name: "Other".into(),
            slug: "other".into(),
        },
    )
    .unwrap();
    f.db.conn()
        .execute("INSERT INTO audit_trail (id,team_id,event_type,metadata,created_at) VALUES ('x',?1,'doc_edit','{}',?2)", params![other_team.id, T0])
        .unwrap();

    let base = AuditFilter {
        team_id: Some(f.team.id.clone()),
        ..AuditFilter::default()
    };
    let q = |flt: AuditFilter| audit.query(&flt).unwrap();
    let notes = |v: &[nyx_core::governance::AuditEntry]| {
        v.iter()
            .map(|e| e.event.metadata["note"].as_str().unwrap_or("").to_string())
            .collect::<Vec<_>>()
    };

    assert_eq!(q(base.clone()).len(), 4, "team scoped");
    assert_eq!(
        notes(&q(base.clone())),
        ["delta", "gamma", "beta_100%", "alpha"]
    );
    assert_eq!(
        notes(&q(AuditFilter {
            oldest_first: true,
            ..base.clone()
        }))[0],
        "alpha"
    );
    assert_eq!(
        q(AuditFilter {
            event_types: vec![AuditEventType::DocEdit],
            ..base.clone()
        })
        .len(),
        2
    );
    assert_eq!(
        q(AuditFilter {
            event_types: vec![AuditEventType::DocEdit, AuditEventType::CodeCommit],
            ..base.clone()
        })
        .len(),
        3
    );
    assert_eq!(
        q(AuditFilter {
            actor_id: Some(bob.id.clone()),
            ..base.clone()
        })
        .len(),
        2
    );
    assert_eq!(
        q(AuditFilter {
            document_id: Some(doc.id.clone()),
            ..base.clone()
        })
        .len(),
        1
    );
    assert_eq!(
        q(AuditFilter {
            since: Some(T0 + 10),
            until: Some(T0 + 20),
            ..base.clone()
        })
        .len(),
        2,
        "bounds are inclusive"
    );
    assert_eq!(
        q(AuditFilter {
            since: Some(T0 + 31),
            ..base.clone()
        })
        .len(),
        0
    );
    assert_eq!(
        notes(&q(AuditFilter {
            text: Some("GAMMA".into()),
            ..base.clone()
        })),
        ["gamma"],
        "case-insensitive"
    );
    assert_eq!(
        q(AuditFilter {
            text: Some("100%".into()),
            ..base.clone()
        })
        .len(),
        1,
        "wildcards are literal"
    );
    assert_eq!(
        q(AuditFilter {
            text: Some("%".into()),
            ..base.clone()
        })
        .len(),
        1
    );
    assert_eq!(
        notes(&q(AuditFilter {
            limit: Some(2),
            offset: 1,
            ..base.clone()
        })),
        ["gamma", "beta_100%"]
    );
    assert_eq!(
        q(AuditFilter {
            offset: 3,
            ..base.clone()
        })
        .len(),
        1
    );
    assert_eq!(
        audit
            .count(&AuditFilter {
                limit: Some(1),
                ..base.clone()
            })
            .unwrap(),
        4,
        "count ignores paging"
    );
    assert_eq!(audit.team_activity(&f.team.id, Some(2)).unwrap().len(), 2);
    assert_eq!(audit.team_activity(&f.team.id, None).unwrap().len(), 4);
    assert_eq!(
        q(AuditFilter::default()).len(),
        5,
        "no team filter sees all teams"
    );
}

#[test]
fn audit_export_formats() {
    let f = fixture();
    let audit = AuditService::new(f.db.conn());
    insert_at(
        &f,
        AuditEventType::DocEdit,
        Some(&f.user.id),
        None,
        T0,
        &json!({"note": "has, comma \"and quotes\""}),
        None,
    );
    f.db.conn()
        .execute(
            "UPDATE users SET name = '=HYPERLINK(1)' WHERE id = ?1",
            [&f.user.id],
        )
        .unwrap();
    insert_at(
        &f,
        AuditEventType::CodeCommit,
        None,
        None,
        T0 + 1,
        &json!({}),
        None,
    );
    let flt = AuditFilter {
        team_id: Some(f.team.id.clone()),
        oldest_first: true,
        ..AuditFilter::default()
    };

    let json_out = audit.export(&flt, ExportFormat::Json).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json_out).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 2);
    assert_eq!(parsed[0]["event_type"], "doc_edit");
    assert_eq!(
        parsed[0]["actor_name"], "=HYPERLINK(1)",
        "JSON keeps raw values"
    );

    let jsonl = audit.export(&flt, ExportFormat::Jsonl).unwrap();
    assert_eq!(jsonl.lines().count(), 2);
    assert!(jsonl
        .lines()
        .all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));

    let csv = audit.export(&flt, ExportFormat::Csv).unwrap();
    let lines: Vec<_> = csv.split("\r\n").filter(|l| !l.is_empty()).collect();
    assert!(lines[0].starts_with("id,team_id,event_type,actor_id,actor_name"));
    assert_eq!(lines.len(), 3);
    assert!(
        lines[1].contains("'=HYPERLINK(1)"),
        "formula prefix neutralised: {}",
        lines[1]
    );
    assert!(
        lines[1].contains("\"{\"\"note\"\":"),
        "metadata JSON is quoted: {}",
        lines[1]
    );
    assert_eq!(
        audit
            .export(
                &AuditFilter {
                    team_id: Some("none".into()),
                    ..AuditFilter::default()
                },
                ExportFormat::Jsonl
            )
            .unwrap(),
        ""
    );
}

// ---------- feedback ----------

fn formatted() -> FormattedFeedback {
    FormattedFeedback {
        title: "Crash on start".into(),
        body: "## Description\nit crashes".into(),
        category: "bug".into(),
    }
}

#[test]
fn feedback_submit_saves_and_creates_issue() {
    let f = fixture();
    let sub = FakeIssueSubmitter::new();
    let svc = FeedbackService::new(f.db.conn());
    let out = svc
        .submit(
            Some(&sub),
            &f.user.id,
            "it crashes",
            &formatted(),
            "Ada",
            "a@example.com",
        )
        .unwrap();
    assert!(out.submit_error.is_none());
    assert_eq!(out.record.github_issue_number, Some(1));
    assert!(out
        .record
        .github_issue_url
        .as_deref()
        .unwrap()
        .ends_with("/1"));
    let (title, body, category) = sub.submitted().remove(0);
    assert_eq!(
        (title.as_str(), category.as_str()),
        ("Crash on start", "bug")
    );
    assert!(
        body.contains("_Submitted by: Ada (a@example.com)_") && body.contains("_Category: bug_")
    );
    assert_eq!(svc.list_for_user(&f.user.id).unwrap().len(), 1);
    assert_eq!(svc.get(&out.record.id).unwrap().raw_message, "it crashes");
}

#[test]
fn feedback_is_saved_even_if_tracker_fails_or_absent() {
    let f = fixture();
    let svc = FeedbackService::new(f.db.conn());
    let bad = FakeIssueSubmitter::failing();
    let out = svc
        .submit(
            Some(&bad),
            &f.user.id,
            "raw",
            &formatted(),
            "Ada",
            "a@example.com",
        )
        .unwrap();
    assert!(out
        .submit_error
        .unwrap()
        .contains("issue tracker unavailable"));
    assert!(out.record.github_issue_url.is_none() && out.record.github_issue_number.is_none());
    let offline = svc
        .submit(
            None,
            &f.user.id,
            "raw",
            &formatted(),
            "Ada",
            "a@example.com",
        )
        .unwrap();
    assert!(offline.submit_error.is_none() && offline.record.github_issue_url.is_none());
}

#[test]
fn feedback_rate_limit_is_five_per_rolling_day() {
    let f = fixture();
    let (t, clk) = clock();
    let svc = FeedbackService::new(f.db.conn()).with_clock(clk);
    assert_eq!(
        svc.check_rate_limit(&f.user.id).unwrap().remaining,
        MAX_PER_DAY
    );
    for i in 0..MAX_PER_DAY {
        let rl = svc.check_rate_limit(&f.user.id).unwrap();
        assert!(rl.allowed);
        assert_eq!(rl.remaining, MAX_PER_DAY - i);
        svc.submit(None, &f.user.id, "m", &formatted(), "Ada", "a@example.com")
            .unwrap();
    }
    let rl = svc.check_rate_limit(&f.user.id).unwrap();
    assert!(!rl.allowed);
    assert_eq!(rl.remaining, 0);
    let err = svc
        .submit(None, &f.user.id, "m", &formatted(), "Ada", "a@example.com")
        .unwrap_err();
    assert!(matches!(err, nyx_core::Error::Conflict(_)));
    assert_eq!(
        svc.list_for_user(&f.user.id).unwrap().len(),
        5,
        "rejected submit stores nothing"
    );

    let bob = user(&f, "b@example.com", "Bob");
    assert!(svc.check_rate_limit(&bob.id).unwrap().allowed, "per user");

    t.store(T0 + 24 * 60 * 60 * 1000 + 1, Ordering::SeqCst);
    assert_eq!(
        svc.check_rate_limit(&f.user.id).unwrap().remaining,
        MAX_PER_DAY,
        "window rolled"
    );
}

#[test]
fn feedback_validation_and_formatting() {
    let f = fixture();
    let svc = FeedbackService::new(f.db.conn());
    let mut blank = formatted();
    blank.title = "  ".into();
    assert!(svc
        .submit(None, &f.user.id, "m", &blank, "Ada", "a@example.com")
        .is_err());
    assert!(svc
        .submit(None, &f.user.id, " ", &formatted(), "Ada", "a@example.com")
        .is_err());
    assert!(svc.format(&HeuristicFormatter, "").is_err());
    assert!(svc.format(&HeuristicFormatter, &"x".repeat(5001)).is_err());
    let ok = svc
        .format(&HeuristicFormatter, "  The editor is broken\nsecond line")
        .unwrap();
    assert_eq!(ok.title, "The editor is broken");
    assert_eq!(ok.category, "bug");
}
