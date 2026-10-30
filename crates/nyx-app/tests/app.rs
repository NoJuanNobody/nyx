//! Behavioural tests of the service facade: tool catalogue, documents, version control, export,
//! credit metering, guards, and the model-backed tools with a scripted provider.

#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::many_single_char_names,
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::assert_is_empty,
    clippy::manual_assert_eq,
    missing_docs
)]

use std::sync::Arc;

use nyx_app::{
    registry, schema, AppError, AppOptions, Caller, NyxApp, Parity, Services,
};
use nyx_core::ai::{FakeLlm, ModelPair};
use nyx_core::profile::MemorySecretStore;
use serde_json::{json, Value};

struct Fx {
    app: NyxApp,
    caller: Caller,
    ws: tempfile::TempDir,
}

fn fx_with(opts: impl FnOnce(&mut AppOptions), services: Option<Services>) -> Fx {
    let ws = tempfile::tempdir().expect("tempdir");
    let mut o = AppOptions {
        in_memory: true,
        workspace_root: Some(ws.path().to_path_buf()),
        secrets: Some(Arc::new(MemorySecretStore::new())),
        services,
        ..AppOptions::default()
    };
    opts(&mut o);
    Fx {
        app: NyxApp::open(o).expect("open"),
        caller: Caller::named("test-agent"),
        ws,
    }
}

fn fx() -> Fx {
    fx_with(|_| {}, None)
}

impl Fx {
    fn call(&self, name: &str, args: Value) -> Result<Value, AppError> {
        self.app.call_tool(name, &args, &self.caller)
    }
    fn ok(&self, name: &str, args: Value) -> Value {
        self.call(name, args).unwrap_or_else(|e| panic!("{name} failed: {e}"))
    }
    fn err(&self, name: &str, args: Value) -> AppError {
        self.call(name, args).expect_err("expected an error")
    }
    fn team(&self) -> String {
        self.app.team_id().to_owned()
    }
    fn doc(&self, title: &str, content: &str) -> String {
        self.ok("nyx_create_doc", json!({"team_id": self.team(), "title": title, "content": content}))["id"]
            .as_str()
            .expect("id")
            .to_owned()
    }
    fn balance(&self) -> i64 {
        self.ok("nyx_credits_balance", json!({}))["balance"].as_i64().expect("balance")
    }
}

#[test]
fn catalogue_is_consistent() {
    let tools = registry::registry();
    let mut names: Vec<&str> = tools.iter().map(|t| t.name).collect();
    let n = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), n, "duplicate tool names");
    for t in tools {
        assert!(t.name.starts_with("nyx_"), "{}", t.name);
        assert!(!t.description.is_empty());
        schema::check_schema(&t.schema).unwrap_or_else(|e| panic!("{}: {e}", t.name));
    }
    // Every tool of the TS server that has a Rust counterpart keeps its name and required args.
    let ts: &[(&str, &[&str])] = &[
        ("nyx_search_docs", &["team_id"]),
        ("nyx_read_doc", &["document_id"]),
        ("nyx_check_quality", &["content"]),
        ("nyx_detect_drift", &["spec_content", "code_content"]),
        ("nyx_create_doc", &["team_id", "title", "content"]),
        ("nyx_update_doc", &["document_id"]),
        ("nyx_create_ticket", &["document_id", "provider", "title", "body"]),
        ("nyx_get_timeline", &["document_id"]),
        ("nyx_list_teams", &[]),
        ("nyx_get_team", &["team_id"]),
        ("nyx_create_team", &["name", "slug"]),
        ("nyx_delete_doc", &["document_id"]),
        ("nyx_list_versions", &["document_id"]),
        ("nyx_web_search", &["query"]),
        ("nyx_read_file", &["path"]),
        ("nyx_list_files", &[]),
        ("nyx_credits_balance", &[]),
        ("nyx_credits_reserve", &["idempotency_key", "amount"]),
        ("nyx_credits_commit", &["idempotency_key", "reservation_id", "actual_amount"]),
        ("nyx_credits_release", &["idempotency_key", "reservation_id"]),
        ("nyx_credits_spend", &["idempotency_key", "amount"]),
    ];
    for (name, required) in ts {
        let t = registry::find(name).unwrap_or_else(|| panic!("{name} missing"));
        assert_ne!(t.parity, Parity::New, "{name}");
        let req: Vec<&str> = t.schema["required"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(&req, required, "{name} required args differ from the TS schema");
    }
    // Dropped surfaces must not exist.
    for t in tools {
        for banned in ["agent", "chat", "billing", "stripe", "checkout", "purchase", "plan"] {
            assert!(!t.name.contains(banned), "{} looks like a removed surface", t.name);
        }
    }
}

