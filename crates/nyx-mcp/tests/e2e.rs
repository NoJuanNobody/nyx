//! End-to-end: spawn the built `nyx-mcp` binary, speak JSON-RPC over stdio against a temp DB.
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::needless_pass_by_value,
    clippy::many_single_char_names,
    missing_docs
)]

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

struct Client {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    next: i64,
}

impl Client {
    fn spawn(data: &Path, ws: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_nyx-mcp"))
            .arg("--data-dir")
            .arg(data)
            .arg("--workspace")
            .arg(ws)
            .env_remove("NYX_AGENT_ID")
            .env_remove("NYX_DB")
            .env("NYX_SECRETS_PASSPHRASE", "e2e-passphrase")
            .env_remove("NYX_PROVIDER")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn nyx-mcp");
        let stdin = child.stdin.take().expect("stdin");
        let out = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin,
            out,
            next: 1,
        }
    }

    fn send_raw(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").expect("write");
        self.stdin.flush().expect("flush");
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.out.read_line(&mut line).expect("read");
        assert!(!line.is_empty(), "server closed stdout");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad json from server: {e}: {line}"))
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send_raw(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        );
        let r = self.read();
        assert_eq!(r["id"], id, "{r}");
        assert_eq!(r["jsonrpc"], "2.0");
        r
    }

    fn init(&mut self) -> Value {
        let r = self.rpc(
            "initialize",
            json!({"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "e2e-client", "version": "1"}}),
        );
        self.send_raw(
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        );
        r
    }

    /// Call a tool; returns (isError, text).
    fn call(&mut self, name: &str, args: Value) -> (bool, String) {
        let r = self.rpc("tools/call", json!({"name": name, "arguments": args}));
        let res = &r["result"];
        assert!(res.is_object(), "{r}");
        let text = res["content"][0]["text"].as_str().expect("text").to_owned();
        assert_eq!(res["content"][0]["type"], "text");
        (res["isError"] == true, text)
    }

    fn call_json(&mut self, name: &str, args: Value) -> Value {
        let (err, text) = self.call(name, args);
        assert!(!err, "{name} failed: {text}");
        serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{name} returned non-JSON ({e}): {text}"))
    }

    fn finish(mut self) {
        drop(self.stdin);
        let status = self.child.wait().expect("wait");
        assert!(status.success(), "server exited with {status}");
    }
}

fn dirs() -> (tempfile::TempDir, tempfile::TempDir) {
    (
        tempfile::tempdir().expect("data"),
        tempfile::tempdir().expect("ws"),
    )
}

fn id_in(text: &str) -> String {
    let start = text.find("(id: ").expect("id marker") + 5;
    text[start..].split(')').next().expect("id end").to_owned()
}

#[test]
fn initialize_and_tools_list() {
    let (data, ws) = dirs();
    let mut c = Client::spawn(data.path(), ws.path());
    let init = c.init();
    let r = &init["result"];
    assert_eq!(r["protocolVersion"], "2024-11-05");
    assert_eq!(r["serverInfo"]["name"], "nyx");
    assert!(r["capabilities"]["tools"].is_object());
    assert!(r["capabilities"]["resources"].is_object());

    assert_eq!(c.rpc("ping", json!({}))["result"], json!({}));

    let list = c.rpc("tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().expect("tools");
    assert!(tools.len() >= 60, "{} tools", tools.len());
    let mut names = std::collections::HashSet::new();
    for t in tools {
        let name = t["name"].as_str().expect("name");
        assert!(names.insert(name), "duplicate {name}");
        assert!(
            t["description"].as_str().is_some_and(|d| !d.is_empty()),
            "{name}"
        );
        let schema = &t["inputSchema"];
        assert_eq!(schema["type"], "object", "{name}");
        let props = schema["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("{name}: properties"));
        for (k, p) in props {
            let ty = p["type"]
                .as_str()
                .unwrap_or_else(|| panic!("{name}.{k} lacks a type"));
            assert!(
                ["string", "integer", "number", "boolean", "array", "object"].contains(&ty),
                "{name}.{k}: {ty}"
            );
            if ty == "array" {
                assert!(p["items"].is_object(), "{name}.{k} array without items");
            }
        }
        for req in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            assert!(
                props.contains_key(req.as_str().expect("str")),
                "{name}: required {req} undeclared"
            );
        }
        assert!(
            t.get("annotations").is_none(),
            "2024-11-05 clients get no annotations"
        );
    }
    for expected in [
        "nyx_search_docs",
        "nyx_read_doc",
        "nyx_check_quality",
        "nyx_detect_drift",
        "nyx_create_doc",
        "nyx_update_doc",
        "nyx_create_ticket",
        "nyx_get_timeline",
        "nyx_list_teams",
        "nyx_get_team",
        "nyx_create_team",
        "nyx_delete_doc",
        "nyx_list_versions",
        "nyx_web_search",
        "nyx_read_file",
        "nyx_list_files",
        "nyx_credits_balance",
        "nyx_credits_reserve",
        "nyx_credits_commit",
        "nyx_credits_release",
        "nyx_credits_spend",
    ] {
        assert!(names.contains(expected), "{expected} missing");
    }
    // Removed surfaces and TS-only voice tools are absent.
    for gone in [
        "nyx_join_meeting",
        "nyx_leave_meeting",
        "nyx_meeting_status",
        "nyx_generate_meeting_doc",
    ] {
        assert!(!names.contains(gone));
    }
    c.finish();
}

#[test]
fn newer_protocol_versions_get_annotations() {
    let (data, ws) = dirs();
    let mut c = Client::spawn(data.path(), ws.path());
    let r = c.rpc(
        "initialize",
        json!({"protocolVersion": "2025-06-18", "clientInfo": {"name": "x"}}),
    );
    assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
    let r = c.rpc("tools/list", json!({}));
    let first = &r["result"]["tools"][0];
    assert!(first["annotations"]["readOnlyHint"].is_boolean());
    let r = c.rpc("initialize", json!({"protocolVersion": "1999-01-01"}));
    assert_eq!(
        r["result"]["protocolVersion"], "2025-06-18",
        "unknown versions get the newest supported one"
    );
    c.finish();
}

#[test]
fn protocol_errors() {
    let (data, ws) = dirs();
    let mut c = Client::spawn(data.path(), ws.path());
    c.send_raw("{not json");
    let r = c.read();
    assert_eq!(r["error"]["code"], -32700);
    assert_eq!(r["id"], Value::Null);
    assert_eq!(c.rpc("nope/method", json!({}))["error"]["code"], -32601);
    assert_eq!(c.rpc("tools/call", json!({}))["error"]["code"], -32602);
    assert_eq!(c.rpc("resources/read", json!({}))["error"]["code"], -32602);
    // Notifications get no reply: the next response must be to the next request.
    c.send_raw(
        &json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}).to_string(),
    );
    assert_eq!(c.rpc("ping", json!({}))["result"], json!({}));
    // Unknown tools and bad arguments are tool errors, not protocol errors.
    let (err, text) = c.call("nyx_does_not_exist", json!({}));
    assert!(err && text.contains("Unknown tool"), "{text}");
    let (err, text) = c.call("nyx_read_doc", json!({}));
    assert!(err && text.contains("document_id"), "{text}");
    // Batches are answered as batches.
    c.send_raw(&json!([{"jsonrpc": "2.0", "id": 90, "method": "ping"}, {"jsonrpc": "2.0", "id": 91, "method": "ping"}]).to_string());
    let b = c.read();
    assert_eq!(b.as_array().expect("batch").len(), 2);
    c.finish();
}

