//! `nyx`: the Nyx command-line interface. A thin shell over `nyx-app`: every subcommand becomes
//! a tool call, so CLI, MCP server and desktop shell behave identically (guards, credit metering).
#![allow(
    clippy::too_many_lines,
    clippy::needless_pass_by_value,
    clippy::many_single_char_names,
    clippy::doc_markdown
)]

mod cli;
mod commands;

use std::io::Write;
use std::process::ExitCode;

use clap::{CommandFactory, Parser};
use cli::{Cli, Cmd};
use commands::Plan;
use nyx_app::{AppError, AppOptions, AppResult, Caller, NyxApp};
use serde_json::{json, Value};

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn fail(json_mode: bool, e: &AppError) -> ExitCode {
    if json_mode {
        print_json(&e.to_json());
    } else {
        eprintln!("error: {e}");
        if let Some(extra) = &e.data {
            eprintln!("  {extra}");
        }
    }
    ExitCode::from(u8::try_from(e.exit_code()).unwrap_or(1))
}

/// Render a tool result for humans. `export` to stdout prints the file content itself.
fn show(cli: &Cli, tool: &str, v: &Value) -> AppResult<()> {
    if cli.json {
        print_json(v);
        return Ok(());
    }
    if tool == "nyx_export_doc" && v.get("path").is_none() {
        if let Some(c) = v["content"].as_str() {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(c.as_bytes());
            if !c.ends_with('\n') {
                let _ = out.write_all(b"\n");
            }
            return Ok(());
        }
        return Err(AppError::invalid(
            "binary formats need --out PATH (refusing to print binary to the terminal)",
        ));
    }
    if tool == "nyx_export_bundle" && v.get("path").is_none() {
        return Err(AppError::invalid("bundles need --out PATH"));
    }
    println!("{}", nyx_mcp::formatter::format_tool_result(tool, v));
    Ok(())
}

fn settle(
    app: &NyxApp,
    caller: &Caller,
    tool: &str,
    args: &Value,
    resolve: Option<&str>,
) -> AppResult<Value> {
    let first = app.call_tool(tool, args, caller)?;
    let (Some(r), Some(n)) = (resolve, first["conflicts"].as_array().map(Vec::len)) else {
        return Ok(first);
    };
    if first["outcome"] != "conflicted" || n == 0 {
        return Ok(first);
    }
    let mut again = args.clone();
    again["resolutions"] = Value::Array((0..n).map(|_| json!({"choose": r})).collect());
    app.call_tool(tool, &again, caller)
}

fn run() -> ExitCode {
    let cli = Cli::parse();
    if let Cmd::Completions { shell } = &cli.cmd {
        let mut buf = Vec::new();
        clap_complete::generate(*shell, &mut Cli::command(), "nyx", &mut buf);
        // A closed pipe (`| head`) is not an error worth a panic.
        let _ = std::io::stdout().write_all(&buf);
        return ExitCode::SUCCESS;
    }
    let mut opts = AppOptions::from_env();
    opts.live = true;
    if cli.db.is_some() {
        opts.db_path.clone_from(&cli.db);
    }
    if cli.data_dir.is_some() {
        opts.data_dir.clone_from(&cli.data_dir);
    }
    if cli.workspace.is_some() {
        opts.workspace_root.clone_from(&cli.workspace);
    }
    let app = match NyxApp::open(opts) {
        Ok(a) => a,
        Err(e) => return fail(cli.json, &e),
    };
    let caller = match &cli.agent {
        Some(a) => Caller::named(a),
        None => Caller::local(),
    };

    if matches!(cli.cmd, Cmd::Mcp) {
        if let Some(a) = &cli.agent {
            std::env::set_var("NYX_AGENT_ID", a);
        }
        return match nyx_mcp::run_stdio(app) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        };
    }

    let plan = match commands::plan(&cli, &app, &caller) {
        Ok(p) => p,
        Err(e) => return fail(cli.json, &e),
    };
    let (tool, result, conflicted) = match plan {
        Plan::Tool(name, args) => {
            let r = app.call_tool(&name, &args, &caller);
            (name, r, false)
        }
        Plan::Merge { args, resolve } => {
            let r = settle(&app, &caller, "nyx_merge_branch", &args, resolve);
            ("nyx_merge_branch".to_owned(), r, true)
        }
        Plan::Sync { args, resolve } => {
            let r = settle(&app, &caller, "nyx_sync_branch", &args, resolve);
            ("nyx_sync_branch".to_owned(), r, true)
        }
        Plan::Local(v) => ("local".to_owned(), Ok(v), false),
    };
    let value = match result {
        Ok(v) => v,
        Err(e) => return fail(cli.json, &e),
    };
    if let Err(e) = show(&cli, &tool, &value) {
        return fail(cli.json, &e);
    }
    if let Cmd::Notifications {
        mark_read: true, ..
    } = &cli.cmd
    {
        if let Err(e) = app.call_tool(
            "nyx_notifications_mark_read",
            &json!({"all": true}),
            &caller,
        ) {
            return fail(cli.json, &e);
        }
    }
    if conflicted && value["outcome"] == "conflicted" {
        if !cli.json {
            eprintln!("conflicts remain: resolve with --resolve ours|theirs|base|both or --resolutions FILE");
        }
        return ExitCode::from(4);
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    run()
}