#[test]
fn documents_round_trip() {
    let f = fx();
    let id = f.doc("Auth spec", "# Auth\n\nUsers log in.\n");
    let docs = f.ok("nyx_search_docs", json!({"team_id": f.team()}));
    assert_eq!(docs.as_array().expect("array").len(), 1);
    assert_eq!(docs[0]["title"], "Auth spec");

    let doc = f.ok("nyx_read_doc", json!({"document_id": id}));
    assert_eq!(doc["content"], "# Auth\n\nUsers log in.\n");
    assert_eq!(doc["version"], 1);

    f.ok("nyx_update_doc", json!({"document_id": id, "content": "# Auth v2\n"}));
    let versions = f.ok("nyx_list_versions", json!({"document_id": id}));
    assert_eq!(versions.as_array().expect("array").len(), 2);
    assert_eq!(versions[0]["version"], 2, "newest first");

    let tl = f.ok("nyx_get_timeline", json!({"document_id": id}));
    assert!(!tl.as_array().expect("array").is_empty());

    assert_eq!(f.ok("nyx_delete_doc", json!({"document_id": id}))["success"], true);
    assert_eq!(f.err("nyx_read_doc", json!({"document_id": id})).code, "not_found");
    assert_eq!(f.ok("nyx_search_docs", json!({"team_id": f.team()})), json!([]));
    f.ok("nyx_restore_doc", json!({"document_id": id}));
    assert_eq!(f.ok("nyx_read_doc", json!({"document_id": id}))["title"], "Auth spec");
}

#[test]
fn teams() {
    let f = fx();
    let t = f.ok("nyx_create_team", json!({"name": "Platform", "slug": "platform"}));
    assert_eq!(t["slug"], "platform");
    let list = f.ok("nyx_list_teams", json!({}));
    assert_eq!(list.as_array().expect("array").len(), 2);
    assert_eq!(list[0]["role"], "owner");
    assert_eq!(f.err("nyx_create_team", json!({"name": "X", "slug": "Bad Slug"})).code, "invalid_input");
    assert_eq!(f.err("nyx_create_team", json!({"name": "Dup", "slug": "platform"})).code, "conflict");
    let got = f.ok("nyx_get_team", json!({"team_id": t["id"]}));
    assert_eq!(got["members"].as_array().expect("array").len(), 1);
}

#[test]
fn branch_merge_with_conflict_and_resolution() {
    let f = fx();
    let doc = f.doc("Spec", "line one\nline two\nline three\n");
    let b = f.ok("nyx_create_branch", json!({"document_id": doc, "name": "feature"}));
    let bid = b["id"].as_str().expect("id").to_owned();
    f.ok("nyx_update_branch", json!({"branch_id": bid, "content": "line one\nBRANCH two\nline three\n"}));
    // Head moves on the same line: overlapping edit.
    f.ok("nyx_update_doc", json!({"document_id": doc, "content": "line one\nHEAD two\nline three\n"}));

    // Merge needs approval first.
    assert_eq!(f.err("nyx_merge_branch", json!({"branch_id": bid})).code, "conflict");
    f.ok("nyx_branch_review", json!({"branch_id": bid, "action": "submit"}));
    f.ok("nyx_branch_review", json!({"branch_id": bid, "action": "approve"}));

    let plan = f.ok("nyx_merge_branch", json!({"branch_id": bid, "dry_run": true}));
    assert_eq!(plan["plan"], "conflicted");

    let attempt = f.ok("nyx_merge_branch", json!({"branch_id": bid}));
    assert_eq!(attempt["outcome"], "conflicted");
    assert_eq!(attempt["conflicts"].as_array().expect("array").len(), 1);
    assert!(attempt["markedContent"].as_str().expect("str").contains("<<<<<<<"));
    // Nothing was written.
    assert_eq!(f.ok("nyx_read_doc", json!({"document_id": doc}))["content"], "line one\nHEAD two\nline three\n");

    let merged = f.ok(
        "nyx_merge_branch",
        json!({"branch_id": bid, "resolutions": [{"choose": "custom", "text": "MERGED two\n"}]}),
    );
    assert_eq!(merged["outcome"], "merged");
    assert_eq!(merged["kind"], "resolved");
    assert_eq!(f.ok("nyx_read_doc", json!({"document_id": doc}))["content"], "line one\nMERGED two\nline three\n");
    assert_eq!(f.ok("nyx_get_branch", json!({"branch_id": bid}))["status"], "merged");
}