#[test]
fn document_workflow_branch_merge_export() {
    let (data, ws) = dirs();
    let mut c = Client::spawn(data.path(), ws.path());
    c.init();

    // Team id via the resource (JSON), as an agent would.
    let teams = c.rpc("resources/read", json!({"uri": "nyx://teams"}));
    let teams: Value = serde_json::from_str(
        teams["result"]["contents"][0]["text"]
            .as_str()
            .expect("text"),
    )
    .expect("json");
    let team = teams[0]["id"].as_str().expect("team id").to_owned();

    // Create (TS-style text output).
    let (err, text) = c.call("nyx_create_doc", json!({"team_id": team, "title": "Auth spec", "content": "intro\nline two\noutro\n", "path": "/api/auth"}));
    assert!(!err, "{text}");
    assert!(
        text.starts_with("Document created: \"Auth spec\""),
        "{text}"
    );
    let doc = id_in(&text);

    let (_, text) = c.call("nyx_search_docs", json!({"team_id": team}));
    assert!(
        text.starts_with("1 document:") && text.contains("Auth spec"),
        "{text}"
    );
    let (_, text) = c.call("nyx_read_doc", json!({"document_id": doc}));
    assert!(
        text.starts_with("# Auth spec") && text.contains("line two"),
        "{text}"
    );

    // Version.
    let v = c.call_json("nyx_create_version", json!({"document_id": doc, "content": "intro\nline two edited\noutro\n", "message": "edit"}));
    assert_eq!(v["version"], 2);
    let (_, text) = c.call("nyx_list_versions", json!({"document_id": doc}));
    assert!(
        text.starts_with("2 versions:") && text.contains("v2 — edit"),
        "{text}"
    );

    // Branch and merge conflict.
    let branch = c.call_json(
        "nyx_create_branch",
        json!({"document_id": doc, "name": "alt", "base_version_id": v["id"]}),
    );
    let bid = branch["id"].as_str().expect("branch id").to_owned();
    c.call_json(
        "nyx_update_branch",
        json!({"branch_id": bid, "content": "intro\nline two from branch\noutro\n"}),
    );
    let (_, _) = c.call(
        "nyx_update_doc",
        json!({"document_id": doc, "content": "intro\nline two from head\noutro\n"}),
    );
    c.call_json(
        "nyx_branch_review",
        json!({"branch_id": bid, "action": "submit"}),
    );
    c.call_json(
        "nyx_branch_review",
        json!({"branch_id": bid, "action": "approve"}),
    );
    let attempt = c.call_json("nyx_merge_branch", json!({"branch_id": bid}));
    assert_eq!(attempt["outcome"], "conflicted");
    assert_eq!(attempt["conflicts"][0]["ours"], "line two from head\n");
    assert_eq!(attempt["conflicts"][0]["theirs"], "line two from branch\n");
    let merged = c.call_json(
        "nyx_merge_branch",
        json!({"branch_id": bid, "resolutions": [{"choose": "both"}]}),
    );
    assert_eq!(merged["outcome"], "merged");
    let (_, text) = c.call("nyx_read_doc", json!({"document_id": doc}));
    assert!(
        text.contains("line two from head\nline two from branch\n"),
        "{text}"
    );

    // Export markdown and pdf.
    let md = c.call_json(
        "nyx_export_doc",
        json!({"document_id": doc, "format": "markdown"}),
    );
    assert!(md["content"]
        .as_str()
        .expect("content")
        .contains("line two from branch"));
    let out = c.call_json(
        "nyx_export_doc",
        json!({"document_id": doc, "format": "pdf", "path": "exports/spec.pdf"}),
    );
    assert_eq!(out["path"], "exports/spec.pdf");
    let pdf = std::fs::read(ws.path().join("exports/spec.pdf"))
        .expect("pdf written inside the workspace");
    assert!(pdf.starts_with(b"%PDF"));

    // Timeline mentions the merge.
    let (_, text) = c.call("nyx_get_timeline", json!({"document_id": doc}));
    assert!(text.contains("branch_merged"), "{text}");

    // Resource read of the document.
    let r = c.rpc(
        "resources/read",
        json!({"uri": format!("nyx://docs/{doc}")}),
    );
    assert!(r["result"]["contents"][0]["text"]
        .as_str()
        .expect("text")
        .starts_with("# Auth spec"));
    let r = c.rpc("resources/list", json!({}));
    assert!(r["result"]["resources"].as_array().expect("array").len() >= 3);
    let r = c.rpc("resources/templates/list", json!({}));
    assert_eq!(
        r["result"]["resourceTemplates"]
            .as_array()
            .expect("array")
            .len(),
        6
    );
    c.finish();
}

