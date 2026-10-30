//! `nyx-mcp`: stdio MCP server binary. The same server is available as `nyx mcp`.

use nyx_app::{AppOptions, NyxApp};

const HELP: &str = "nyx-mcp: Nyx MCP server over stdio (JSON-RPC 2.0)

USAGE: nyx-mcp [--db PATH] [--data-dir DIR] [--workspace DIR] [--agent ID]

ENV: NYX_DB, NYX_DATA_DIR, NYX_WORKSPACE, NYX_AGENT_ID, NYX_INITIAL_GRANT,
     NYX_AUTO_ALLOCATE, NYX_RATE_LIMIT, NYX_PROVIDER, NYX_SECRETS_PASSPHRASE (encrypted-file
     secret store instead of the OS keychain), NYX_LOG (redacted call log on stderr)";

fn main() {
    let mut opts = AppOptions::from_env();
    opts.live = true;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut value = |name: &str| {
            args.next().unwrap_or_else(|| {
                eprintln!("{name} needs a value");
                std::process::exit(2);
            })
        };
        match a.as_str() {
            "--db" => opts.db_path = Some(value("--db").into()),
            "--data-dir" => opts.data_dir = Some(value("--data-dir").into()),
            "--workspace" => opts.workspace_root = Some(value("--workspace").into()),
            "--agent" => std::env::set_var("NYX_AGENT_ID", value("--agent")),
            "--help" | "-h" => {
                println!("{HELP}");
                return;
            }
            "--version" | "-V" => {
                println!("nyx-mcp {}", nyx_app::VERSION);
                return;
            }
            other => {
                eprintln!("unknown argument {other}\n{HELP}");
                std::process::exit(2);
            }
        }
    }
    let app = match NyxApp::open(opts) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("nyx-mcp: cannot open database: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = nyx_mcp::run_stdio(app) {
        eprintln!("nyx-mcp: {e}");
        std::process::exit(1);
    }
}