#[test]
fn clean_merge_and_diff() {
    let f = fx();
    let doc = f.doc("Spec", "a\nb\nc\nd\ne\n");
    let bid = f.ok("nyx_create_branch", json!({"document_id": doc, "name": "x"}))["id"].as_str().expect("id").to_owned();
    f.ok("nyx_update_branch", json!({"branch_id": bid, "content": "a\nb\nc\nd\nE\n"}));
    f.ok("nyx_update_doc", json!({"document_id": doc, "content": "A\nb\nc\nd\ne\n"}));
    let d = f.ok("nyx_diff_branch", json!({"branch_id": bid}));
    assert_eq!(d["diff"]["stats"]["added"], 1);
    f.ok("nyx_branch_review", json!({"branch_id": bid, "action": "submit"}));
    f.ok("nyx_branch_review", json!({"branch_id": bid, "action": "approve"}));
    let m = f.ok("nyx_merge_branch", json!({"branch_id": bid}));
    assert_eq!(m["kind"], "clean");
    assert_eq!(f.ok("nyx_read_doc", json!({"document_id": doc}))["content"], "A\nb\nc\nd\nE\n");

    let vs = f.ok("nyx_list_versions", json!({"document_id": doc}));
    let (newest, oldest) = (vs[0]["id"].as_str().expect("id"), vs.as_array().expect("array").last().expect("last")["id"].as_str().expect("id"));
    let words = f.ok("nyx_diff_versions", json!({"version_a": oldest, "version_b": newest, "format": "words"}));
    assert_eq!(words["identical"], false);
    let u = f.ok("nyx_diff_versions", json!({"version_a": oldest, "version_b": newest, "format": "unified"}));
    assert!(u["unified"].as_str().expect("str").contains("-a"));
    let r = f.ok("nyx_restore_version", json!({"document_id": doc, "version_id": oldest}));
    assert_eq!(r["version"], 4);
}

#[test]
fn snapshots_and_tree_and_lifecycle() {
    let f = fx();
    let doc = f.doc("Plan", "# Plan\n");
    let snaps = f.ok("nyx_create_snapshot", json!({"name": "before", "document_ids": [doc]}));
    let sid = snaps[0]["id"].as_str().expect("id").to_owned();
    f.ok("nyx_update_doc", json!({"document_id": doc, "content": "# Plan changed\n"}));
    let d = f.ok("nyx_diff_snapshot", json!({"snapshot_id": sid}));
    assert_eq!(d["identical"], false);
    f.ok("nyx_restore_snapshot", json!({"snapshot_id": sid}));
    assert_eq!(f.ok("nyx_read_doc", json!({"document_id": doc}))["content"], "# Plan\n");
    assert_eq!(f.ok("nyx_list_snapshots", json!({"document_id": doc})).as_array().expect("array").len(), 1);

    f.ok("nyx_create_folder", json!({"name": "specs"}));
    f.ok("nyx_move_doc", json!({"document_id": doc, "new_parent": "/specs"}));
    let tree = f.ok("nyx_get_tree", json!({}));
    assert!(tree.to_string().contains("specs"));
    assert_eq!(f.err("nyx_delete_folder", json!({"path": "/specs"})).code, "conflict");
    assert_eq!(f.ok("nyx_delete_folder", json!({"path": "/specs", "cascade": true}))["documents_deleted"], 1);

    let pipes = f.ok("nyx_list_pipelines", json!({}));
    assert!(!pipes.as_array().expect("array").is_empty());
    let doc2 = f.doc("Idea", "x");
    let staged = f.ok("nyx_set_stage", json!({"document_id": doc2, "stage": "conception"}));
    assert_eq!(staged["stage"], "conception");
    assert_eq!(f.err("nyx_set_stage", json!({"document_id": doc2, "stage": "nope"})).code, "invalid_input");
    let gate = f.ok("nyx_stage_gate", json!({"document_id": doc2, "target_stage": "definition"}));
    assert_eq!(gate["passed"], false, "content shorter than the minimum");
}

