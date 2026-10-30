//! CLI behaviour: spawn the built `nyx` binary against a temp data dir.
#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::many_single_char_names,
    missing_docs
)]

use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};

struct Env {
    data: tempfile::TempDir,
}

impl Env {
    fn new() -> Self {
        Self {
            data: tempfile::tempdir().expect("tempdir"),
        }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_nyx"));
        c.arg("--data-dir")
            .arg(self.data.path())
            .arg("--workspace")
            .arg(self.data.path())
            .args(args)
            .env("NYX_SECRETS_PASSPHRASE", "cli-test")
            .env_remove("NYX_AGENT_ID")
            .env_remove("NYX_DB")
            .env_remove("NYX_PROVIDER");
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().expect("run nyx")
    }

    fn run_stdin(&self, args: &[&str], input: &str) -> Output {
        let mut child = self
            .cmd(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(input.as_bytes())
            .expect("write");
        child.wait_with_output().expect("wait")
    }

    /// Run with `--json`, expect success, parse stdout.
    fn json(&self, args: &[&str]) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let out = self.run(&a);
        assert!(
            out.status.success(),
            "{args:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
            panic!(
                "{args:?} not JSON ({e}): {}",
                String::from_utf8_lossy(&out.stdout)
            )
        })
    }

    fn code(&self, args: &[&str]) -> (i32, Value) {
        let mut a = args.to_vec();
        a.push("--json");
        let out = self.run(&a);
        let v = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
        (out.status.code().expect("exit code"), v)
    }

    fn write(&self, rel: &str, body: &str) {
        let p = self.data.path().join(rel);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        std::fs::write(p, body).expect("write");
    }

    fn path(&self, rel: &str) -> std::path::PathBuf {
        Path::new(self.data.path()).join(rel)
    }
}