#[test]
fn credits_reserve_commit_idempotency_over_stdio() {
    let (data, ws) = dirs();
    let mut c = Client::spawn(data.path(), ws.path());
    c.init();
    // The agent identity is the client name.
    let b = c.call_json("nyx_credits_balance", json!({}));
    assert_eq!(b["agentId"], "e2e-client");
    assert_eq!(b["balance"], 500);

    let args = json!({"idempotency_key": "tool-call-0001", "amount": 30, "task_type": "scan"});
    let r1 = c.call_json("nyx_credits_reserve", args.clone());
    let r2 = c.call_json("nyx_credits_reserve", args);
    assert_eq!(r1["replayed"], false);
    assert_eq!(r2["replayed"], true);
    assert_eq!(r1["reservationId"], r2["reservationId"]);
    assert_eq!(
        c.call_json("nyx_credits_balance", json!({}))["balance"],
        470
    );
    let rid = r1["reservationId"].clone();

    let commit =
        json!({"idempotency_key": "tool-call-0002", "reservation_id": rid, "actual_amount": 12});
    assert_eq!(
        c.call_json("nyx_credits_commit", commit.clone())["replayed"],
        false
    );
    assert_eq!(c.call_json("nyx_credits_commit", commit)["replayed"], true);
    let b = c.call_json("nyx_credits_balance", json!({}));
    assert_eq!(
        (
            b["balance"].as_i64(),
            b["totalSpent"].as_i64(),
            b["held"].as_i64()
        ),
        (Some(488), Some(12), Some(0))
    );

    // Exhaustion is a structured, non-fatal tool error.
    let (err, text) = c.call(
        "nyx_credits_reserve",
        json!({"idempotency_key": "tool-call-0003", "amount": 100_000}),
    );
    assert!(
        err && text.contains("insufficient_credits")
            && text.contains("\"available\":488")
            && text.contains("\"required\":100000"),
        "{text}"
    );
    // Changing the payload under a used key conflicts.
    let (err, text) = c.call(
        "nyx_credits_reserve",
        json!({"idempotency_key": "tool-call-0001", "amount": 31}),
    );
    assert!(err && text.contains("idempotency_conflict"), "{text}");
    // Release path.
    let r = c.call_json(
        "nyx_credits_reserve",
        json!({"idempotency_key": "tool-call-0004", "amount": 8}),
    );
    c.call_json(
        "nyx_credits_release",
        json!({"idempotency_key": "tool-call-0005", "reservation_id": r["reservationId"]}),
    );
    assert_eq!(
        c.call_json("nyx_credits_balance", json!({}))["balance"],
        488
    );
    c.finish();
}