#[test]
fn export_formats() {
    let f = fx();
    let doc = f.doc("My Doc", "# Title\n\nSome **bold** text.\n\n- a\n- b\n");
    let md = f.ok("nyx_export_doc", json!({"document_id": doc, "format": "markdown"}));
    assert!(md["content"].as_str().expect("str").contains("Some **bold** text."));
    assert_eq!(md["fileName"], "My_Doc.md");
    let txt = f.ok("nyx_export_doc", json!({"document_id": doc, "format": "txt"}));
    assert!(!txt["content"].as_str().expect("str").contains("**"));
    let nb = f.ok("nyx_export_doc", json!({"document_id": doc, "format": "jupyter"}));
    let parsed: Value = serde_json::from_str(nb["content"].as_str().expect("str")).expect("notebook json");
    assert_eq!(parsed["nbformat"], 4);
    // Binary formats come back as base64 or land inside the workspace.
    let pdf = f.ok("nyx_export_doc", json!({"document_id": doc, "format": "pdf"}));
    assert!(pdf["base64"].as_str().expect("str").starts_with("JVBER"), "%PDF in base64");
    let w = f.ok("nyx_export_doc", json!({"document_id": doc, "format": "docx", "path": "out/doc.docx"}));
    assert_eq!(w["path"], "out/doc.docx");
    let bytes = std::fs::read(f.ws.path().join("out/doc.docx")).expect("written");
    assert_eq!(&bytes[..2], b"PK");
    let z = f.ok("nyx_export_bundle", json!({"document_ids": [doc], "formats": ["markdown", "latex"]}));
    assert!(z["base64"].as_str().expect("str").starts_with("UEs"), "zip in base64");
    // Escaping the workspace is refused.
    let e = f.err("nyx_export_doc", json!({"document_id": doc, "format": "pdf", "path": "../escape.pdf"}));
    assert_eq!(e.code, "path_rejected");
    assert!(!f.ws.path().parent().expect("parent").join("escape.pdf").exists());
}

#[test]
fn credits_reserve_commit_idempotency() {
    let f = fx();
    let start = f.balance();
    assert_eq!(start, 500, "first sight allocates the default budget");
    let r1 = f.ok("nyx_credits_reserve", json!({"idempotency_key": "key-reserve-1", "amount": 40, "task_type": "t"}));
    assert_eq!(r1["replayed"], false);
    let rid = r1["reservationId"].as_str().expect("rid").to_owned();
    // Retrying with the same key returns the original, no second hold.
    let r2 = f.ok("nyx_credits_reserve", json!({"idempotency_key": "key-reserve-1", "amount": 40, "task_type": "t"}));
    assert_eq!(r2["replayed"], true);
    assert_eq!(r2["reservationId"], rid);
    assert_eq!(f.balance(), 460);
    assert_eq!(f.ok("nyx_credits_balance", json!({}))["held"], 40);
    // A different payload under the same key conflicts.
    assert_eq!(
        f.err("nyx_credits_reserve", json!({"idempotency_key": "key-reserve-1", "amount": 41})).code,
        "idempotency_conflict"
    );
    // Commit less than reserved: the remainder returns.
    f.ok("nyx_credits_commit", json!({"idempotency_key": "key-commit-1", "reservation_id": rid, "actual_amount": 15}));
    let again = f.ok("nyx_credits_commit", json!({"idempotency_key": "key-commit-1", "reservation_id": rid, "actual_amount": 15}));
    assert_eq!(again["replayed"], true);
    assert_eq!(f.balance(), 485);
    assert_eq!(f.ok("nyx_credits_balance", json!({}))["totalSpent"], 15);
    // Over-committing a closed reservation is refused.
    assert!(f.call("nyx_credits_commit", json!({"idempotency_key": "key-commit-2", "reservation_id": rid, "actual_amount": 1})).is_err());
    // Release returns everything.
    let r3 = f.ok("nyx_credits_reserve", json!({"idempotency_key": "key-reserve-2", "amount": 10}));
    f.ok("nyx_credits_release", json!({"idempotency_key": "key-release-1", "reservation_id": r3["reservationId"]}));
    assert_eq!(f.balance(), 485);
    // One-shot spend is retry safe too.
    let s = f.ok("nyx_credits_spend", json!({"idempotency_key": "key-spend-1", "amount": 5}));
    assert_eq!(s["spent"], 5);
    assert_eq!(f.ok("nyx_credits_spend", json!({"idempotency_key": "key-spend-1", "amount": 5}))["replayed"], true);
    assert_eq!(f.balance(), 480);
}

