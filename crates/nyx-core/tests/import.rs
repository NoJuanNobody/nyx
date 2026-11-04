#![allow(
    clippy::assert_is_empty,
    clippy::many_single_char_names,
    clippy::similar_names,
    clippy::unwrap_used,
    clippy::expect_used,
    missing_docs
)]
use nyx_core::store::import::{import_postgres_json, parse_timestamp};
use nyx_core::store::*;
use serde_json::json;

#[test]
fn timestamp_parsing_handles_postgres_and_rfc3339() {
    assert_eq!(parse_timestamp("1970-01-01T00:00:00Z").unwrap(), 0);
    assert_eq!(
        parse_timestamp("2026-10-30T12:34:56.789Z").unwrap(),
        1_793_363_696_789
    );
    assert_eq!(
        parse_timestamp("2026-10-30 12:34:56.789+00").unwrap(),
        1_793_363_696_789
    );
    assert_eq!(
        parse_timestamp("2026-10-30 14:34:56.789+02:00").unwrap(),
        1_793_363_696_789
    );
    assert_eq!(
        parse_timestamp("2026-10-30T07:34:56.789123-05").unwrap(),
        1_793_363_696_789
    );
    assert_eq!(
        parse_timestamp("2000-03-01T00:00:00Z").unwrap(),
        951_868_800_000
    );
    assert!(parse_timestamp("yesterday").is_err());
}

fn export() -> serde_json::Value {
    json!({
        "users": [{"id":"u1","clerk_id":"clerk_x","email":"a@x.io","name":"Ada","avatar_url":null,
                   "created_at":"2026-01-01 00:00:00+00","updated_at":"2026-01-01T00:00:00Z"}],
        "teams": [{"id":"t1","name":"Core","slug":"core","default_model":"x","fast_model":null,
                   "created_at":"2026-01-01 00:00:00+00","updated_at":"2026-01-01 00:00:00+00"}],
        "team_members": [{"id":"m1","team_id":"t1","user_id":"u1","role":"owner","joined_at":"2026-01-01 00:00:00+00"}],
        "lifecycles": [{"id":"l1","slug":"std","label":"Standard","is_default":true,"sort_order":0,"created_at":"2026-01-01 00:00:00+00"}],
        "lifecycle_stages": [{"id":"s1","lifecycle_id":"l1","slug":"conception","label":"Conception","docs":["PRD"],"sort_order":1}],
        "documents": [{"id":"d1","title":"Spec","content":"hello","path":"/","team_id":"t1","created_by_id":"u1","stage":"conception",
                       "lifecycle_id":"l1","created_at":"2026-01-02 00:00:00+00","updated_at":"2026-01-02 00:00:00+00","deleted_at":null}],
        "document_versions": [
            {"id":"v1","document_id":"d1","version":1,"content":"hi","message":null,"created_by_id":"u1","created_at":"2026-01-02 00:00:00+00"},
            {"id":"v2","document_id":"d1","version":2,"content":"hello","message":"edit","created_by_id":"u1","created_at":"2026-01-03 00:00:00+00"}],
        "document_branches": [{"id":"b1","document_id":"d1","name":"feat","base_version_id":"v1","content":"x","created_by_id":"u1","status":"draft",
                               "created_at":"2026-01-03 00:00:00+00","merged_at":null}],
        "integrations": [{"id":"i1","team_id":"t1","type":"github","config":{"repo":"a/b"},"created_at":"2026-01-01 00:00:00+00","updated_at":"2026-01-01 00:00:00+00"}],
        "tickets": [{"id":"k1","document_id":"d1","provider":"github","external_id":"7","external_url":"u","title":"T","body":"",
                     "status":"open","claude_insights":"{\"a\":1}","created_by_id":"u1","created_at":"2026-01-03 00:00:00+00","updated_at":"2026-01-03 00:00:00+00"}],
        "audit_trail": [
            {"id":"e2","team_id":"t1","event_type":"code_commit","parent_event_id":"e1","metadata":{},"created_at":"2026-01-04 00:00:00+00"},
            {"id":"e1","team_id":"t1","event_type":"doc_edit","document_id":"d1","metadata":{"v":2},"created_at":"2026-01-03 00:00:00+00"},
            {"id":"e3","team_id":"t1","event_type":"agent_workflow","metadata":{},"created_at":"2026-01-05 00:00:00+00"}],
        "doc_chunks": [{"id":"c1","doc_id":"d1","org_id":"t1","content":"hello","embedding":"[0.5,0.25,1]","version":2,"chunk_index":0,"created_at":"2026-01-03 00:00:00+00"}],
        "agent_sessions": [{"id":"a1"}],
        "credit_balances": [{"id":"cb"}],
        "stripe_events": []
    })
}

#[test]
fn imports_a_postgres_export() {
    let mut db = Db::open_in_memory().unwrap();
    let report = import_postgres_json(&mut db, &export()).unwrap();

    assert_eq!(report.inserted["users"], 1);
    assert_eq!(report.inserted["document_versions"], 2);
    assert_eq!(
        report.inserted["audit_trail"], 2,
        "child listed before parent still lands"
    );
    assert_eq!(
        report.ignored_tables,
        ["agent_sessions", "credit_balances", "stripe_events"]
    );
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].table, "audit_trail");
    assert_eq!(
        report.skipped[0].id.as_deref(),
        Some("e3"),
        "removed agent_workflow event is skipped, not fatal"
    );

    let c = db.conn();
    let docs = SqliteDocuments::new(c);
    let d = docs.get("d1").unwrap();
    assert_eq!(
        (d.content.as_str(), d.stage.as_deref()),
        ("hello", Some("conception"))
    );
    assert_eq!(d.created_at, 1_767_312_000_000);
    assert_eq!(docs.latest_version("d1").unwrap().version, 2);
    let st = SqliteLifecycles::new(c).stages("l1").unwrap();
    assert_eq!(st[0].docs, vec!["PRD"]);
    assert_eq!(st[0].hex, "#888888", "missing columns take schema defaults");
    assert!(
        SqliteLifecycles::new(c)
            .default_lifecycle()
            .unwrap()
            .unwrap()
            .is_default
    );
    assert_eq!(
        SqliteTickets::new(c).get("k1").unwrap().insights.unwrap()["a"],
        1
    );
    assert_eq!(
        SqliteIntegrations::new(c).get("i1").unwrap().config["repo"],
        "a/b"
    );
    assert_eq!(
        SqliteBranches::new(c).get("b1").unwrap().base_version_id,
        "v1"
    );
    let chunk = &SqliteChunks::new(c).doc_chunks("d1", 2).unwrap()[0];
    assert_eq!(chunk.embedding.as_deref(), Some(&[0.5, 0.25, 1.0][..]));
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM credit_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "credits are never imported");
    docs.save_content("d1", "again", None, "u1").unwrap();
    assert_eq!(docs.latest_version("d1").unwrap().version, 3);
}

#[test]
fn rows_with_missing_parents_are_skipped_and_reported() {
    let mut db = Db::open_in_memory().unwrap();
    let report = import_postgres_json(
        &mut db,
        &json!({"documents": [{"id":"d","title":"x","team_id":"nope","created_by_id":"nope","created_at":1,"updated_at":1}]}),
    )
    .unwrap();
    assert!(report.inserted.is_empty());
    assert_eq!(report.skipped.len(), 1);
    assert!(report.skipped[0]
        .reason
        .to_lowercase()
        .contains("foreign key"));
    assert!(import_postgres_json(&mut db, &json!([1])).is_err());
}
