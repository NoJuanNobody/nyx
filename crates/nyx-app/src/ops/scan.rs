//! Repository scan and code search. Source: `nyx_core::scan`, `nyx_core::sync::retrieve_code`.
//! New relative to the TS MCP server (the TS CLI had `nyx scan` over HTTP).
//!
//! Scans are metered per newly embedded chunk through the credit ledger (`scan::LedgerMeter`:
//! reserve then commit per batch, so an exhausted budget stops the scan with everything already
//! indexed kept). Only workspace folders are scanned here; scanning a git host repo needs the live
//! transports and is a documented gap.

use std::collections::BTreeMap;
use std::sync::Arc;

use nyx_core::scan::{
    index_repo, plan_scan, CountingMeter, EmbedError, FileFilter, IndexError, IndexOptions,
    LocalFolderSource, NoMeter, RepoSource, ScanHooks, ScanMeter,
};
use nyx_core::sync::{retrieve_code, Embedder as SyncEmbedder, Mode, RetrieveOptions};
use serde_json::{json, Value};

use super::to_json;
use crate::args::Args;
use crate::credits;
use crate::error::{AppError, AppResult};
use crate::registry::{strict, Cost, ToolSpec};
use crate::Cx;

/// Adapter from the sync embedder trait to the scan one (the two traits are unified later).
struct ScanEmbedder(Arc<dyn SyncEmbedder>);

impl nyx_core::scan::Embedder for ScanEmbedder {
    fn model(&self) -> &str {
        self.0.model()
    }
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.0.embed(texts).map_err(|e| EmbedError::Permanent(e.to_string()))
    }
}

fn scan_err(e: IndexError) -> AppError {
    match e {
        IndexError::Meter(nyx_core::scan::MeterError::Insufficient(m)) => {
            AppError::new("insufficient_credits", format!("scan stopped: {m}"))
        }
        IndexError::Core(e) => e.into(),
        other => AppError::new("scan_error", other.to_string()),
    }
}

fn scan(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let jail = cx
        .app
        .jail
        .as_ref()
        .ok_or_else(|| AppError::not_configured("no workspace root available"))?;
    let root = jail.resolve(a.opt_str("path").unwrap_or("."))?;
    let source = LocalFolderSource::new(&root)?;
    let repo = a.opt_str("repo_name").map_or_else(
        || {
            let leaf = root.file_name().map_or_else(|| "workspace".to_owned(), |n| n.to_string_lossy().into_owned());
            format!("local/{leaf}")
        },
        str::to_owned,
    );
    super::name("repo_name", &repo, 200)?;
    let max_files = a.opt_i64("max_files").map_or(2000, |n| n.clamp(1, 20_000) as usize);

    if a.opt_bool("plan_only").unwrap_or(false) {
        let entries = source.list()?;
        let plan = plan_scan(&entries, &BTreeMap::new(), &FileFilter::for_index(), max_files);
        return Ok(json!({
            "planOnly": true, "repo": repo,
            "files": entries.len(), "wouldIndex": plan.added.len(),
            "skipped": plan.skipped.len(), "overLimit": plan.over_limit.len(),
        }));
    }

    let mut opts = IndexOptions::new(&team, &repo);
    opts.max_files = max_files;
    opts.force = a.opt_bool("force").unwrap_or(false);
    let embedder = ScanEmbedder(cx.services().embedder.clone());
    let spec = crate::registry::find("nyx_scan").ok_or_else(|| AppError::new("internal", "nyx_scan missing"))?;
    let per_chunk = cx.app.price_of(spec);
    let agent = cx.caller.agent_id.clone();
    let conn = cx.db.conn();
    // The scan meter must be Send + Sync, which a borrowed SQLite connection is not, so the scan
    // runs against an in-memory chunk budget derived from the agent balance and the actual usage is
    // settled on the ledger right after (one idempotent spend, also when the scan stops early).
    let counting = if per_chunk > 0 {
        credits::ensure_agent(conn, &agent, cx.app.auto_allocate_amount())?;
        let bal = credits::balance(conn, &agent)?["balance"].as_i64().unwrap_or(0);
        Some(CountingMeter::with_budget(usize::try_from(bal / per_chunk).unwrap_or(0)))
    } else {
        None
    };
    let meter: &dyn ScanMeter = counting.as_ref().map_or(&NoMeter as &dyn ScanMeter, |m| m as &dyn ScanMeter);
    let result = index_repo(conn, &source, &embedder, meter, &opts, &mut ScanHooks::none());
    let chunks_charged = counting.as_ref().map_or(0, CountingMeter::total);
    let credits_spent = i64::try_from(chunks_charged).unwrap_or(i64::MAX).saturating_mul(per_chunk);
    if credits_spent > 0 {
        let scan_id = uuid::Uuid::new_v4();
        credits::spend(conn, &agent, &format!("scan:{scan_id}"), credits_spent, Some("repo_scan"), Some("repo scan: embeddings"))?;
    }
    let report = result.map_err(scan_err)?;
    let mut out = to_json(&report)?;
    out["repo"] = json!(repo);
    out["creditsPerChunk"] = json!(per_chunk);
    out["creditsSpent"] = json!(credits_spent);
    Ok(out)
}

fn search_code(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let q = a.str("query")?;
    super::text("query", q, 2000)?;
    let opts = RetrieveOptions {
        top_k: a.opt_i64("top_k").unwrap_or(5).clamp(1, 50) as usize,
        threshold: 0.0,
        mode: Mode::Semantic,
        semantic_weight: 1.0,
    };
    let hits = retrieve_code(cx.conn(), cx.services().embedder.as_ref(), q, &team, &opts)?;
    to_json(&hits)
}

/// Register scan tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let team = json!({"type": "string", "description": "Team UUID (defaults to the local workspace)"});
    v.push(
        ToolSpec::new(
            "nyx_scan",
            "scan",
            "Index a workspace folder into code chunks for retrieval and drift matching. Incremental; metered per newly embedded chunk (an exhausted budget stops the scan and keeps what was indexed). plan_only=true counts without indexing.",
            strict(
                json!({
                    "team_id": team,
                    "path": {"type": "string", "description": "Folder inside the workspace (default: the workspace root)"},
                    "repo_name": {"type": "string"},
                    "max_files": {"type": "integer", "minimum": 1},
                    "force": {"type": "boolean"},
                    "plan_only": {"type": "boolean"},
                }),
                &[],
            ),
            scan,
        )
        .cost(Cost::PerUnit)
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_search_code",
        "scan",
        "Search indexed code chunks by similarity.",
        strict(json!({"team_id": team, "query": {"type": "string"}, "top_k": {"type": "integer", "minimum": 1, "maximum": 50}}), &["query"]),
        search_code,
    ));
}