#[test]
fn credits_exhaustion_reports_available_and_required() {
    let f = fx();
    let e = f.err("nyx_credits_reserve", json!({"idempotency_key": "key-too-much", "amount": 9999}));
    assert_eq!(e.code, "insufficient_credits");
    let j = e.to_json();
    assert_eq!(j["available"], 500);
    assert_eq!(j["required"], 9999);
    // Argument validation mirrors the zod schemas.
    assert_eq!(f.err("nyx_credits_reserve", json!({"idempotency_key": "short", "amount": 1})).code, "invalid_input");
    assert_eq!(f.err("nyx_credits_reserve", json!({"idempotency_key": "long-enough-key", "amount": 0})).code, "invalid_input");
    assert_eq!(f.err("nyx_credits_reserve", json!({"idempotency_key": "long-enough-key", "amount": 1, "extra": 1})).code, "invalid_input");
    assert_eq!(f.err("nyx_credits_balance", json!({"agent_id": "has space"})).code, "invalid_input");
}

#[test]
fn agents_have_separate_budgets() {
    let f = fx();
    f.ok("nyx_credits_spend", json!({"idempotency_key": "key-spend-a", "amount": 100}));
    assert_eq!(f.balance(), 400);
    let other = f.app.call_tool("nyx_credits_balance", &json!({}), &Caller::named("cursor")).expect("balance");
    // The pool held 1000, 500 went to the first agent, the second takes the next 500.
    assert_eq!(other["balance"], 500);
    assert_eq!(other["pool"], 0);
    let third = f.app.call_tool("nyx_credits_balance", &json!({}), &Caller::named("third")).expect("balance");
    assert_eq!(third["balance"], 0, "pool is empty: unknown agents start at zero");
}

#[test]
fn offline_model_tools_are_honest_and_free() {
    let f = fx();
    let before = f.ok("nyx_credits_balance", json!({}))["entries"].as_u64().expect("n");
    let e = f.err("nyx_check_quality", json!({"content": "x"}));
    assert_eq!(e.code, "not_configured");
    assert_eq!(f.err("nyx_web_search", json!({"query": "rust"})).code, "not_configured");
    let doc = f.doc("D", "x");
    assert_eq!(
        f.err("nyx_create_ticket", json!({"document_id": doc, "provider": "github", "title": "t", "body": "b", "destination": "o/r"})).code,
        "not_configured"
    );
    // Failed prechecks leave the ledger untouched (create_ticket reserved and released: net zero).
    assert_eq!(f.balance(), 500);
    assert!(f.ok("nyx_credits_balance", json!({}))["entries"].as_u64().expect("n") >= before);
}