#[test]
fn guards_over_stdio() {
    let (data, ws) = dirs();
    std::fs::write(ws.path().join("notes.md"), "# hi").expect("write");
    let mut c = Client::spawn(data.path(), ws.path());
    c.init();
    let (err, text) = c.call("nyx_read_file", json!({"path": "notes.md"}));
    assert!(!err && text.contains("# hi"), "{text}");
    let (err, text) = c.call("nyx_read_file", json!({"path": "../../etc/passwd"}));
    assert!(err && text.contains("path_rejected"), "{text}");
    let (err, text) = c.call("nyx_read_file", json!({"path": "/etc/passwd"}));
    assert!(err && text.contains("path_rejected"), "{text}");
    let (err, text) = c.call("nyx_list_files", json!({"path": ".."}));
    assert!(err && text.contains("path_rejected"), "{text}");
    let (_, text) = c.call("nyx_list_files", json!({}));
    assert!(text.contains("notes.md"), "{text}");
    // Model-backed tools are honest when no provider is configured.
    let (err, text) = c.call("nyx_check_quality", json!({"content": "# spec"}));
    assert!(err && text.contains("not_configured"), "{text}");
    let (err, text) = c.call("nyx_create_doc", json!({"team_id": "x", "title": "t"}));
    assert!(err && text.contains("content"), "{text}");
    c.finish();
}

#[test]
fn state_persists_across_server_processes() {
    let (data, ws) = dirs();
    let mut a = Client::spawn(data.path(), ws.path());
    a.init();
    let teams = a.rpc("resources/read", json!({"uri": "nyx://teams"}));
    let teams: Value = serde_json::from_str(
        teams["result"]["contents"][0]["text"]
            .as_str()
            .expect("text"),
    )
    .expect("json");
    let team = teams[0]["id"].as_str().expect("id").to_owned();
    let (_, text) = a.call(
        "nyx_create_doc",
        json!({"team_id": team, "title": "Kept", "content": "x"}),
    );
    let doc = id_in(&text);
    a.call_json(
        "nyx_credits_spend",
        json!({"idempotency_key": "persist-key-1", "amount": 7}),
    );
    a.finish();

    let mut b = Client::spawn(data.path(), ws.path());
    b.init();
    let (_, text) = b.call("nyx_read_doc", json!({"document_id": doc}));
    assert!(text.contains("# Kept"), "{text}");
    let bal = b.call_json("nyx_credits_balance", json!({}));
    assert_eq!(bal["totalSpent"], 7);
    // The same idempotency key is remembered by the persistent ledger.
    assert_eq!(
        b.call_json(
            "nyx_credits_spend",
            json!({"idempotency_key": "persist-key-1", "amount": 7})
        )["replayed"],
        true
    );
    b.finish();
}