fn text(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

#[test]
fn doc_lifecycle_and_exit_codes() {
    let e = Env::new();
    let created = e.json(&[
        "doc",
        "create",
        "--title",
        "Spec",
        "--content",
        "line a\nline b\n",
    ]);
    let id = created["id"].as_str().expect("id").to_owned();
    assert_eq!(e.json(&["doc", "list"]).as_array().expect("array").len(), 1);

    // Human output is the TS-style text.
    let shown = e.run(&["doc", "show", &id]);
    assert!(shown.status.success());
    assert!(text(&shown).starts_with("# Spec"), "{}", text(&shown));

    e.write("body.md", "from a file\n");
    e.json(&["doc", "update", &id, "--file", "body.md"]);
    assert_eq!(
        e.json(&["version", "list", &id])
            .as_array()
            .expect("array")
            .len(),
        2
    );

    // Exit codes.
    let (code, err) = e.code(&["doc", "show", "missing-id"]);
    assert_eq!((code, err["error"].as_str()), (3, Some("not_found")));
    let (code, _) = e.code(&["doc", "create", "--title", "x", "--file", "../outside.md"]);
    assert_eq!(code, 7, "jail rejection");
    let (code, err) = e.code(&["quality", "body.md"]);
    assert_eq!((code, err["error"].as_str()), (8, Some("not_configured")));
    let (code, _) = e.code(&["branch", "show", "nope"]);
    assert_eq!(code, 3);
    let usage = e.run(&["doc", "frobnicate"]);
    assert_eq!(usage.status.code(), Some(2));

    e.json(&["doc", "delete", &id]);
    assert_eq!(e.json(&["doc", "list"]), json!([]));
}

#[test]
fn branch_diff_merge_conflict_flow() {
    let e = Env::new();
    let id = e.json(&[
        "doc",
        "create",
        "--title",
        "Spec",
        "--content",
        "one\ntwo\nthree\n",
    ])["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let b = e.json(&["branch", "create", &id, "alt"]);
    let bid = b["id"].as_str().expect("id").to_owned();
    e.json(&["branch", "edit", &bid, "--content", "one\nBRANCH\nthree\n"]);
    e.json(&["doc", "update", &id, "--content", "one\nHEAD\nthree\n"]);
    e.json(&["branch", "submit", &bid]);
    e.json(&["branch", "approve", &bid]);

    let d = e.json(&["diff", "branch", &bid]);
    assert_eq!(d["diff"]["stats"]["added"], 1);

    // Plain merge reports the conflict and exits 4 without writing.
    let out = e.run(&["merge", &bid, "--json"]);
    assert_eq!(out.status.code(), Some(4));
    let v: Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(v["outcome"], "conflicted");
    assert!(e
        .run(&["doc", "show", &id])
        .stdout
        .windows(4)
        .any(|w| w == b"HEAD"));

    // Resolve all conflicts at once.
    let merged = e.json(&["merge", &bid, "--resolve", "theirs"]);
    assert_eq!(merged["outcome"], "merged");
    let shown = text(&e.run(&["doc", "show", &id]));
    assert!(
        shown.contains("BRANCH") && !shown.contains("HEAD"),
        "{shown}"
    );

    // Explicit resolutions file.
    let id2 = e.json(&[
        "doc",
        "create",
        "--title",
        "Other",
        "--content",
        "a\nb\nc\n",
    ])["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let b2 = e.json(&["branch", "create", &id2, "x"])["id"]
        .as_str()
        .expect("id")
        .to_owned();
    e.json(&["branch", "edit", &b2, "--content", "a\nX\nc\n"]);
    e.json(&["doc", "update", &id2, "--content", "a\nY\nc\n"]);
    e.json(&["branch", "submit", &b2]);
    e.json(&["branch", "approve", &b2]);
    e.write("res.json", r#"[{"choose":"custom","text":"Z\n"}]"#);
    let m = e.json(&["merge", &b2, "--resolutions", "res.json"]);
    assert_eq!(m["kind"], "resolved");
}

#[test]
fn export_and_files() {
    let e = Env::new();
    let id = e.json(&[
        "doc",
        "create",
        "--title",
        "My Doc",
        "--content",
        "# T\n\nbody **bold**\n",
    ])["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let md = e.run(&["export", &id, "--format", "md"]);
    assert!(md.status.success());
    assert_eq!(text(&md), "# T\n\nbody **bold**\n");
    let o = e.run(&["export", &id, "--format", "pdf"]);
    assert_eq!(
        o.status.code(),
        Some(2),
        "refuse to print binary to a terminal"
    );
    e.json(&["export", &id, "--format", "pdf", "--out", "out/spec.pdf"]);
    assert!(std::fs::read(e.path("out/spec.pdf"))
        .expect("pdf")
        .starts_with(b"%PDF"));
    e.json(&[
        "bundle",
        &id,
        "--formats",
        "markdown",
        "latex",
        "--out",
        "bundle.zip",
    ]);
    assert!(std::fs::read(e.path("bundle.zip"))
        .expect("zip")
        .starts_with(b"PK"));
    let (code, _) = e.code(&["export", &id, "--format", "pdf", "--out", "../escape.pdf"]);
    assert_eq!(code, 7);
}

#[test]
fn credits_commands() {
    let e = Env::new();
    let b = e.json(&["credits", "balance"]);
    assert_eq!(b["balance"], 500);
    let r = e.json(&[
        "credits",
        "reserve",
        "50",
        "--idempotency-key",
        "cli-key-reserve-1",
        "--task-type",
        "scan",
    ]);
    let rid = r["reservationId"].as_str().expect("rid").to_owned();
    let r2 = e.json(&[
        "credits",
        "reserve",
        "50",
        "--idempotency-key",
        "cli-key-reserve-1",
        "--task-type",
        "scan",
    ]);
    assert_eq!(r2["replayed"], true);
    let c = e.json(&[
        "credits",
        "commit",
        &rid,
        "20",
        "--idempotency-key",
        "cli-key-commit-1",
    ]);
    assert_eq!(c["replayed"], false);
    assert_eq!(e.json(&["credits", "balance"])["balance"], 480);
    let s = e.json(&[
        "credits",
        "spend",
        "5",
        "--idempotency-key",
        "cli-key-spend-1",
    ]);
    assert_eq!(s["spent"], 5);
    let (code, err) = e.code(&[
        "credits",
        "spend",
        "99999",
        "--idempotency-key",
        "cli-key-spend-2",
    ]);
    assert_eq!(code, 5);
    assert_eq!(err["error"], "insufficient_credits");
    assert_eq!(err["required"], 99999);
    // Owner actions.
    e.json(&[
        "credits",
        "grant",
        "100",
        "--idempotency-key",
        "cli-key-grant-1",
    ]);
    e.json(&[
        "credits",
        "allocate",
        "other-agent",
        "60",
        "--idempotency-key",
        "cli-key-alloc-1",
    ]);
    let other = e.json(&["--agent", "other-agent", "credits", "balance"]);
    // 60 allocated by the owner, plus the first-sight budget of 500 (pool: 100 granted + 500 left).
    assert_eq!(other["balance"], 560);
    let h = e.json(&["credits", "history", "--all", "--limit", "5"]);
    assert_eq!(h["entries"].as_array().expect("array").len(), 5);
    assert_eq!(e.json(&["credits", "verify"])["ok"], true);
    assert!(e.json(&["credits", "usage"])["entries"].is_array());
    // A bad agent id is a usage error, not a panic.
    let (code, _) = e.code(&["--agent", "bad:agent", "credits", "balance"]);
    assert_eq!(code, 0, "client names are sanitised into valid agent ids");
}

#[test]
fn tools_scan_search_audit_and_misc() {
    let e = Env::new();
    e.write("src/main.rs", "fn main() { println!(\"hello\"); }\n");
    let plan = e.json(&["scan", "--plan"]);
    assert_eq!(plan["planOnly"], true);
    let rep = e.json(&["scan"]);
    assert!(rep["files_indexed"].as_u64().expect("n") >= 1, "{rep}");
    assert!(e.json(&["code-search", "hello"]).as_array().is_some());
    e.json(&[
        "doc",
        "create",
        "--title",
        "Auth",
        "--content",
        "Users authenticate with passwords.",
    ]);
    let hits = e.json(&["search", "passwords", "--mode", "keyword"]);
    assert_eq!(hits["results"][0]["title"], "Auth");
    assert!(e.json(&["audit", "log"])["total"].as_u64().expect("n") >= 1);
    assert!(e.json(&["tools"]).as_array().expect("array").len() >= 60);
    assert_eq!(e.json(&["tool", "nyx_whoami"])["mode"], "local");
    let (code, _) = e.code(&["tool", "nyx_whoami", "{not json"]);
    assert_eq!(code, 2);
    assert!(e.json(&["pipeline", "list"]).as_array().is_some());
    e.write("leak.txt", "aws = AKIAABCDEFGHIJKLMNOP\n");
    assert_eq!(e.json(&["secrets", "leak.txt"])["clean"], false);
    let p = e.json(&["profile", "set-name", "Ada"]);
    assert_eq!(p["displayName"], "Ada");
    assert_eq!(e.json(&["profile", "show"])["displayName"], "Ada");
}

#[test]
fn secrets_come_from_stdin_and_are_not_echoed() {
    let e = Env::new();
    let key = "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ1234";
    let out = e.run_stdin(&["byok", "set", "anthropic", "--json"], &format!("{key}\n"));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body = text(&out);
    assert!(!body.contains(key) && !String::from_utf8_lossy(&out.stderr).contains(key));
    let v: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["key_suffix"], "1234");
    let st = e.json(&["byok", "status", "anthropic"]);
    assert_eq!(st["configured"], true);
    // With a key present the model-backed tools are attempted (and fail at the network, not config).
    let (code, _) = e.code(&["byok", "status", "nonsense"]);
    assert_ne!(code, 0);
    assert_eq!(e.json(&["byok", "remove", "anthropic"])["removed"], true);
    assert_eq!(
        e.json(&["byok", "status", "anthropic"])["configured"],
        false
    );
    // No key on stdin is rejected rather than stored empty.
    let out = e.run_stdin(&["byok", "set", "openai", "--json"], "\n");
    assert_eq!(out.status.code(), Some(2));
    // Integration config refuses credentials.
    let (code, _) = e.code(&[
        "integration",
        "set",
        "jira",
        r#"{"projectKey":"P","apiToken":"x"}"#,
    ]);
    assert_eq!(code, 2);
    e.json(&["integration", "set", "github", r#"{"repo":"o/r"}"#]);
    assert_eq!(
        e.json(&["integration", "list"])
            .as_array()
            .expect("array")
            .len(),
        1
    );
}

#[test]
fn completions_and_help() {
    let e = Env::new();
    for shell in ["bash", "zsh", "fish"] {
        let out = e.run(&["completions", shell]);
        assert!(out.status.success());
        assert!(text(&out).contains("nyx"), "{shell}");
    }
    let help = e.run(&["--help"]);
    let h = text(&help);
    for sub in [
        "mcp", "doc", "branch", "diff", "merge", "export", "ticket", "scan", "drift", "search",
        "audit", "profile", "credits",
    ] {
        assert!(h.contains(&format!("\n  {sub}")), "help lacks {sub}");
    }
    assert!(text(&e.run(&["--version"])).starts_with("nyx "));
}

#[test]
fn nyx_mcp_subcommand_speaks_the_protocol() {
    let e = Env::new();
    let req = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "cli-test"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "nyx_credits_balance", "arguments": {}}}),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let out = e.run_stdin(&["mcp"], &format!("{req}\n"));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let lines: Vec<Value> = text(&out)
        .lines()
        .map(|l| serde_json::from_str(l).expect("json line"))
        .collect();
    assert_eq!(
        lines.len(),
        3,
        "initialize, tools/list, tools/call (the notification gets no reply)"
    );
    assert_eq!(lines[0]["result"]["serverInfo"]["name"], "nyx");
    assert!(lines[1]["result"]["tools"].as_array().expect("tools").len() >= 60);
    let bal: Value = serde_json::from_str(
        lines[2]["result"]["content"][0]["text"]
            .as_str()
            .expect("text"),
    )
    .expect("json");
    assert_eq!(bal["agentId"], "cli-test");
}
