//! Nyx MCP server: JSON-RPC 2.0 over newline-delimited stdio, implemented directly on `std::io`
//! (no async runtime, no MCP SDK dependency). Every `tools/call` goes through
//! [`nyx_app::NyxApp::call_tool`], so rate limiting, validation, path jail, redaction and credit
//! metering apply to MCP exactly as they do to the CLI.
//!
//! Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
//! `resources/templates/list`, `resources/read`, plus the `notifications/*` the client may send.
//! Protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05` (the client's is echoed when known).
#![allow(
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value
)]

pub mod formatter;

use std::io::{BufRead, Write};

use nyx_app::{registry, AppError, Caller, NyxApp};
use serde_json::{json, Value};

/// Protocol versions this server speaks, newest first.
pub const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// One MCP session over one [`NyxApp`].
pub struct McpServer {
    app: NyxApp,
    caller: Caller,
    version: String,
    initialized: bool,
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

impl McpServer {
    /// New session; the caller identity starts as `NYX_AGENT_ID` / `default` and becomes the
    /// client name on `initialize` (unless `NYX_AGENT_ID` is set).
    pub fn new(app: NyxApp) -> Self {
        Self {
            app,
            caller: Caller::local(),
            version: SUPPORTED_VERSIONS[0].to_owned(),
            initialized: false,
        }
    }

    /// The underlying application.
    pub fn app(&self) -> &NyxApp {
        &self.app
    }

    /// Current caller identity.
    pub fn caller(&self) -> &Caller {
        &self.caller
    }

    /// Handle one decoded JSON-RPC message (request, notification or batch). Returns the response
    /// to send, if any.
    pub fn handle_value(&mut self, msg: &Value) -> Option<Value> {
        if let Value::Array(items) = msg {
            if items.is_empty() {
                return Some(rpc_error(&Value::Null, INVALID_REQUEST, "empty batch"));
            }
            let out: Vec<Value> = items.iter().filter_map(|m| self.handle_one(m)).collect();
            return if out.is_empty() {
                None
            } else {
                Some(Value::Array(out))
            };
        }
        self.handle_one(msg)
    }

    fn handle_one(&mut self, msg: &Value) -> Option<Value> {
        let Some(obj) = msg.as_object() else {
            return Some(rpc_error(
                &Value::Null,
                INVALID_REQUEST,
                "request must be an object",
            ));
        };
        let id = obj.get("id").cloned();
        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            // A response from the client to a server request: we send none, ignore.
            return if obj.contains_key("result") || obj.contains_key("error") {
                None
            } else {
                Some(rpc_error(
                    &id.unwrap_or(Value::Null),
                    INVALID_REQUEST,
                    "missing method",
                ))
            };
        };
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            self.notification(method);
            return None;
        };
        Some(match self.request(method, &params) {
            Ok(result) => rpc_ok(&id, result),
            Err((code, message)) => rpc_error(&id, code, &message),
        })
    }

    fn notification(&mut self, method: &str) {
        if method == "notifications/initialized" {
            self.initialized = true;
        }
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => Ok(self.initialize(params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(self.tools_list()),
            "tools/call" => self.tools_call(params),
            "resources/list" => self
                .app
                .list_resources()
                .map(|r| json!({"resources": r}))
                .map_err(|e| (-32603, e.message)),
            "resources/templates/list" => {
                Ok(json!({"resourceTemplates": nyx_app::resources::templates()}))
            }
            "resources/read" => self.resources_read(params),
            other => Err((METHOD_NOT_FOUND, format!("Method not found: {other}"))),
        }
    }

    fn initialize(&mut self, params: &Value) -> Value {
        let wanted = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("");
        self.version = if SUPPORTED_VERSIONS.contains(&wanted) {
            wanted.to_owned()
        } else {
            SUPPORTED_VERSIONS[0].to_owned()
        };
        if std::env::var("NYX_AGENT_ID").is_err() {
            if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                self.caller = Caller::named(name);
            }
        }
        json!({
            "protocolVersion": self.version,
            "capabilities": {"tools": {"listChanged": false}, "resources": {"subscribe": false, "listChanged": false}},
            "serverInfo": {"name": "nyx", "version": nyx_core_version()},
            "instructions": "Nyx is a local, agent-native spec workspace. Call nyx_list_teams for the team id, then nyx_search_docs / nyx_read_doc. Metered tools spend credits from your agent budget; check nyx_credits_balance and use nyx_credits_reserve/commit/release around expensive work.",
        })
    }

    fn tools_list(&self) -> Value {
        let annotations = self.version.as_str() != "2024-11-05";
        let tools: Vec<Value> = registry::registry()
            .iter()
            .map(|t| {
                let mut v =
                    json!({"name": t.name, "description": t.description, "inputSchema": t.schema});
                if annotations {
                    v["annotations"] = json!({"readOnlyHint": !t.mutates, "openWorldHint": false});
                }
                v
            })
            .collect();
        json!({"tools": tools})
    }

    fn tools_call(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).ok_or((
            INVALID_PARAMS,
            "tools/call needs a string `name`".to_owned(),
        ))?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err((INVALID_PARAMS, "`arguments` must be an object".into()));
        }
        Ok(match self.app.call_tool(name, &args, &self.caller) {
            Ok(v) => {
                json!({"content": [{"type": "text", "text": formatter::format_tool_result(name, &v)}]})
            }
            Err(e) => {
                json!({"content": [{"type": "text", "text": error_text(&e)}], "isError": true})
            }
        })
    }

    fn resources_read(&self, params: &Value) -> Result<Value, (i64, String)> {
        let uri = params.get("uri").and_then(Value::as_str).ok_or((
            INVALID_PARAMS,
            "resources/read needs a string `uri`".to_owned(),
        ))?;
        match self.app.read_resource(uri, &self.caller) {
            Ok(c) => {
                Ok(json!({"contents": [{"uri": uri, "text": c.text, "mimeType": c.mime_type}]}))
            }
            Err(e) => Err((
                INVALID_PARAMS,
                format!("Failed to read resource {uri}: {}", e.message),
            )),
        }
    }

    /// Serve until the input closes. Each input line is one JSON-RPC message.
    pub fn serve(&mut self, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(&line) {
                Ok(v) => self.handle_value(&v),
                Err(e) => Some(rpc_error(
                    &Value::Null,
                    PARSE_ERROR,
                    &format!("Parse error: {e}"),
                )),
            };
            if let Some(r) = reply {
                writeln!(output, "{r}")?;
                output.flush()?;
            }
        }
        Ok(())
    }
}

fn nyx_core_version() -> &'static str {
    nyx_app::VERSION
}

fn error_text(e: &AppError) -> String {
    if e.data.is_some() {
        format!("Error: {}: {}\n{}", e.code, e.message, e.to_json())
    } else {
        format!("Error: {}: {}", e.code, e.message)
    }
}

/// Run the server on the process's stdin/stdout. Diagnostics (redacted tool-call log) go to
/// stderr when `NYX_LOG` is set; stdout carries protocol messages only.
pub fn run_stdio(app: NyxApp) -> std::io::Result<()> {
    if std::env::var_os("NYX_LOG").is_some() {
        app.set_logger(|l| eprintln!("[nyx-mcp] {l}"));
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    McpServer::new(app).serve(stdin.lock(), stdout.lock())
}