#[test]
fn metered_tools_commit_on_success_and_release_on_failure() {
    let llm = Arc::new(FakeLlm::with_texts(&[r#"{"score": 8, "suggestions": ["Add acceptance criteria"]}"#]));
    let services = Services::offline().with_llm(
        llm.clone(),
        ModelPair { default: "m".into(), fast: "f".into() },
    );
    let f = fx_with(|_| {}, Some(services));
    let q = f.ok("nyx_check_quality", json!({"content": "# Spec"}));
    assert_eq!(q["score"], 8.0);
    assert_eq!(f.balance(), 497, "3 credits committed");
    assert_eq!(f.ok("nyx_credits_balance", json!({}))["totalSpent"], 3);
    // Provider failure (script exhausted): the hold is released, nothing is spent.
    let e = f.err("nyx_check_quality", json!({"content": "# Spec"}));
    assert_eq!(e.code, "provider_error");
    assert_eq!(f.balance(), 497);
    assert_eq!(f.ok("nyx_credits_balance", json!({}))["held"], 0);
    assert_eq!(llm.call_count(), 2);
}

#[test]
fn cost_overrides_and_budget_exhaustion() {
    let llm = Arc::new(FakeLlm::with_texts(&[r#"{"score": 6, "suggestions": []}"#; 3]));
    let services = Services::offline().with_llm(llm, ModelPair { default: "m".into(), fast: "f".into() });
    let f = fx_with(
        |o| {
            o.initial_grant = 10;
            o.auto_allocate = 10;
            o.cost_overrides.insert("nyx_check_quality".into(), 4);
            o.cost_overrides.insert("nyx_list_teams".into(), 0);
        },
        Some(services),
    );
    f.ok("nyx_check_quality", json!({"content": "a"}));
    f.ok("nyx_check_quality", json!({"content": "a"}));
    assert_eq!(f.balance(), 2);
    let e = f.err("nyx_check_quality", json!({"content": "a"}));
    assert_eq!(e.code, "insufficient_credits");
    assert_eq!(e.to_json()["required"], 4);
    // Free tools keep working with an empty budget.
    f.ok("nyx_list_teams", json!({}));
}

#[test]
fn drift_check_stores_findings() {
    let reply = r#"{"hasDrift": true, "driftScore": 6, "details": "login no longer validates", "suggestions": ["update spec"]}"#;
    let llm = Arc::new(FakeLlm::with_texts(&[reply]));
    let services = Services::offline().with_llm(llm, ModelPair { default: "m".into(), fast: "f".into() });
    let f = fx_with(|_| {}, Some(services));
    let d = f.doc("Auth", "# Auth\n\nImplemented in src/auth.rs: users log in with a password.\n");
    std::fs::create_dir_all(f.ws.path().join("src")).expect("mkdir");
    std::fs::write(f.ws.path().join("src/auth.rs"), "pub fn login() {}\n").expect("write");
    let r = f.ok("nyx_drift_check", json!({"changed_files": ["src/auth.rs"]}));
    assert_eq!(r["evaluated"].as_array().expect("array").len(), 1, "{r}");
    let open = f.ok("nyx_list_drift", json!({}));
    assert_eq!(open[0]["document_id"], d);
    assert_eq!(open[0]["has_drift"], true);
    // Same content again: idempotent, no second record, no second model call.
    f.ok("nyx_drift_check", json!({"changed_files": ["src/auth.rs"]}));
    assert_eq!(f.ok("nyx_list_drift", json!({"document_id": d})).as_array().expect("array").len(), 1);
    let id = open[0]["id"].as_str().expect("id");
    assert_eq!(f.ok("nyx_set_drift_status", json!({"drift_id": id, "status": "resolved"}))["status"], "resolved");
    assert_eq!(f.ok("nyx_list_drift", json!({})), json!([]));
}

#[test]
fn guards_reject_bad_input_and_redact_errors() {
    let f = fx();
    // Path jail.
    std::fs::write(f.ws.path().join("ok.md"), "hello").expect("write");
    let r = f.ok("nyx_read_file", json!({"path": "ok.md"}));
    assert_eq!(r["content"], "hello");
    assert_eq!(r["extension"], "md");
    for bad in ["../outside.txt", "/etc/passwd", "a/../../b", "x\\y"] {
        let e = f.err("nyx_read_file", json!({"path": bad}));
        assert_eq!(e.code, "path_rejected", "{bad}");
    }
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().expect("tempdir");
        std::fs::write(outside.path().join("secret.txt"), "s").expect("write");
        std::os::unix::fs::symlink(outside.path(), f.ws.path().join("link")).expect("symlink");
        assert_eq!(f.err("nyx_read_file", json!({"path": "link/secret.txt"})).code, "path_rejected");
        assert_eq!(f.err("nyx_list_files", json!({"path": "link"})).code, "path_rejected");
    }
    std::fs::write(f.ws.path().join("big.txt"), vec![b'a'; 200 * 1024]).expect("write");
    assert_eq!(f.err("nyx_read_file", json!({"path": "big.txt"})).code, "invalid_input");
    let l = f.ok("nyx_list_files", json!({}));
    assert!(l.to_string().contains("ok.md"));
    // Schema validation.
    assert_eq!(f.err("nyx_read_doc", json!({})).code, "invalid_input");
    assert_eq!(f.err("nyx_read_doc", json!({"document_id": 5})).code, "invalid_input");
    assert_eq!(f.err("nyx_export_doc", json!({"document_id": "x", "format": "exe"})).code, "invalid_input");
    assert_eq!(f.err("nyx_nope", json!({})).code, "not_found");
    // Control characters and path-like ids never reach SQL.
    assert_eq!(f.err("nyx_read_doc", json!({"document_id": "a/b"})).code, "invalid_input");
    let t = f.team();
    assert_eq!(f.err("nyx_create_doc", json!({"team_id": t, "title": "bad\u{0}", "content": "x"})).code, "invalid_input");
    // Secrets in error text are redacted.
    let e = f.err("nyx_get_team", json!({"team_id": "sk-ant-api03-abcdefghijklmnopqrstuvwx"}));
    assert!(!e.message.contains("sk-ant-api03"), "{}", e.message);
    // Integration config may not carry credentials.
    let e = f.err("nyx_integration_set", json!({"type": "jira", "config": {"projectKey": "P", "apiToken": "abc"}}));
    assert_eq!(e.code, "invalid_input");
    let ok = f.ok("nyx_integration_set", json!({"type": "github", "config": {"repo": "o/r"}}));
    assert_eq!(ok["config"]["repo"], "o/r");
    assert_eq!(f.ok("nyx_integrations_list", json!({})).as_array().expect("array").len(), 1);
}

#[test]
fn rate_limit_applies_per_caller() {
    let f = fx_with(|o| o.rate_limit = (3, std::time::Duration::from_secs(60)), None);
    for _ in 0..3 {
        f.ok("nyx_list_teams", json!({}));
    }
    let e = f.err("nyx_list_teams", json!({}));
    assert_eq!(e.code, "rate_limited");
    assert!(e.to_json()["retry_after_ms"].as_u64().is_some());
    // Another caller has its own window.
    assert!(f.app.call_tool("nyx_list_teams", &json!({}), &Caller::named("other")).is_ok());
}

#[test]
fn scan_search_audit_and_misc() {
    let f = fx();
    std::fs::create_dir_all(f.ws.path().join("src")).expect("mkdir");
    std::fs::write(f.ws.path().join("src/lib.rs"), "pub fn fibonacci(n: u32) -> u32 { if n < 2 { n } else { fibonacci(n - 1) + fibonacci(n - 2) } }\n").expect("write");
    std::fs::write(f.ws.path().join("README.md"), "# Demo\n\nA demo crate.\n").expect("write");
    let plan = f.ok("nyx_scan", json!({"plan_only": true}));
    assert!(plan["wouldIndex"].as_u64().expect("n") >= 2);
    assert_eq!(f.balance(), 500, "planning is free");
    let report = f.ok("nyx_scan", json!({}));
    assert!(report["chunks_created"].as_u64().expect("n") >= 2, "{report}");
    let spent = report["creditsSpent"].as_i64().expect("spent");
    assert!(spent >= 2);
    assert_eq!(f.balance(), 500 - spent);
    let hits = f.ok("nyx_search_code", json!({"query": "fibonacci"}));
    assert!(hits.to_string().contains("fibonacci"));
    // Second scan: nothing new to embed, nothing to pay.
    let again = f.ok("nyx_scan", json!({}));
    assert_eq!(again["creditsSpent"], 0);

    f.doc("Payments", "# Payments\n\nCards are charged through the processor.\n");
    f.doc("Login", "# Login\n\nUsers authenticate with a password.\n");
    let s = f.ok("nyx_search", json!({"query": "password authenticate", "mode": "keyword"}));
    assert_eq!(s["results"][0]["title"], "Login");

    let log = f.ok("nyx_audit_log", json!({}));
    assert!(log["total"].as_u64().expect("n") >= 2);
    let csv = f.ok("nyx_audit_export", json!({"format": "csv"}));
    assert!(csv["content"].as_str().expect("str").contains("doc_edit"));

    let leak = f.ok("nyx_scan_secrets", json!({"content": "aws = AKIAABCDEFGHIJKLMNOP"}));
    assert_eq!(leak["clean"], false);

    let a = f.ok("nyx_approval_request", json!({"action": "merge", "resource_id": "branch-1"}));
    let rev = f.ok("nyx_approval_review", json!({"approval_id": a["id"], "decision": "approve"}));
    assert!(rev["status"] == "approved" || rev["status"] == "pending", "{rev}");
    assert!(f.ok("nyx_approvals_list", json!({})).as_array().expect("array").len() == 1);
    assert!(f.ok("nyx_notifications", json!({}))["items"].is_array());
    assert_eq!(f.ok("nyx_whoami", json!({}))["mode"], "local");
}

#[test]
fn impact_graph() {
    let f = fx();
    let d = f.doc("Spec", "x");
    f.ok("nyx_impact_link", json!({"src_kind": "spec", "src": d, "dst_kind": "file", "dst": "src/a.rs", "relation": "implements", "weight": 0.9}));
    let i = f.ok("nyx_impact", json!({"kind": "file", "ref": "src/a.rs"}));
    assert_eq!(i["specs"][0]["node"]["id"], d.as_str());
    assert_eq!(f.err("nyx_impact_link", json!({"src_kind": "spec", "src": d, "dst_kind": "spec", "dst": d})).code, "invalid_input");
}

#[test]
fn resources() {
    let f = fx();
    let d = f.doc("Readme", "body text");
    let res = f.app.list_resources().expect("list");
    assert!(res.iter().any(|r| r["uri"] == format!("nyx://docs/{d}")));
    let c = f.app.read_resource(&format!("nyx://docs/{d}"), &f.caller).expect("read");
    assert_eq!(c.mime_type, "text/markdown");
    assert_eq!(c.text, "# Readme\n\nbody text");
    let v = f.app.read_resource(&format!("nyx://docs/{d}/versions"), &f.caller).expect("read");
    assert!(v.text.contains("\"version\": 1"));
    assert!(f.app.read_resource("nyx://teams", &f.caller).is_ok());
    assert!(f.app.read_resource("nyx://unknown", &f.caller).is_err());
    std::fs::write(f.ws.path().join("n.json"), "{}").expect("write");
    assert_eq!(f.app.read_resource("file://n.json", &f.caller).expect("read").mime_type, "application/json");
    assert!(f.app.read_resource("file://../x", &f.caller).is_err());
}

#[test]
fn file_backed_database_persists_and_is_shared() {
    let dir = tempfile::tempdir().expect("tempdir");
    let open = || {
        NyxApp::open(AppOptions {
            data_dir: Some(dir.path().to_path_buf()),
            workspace_root: Some(dir.path().to_path_buf()),
            secrets: Some(Arc::new(MemorySecretStore::new())),
            ..AppOptions::default()
        })
        .expect("open")
    };
    let c = Caller::named("agent-1");
    let id = {
        let app = open();
        app.call_tool("nyx_create_doc", &json!({"team_id": app.team_id(), "title": "Persisted", "content": "x"}), &c).expect("create")["id"]
            .as_str()
            .expect("id")
            .to_owned()
    };
    // Reopen (migrations, local identity and the first-run grant are idempotent).
    let app = open();
    assert_eq!(app.call_tool("nyx_read_doc", &json!({"document_id": id}), &c).expect("read")["title"], "Persisted");
    let b = app.call_tool("nyx_credits_balance", &json!({}), &c).expect("balance");
    assert_eq!(b["pool"].as_i64().expect("pool") + b["balance"].as_i64().expect("b"), 1000);
    let conn = rusqlite_conn(dir.path());
    nyx_app::credits::verify(&conn).expect("ledger chain verifies");
}

fn rusqlite_conn(dir: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.join("nyx.db")).expect("open db")
}
