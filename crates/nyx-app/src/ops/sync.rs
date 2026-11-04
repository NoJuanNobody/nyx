//! AI-assisted checks (quality, drift), semantic/keyword search, impact graph and drift records.
//! Source: `nyx_core::{ai, sync}`. TS parity: `nyx_check_quality`, `nyx_detect_drift` (both need a
//! model provider, so they answer `not_configured` offline; no output is fabricated).

use nyx_core::ai::Advisor;
use nyx_core::intake::ChunkOptions;
use nyx_core::store::{ChunkRepo, DocumentRepo, SqliteChunks, SqliteDocuments};
use nyx_core::sync::drift::{ChangeSet, DriftConfig, DriftEngine, DriftStatus, SqliteDrift};
use nyx_core::sync::impact::{Edge, NodeKind, NodeRef, SqliteImpact};
use nyx_core::sync::{index_document, search_documents, DirCodeSource, Mode, RetrieveOptions};
use serde_json::{json, Value};

use super::{id, text, to_json, MAX_CONTENT_BYTES};
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, strict, Cost, Needs, Parity, ToolSpec};
use crate::Cx;

fn advisor_llm(
    cx: &Cx<'_>,
) -> AppResult<(
    std::sync::Arc<dyn nyx_core::ai::LlmProvider>,
    nyx_core::ai::ModelPair,
)> {
    let llm = cx
        .services()
        .llm
        .clone()
        .ok_or_else(|| AppError::not_configured("no model provider configured"))?;
    Ok((llm, cx.services().models.clone()))
}

fn check_quality(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let content = a.str("content")?;
    text("content", content, MAX_CONTENT_BYTES)?;
    let (llm, models) = advisor_llm(cx)?;
    let q = Advisor::new(llm.as_ref(), &models).analyze_spec_quality(content, None)?;
    to_json(&q)
}

fn detect_drift(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let (spec, code) = (a.str("spec_content")?, a.str("code_content")?);
    text("spec_content", spec, MAX_CONTENT_BYTES)?;
    text("code_content", code, MAX_CONTENT_BYTES)?;
    let (llm, models) = advisor_llm(cx)?;
    let r = Advisor::new(llm.as_ref(), &models).detect_drift(spec, code)?;
    to_json(&r)
}

fn index_docs(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let force = a.opt_bool("force").unwrap_or(false);
    let n = index_team(cx, &team, force)?;
    Ok(json!({"indexedDocuments": n.0, "skipped": n.1, "embedder": cx.services().embedder.model()}))
}

fn index_team(cx: &mut Cx<'_>, team: &str, force: bool) -> AppResult<(usize, usize)> {
    let embedder = cx.services().embedder.clone();
    let docs = SqliteDocuments::new(cx.conn()).list_live(team)?;
    let (mut done, mut skipped) = (0, 0);
    for d in docs {
        let v = SqliteDocuments::new(cx.conn())
            .latest_version(&d.id)?
            .version;
        if !force
            && !SqliteChunks::new(cx.conn())
                .doc_chunks(&d.id, v)?
                .is_empty()
        {
            skipped += 1;
            continue;
        }
        cx.db.transaction(|c| {
            index_document(c, embedder.as_ref(), &d, v, &ChunkOptions::default())
        })?;
        done += 1;
    }
    Ok((done, skipped))
}

fn search(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let q = a.str("query")?;
    text("query", q, 2000)?;
    let mode = match a.opt_str("mode").unwrap_or("hybrid") {
        "semantic" => Mode::Semantic,
        "keyword" => Mode::Keyword,
        _ => Mode::Hybrid,
    };
    let opts = RetrieveOptions {
        top_k: a.opt_i64("top_k").unwrap_or(5).clamp(1, 50) as usize,
        threshold: a.raw("threshold").and_then(Value::as_f64).unwrap_or(0.0) as f32,
        mode,
        semantic_weight: 0.7,
    };
    // Make sure every live document has chunks for its current version (cheap when up to date).
    index_team(cx, &team, false)?;
    let vec = if mode == Mode::Keyword {
        None
    } else {
        cx.services()
            .embedder
            .embed(&[q.to_owned()])
            .map_err(|e| AppError::new("embed_error", e.to_string()))?
            .into_iter()
            .next()
    };
    let hits = search_documents(cx.conn(), &team, q, vec.as_deref(), &opts)?;
    let repo = SqliteDocuments::new(cx.conn());
    let mut out = Vec::new();
    for h in hits {
        let title = repo.get(&h.doc_id).map(|d| d.title).unwrap_or_default();
        out.push(json!({"documentId": h.doc_id, "title": title, "score": h.score, "chunkIndex": h.chunk_index, "content": h.content}));
    }
    Ok(json!({"query": q, "mode": format!("{mode:?}").to_lowercase(), "results": out}))
}

fn parse_node(kind: &str, r: &str) -> AppResult<NodeRef> {
    Ok(NodeRef {
        kind: NodeKind::parse(kind)?,
        id: r.to_owned(),
    })
}

fn link_impact(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let edge = Edge {
        src: parse_node(a.str("src_kind")?, a.str("src")?)?,
        dst: parse_node(a.str("dst_kind")?, a.str("dst")?)?,
        relation: a.opt_str("relation").unwrap_or("references").to_owned(),
        weight: a.raw("weight").and_then(Value::as_f64).unwrap_or(1.0) as f32,
    };
    let created = cx
        .db
        .transaction(|c| SqliteImpact::new(c).link(&team, &edge))?;
    Ok(json!({"created": created}))
}

fn unlink_impact(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let src = parse_node(a.str("src_kind")?, a.str("src")?)?;
    let dst = parse_node(a.str("dst_kind")?, a.str("dst")?)?;
    let rel = a.opt_str("relation").unwrap_or("references");
    let removed = cx
        .db
        .transaction(|c| SqliteImpact::new(c).unlink(&team, &src, &dst, rel))?;
    Ok(json!({"removed": removed}))
}

fn impact(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let start = parse_node(a.str("kind")?, a.str("ref")?)?;
    let depth = a.opt_i64("max_depth").unwrap_or(3).clamp(1, 10) as usize;
    let min = a.raw("min_strength").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    let g = SqliteImpact::new(cx.conn()).load(&team)?;
    to_json(&g.affected_by(&[start], depth, min))
}

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn drift_check(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let files = a.str_list("changed_files");
    if files.is_empty() {
        return Err(AppError::invalid("changed_files needs at least one path"));
    }
    let jail = cx
        .app
        .jail
        .as_ref()
        .ok_or_else(|| AppError::not_configured("no workspace root available"))?;
    let mut changes = Vec::new();
    for f in &files {
        // Hash current content so the same unchanged files are not judged twice (idempotent run key).
        let bytes = jail.read(f).unwrap_or_default();
        jail.resolve(f)?;
        changes.push((f.clone(), fnv(&bytes)));
    }
    let (llm, models) = advisor_llm(cx)?;
    let src = DirCodeSource::new(jail.root())?;
    let engine = DriftEngine::new(llm.as_ref(), &models, &src, DriftConfig::default());
    let cs = ChangeSet::from_watch("cli", &changes);
    let report = engine.run(cx.conn(), &team, &cs)?;
    to_json(&report)
}

fn list_drift(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let recs = if let Some(d) = a.opt_str("document_id") {
        id("document_id", d)?;
        SqliteDrift::new(cx.conn()).list_for_document(d)?
    } else {
        SqliteDrift::new(cx.conn()).list_open(&cx.team(a))?
    };
    to_json(&recs)
}

fn set_drift_status(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let rid = a.str("drift_id")?;
    id("drift_id", rid)?;
    let st = match a.str("status")? {
        "open" => DriftStatus::Open,
        "resolved" => DriftStatus::Resolved,
        "dismissed" => DriftStatus::Dismissed,
        o => return Err(AppError::invalid(format!("unknown status {o}"))),
    };
    to_json(&SqliteDrift::new(cx.conn()).set_status(rid, st)?)
}

/// Register sync and AI tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let team =
        json!({"type": "string", "description": "Team UUID (defaults to the local workspace)"});
    let kinds = json!({"type": "string", "enum": ["spec", "file", "ticket"]});
    v.push(
        ToolSpec::new(
            "nyx_check_quality",
            "ai",
            "Run AI quality analysis on spec content. Returns a quality score (1-10) and improvement suggestions.",
            obj(json!({"content": {"type": "string", "description": "The spec content to analyze"}}), &["content"]),
            check_quality,
        )
        .parity(Parity::Exact)
        .needs(Needs::Llm)
        .cost(Cost::Fixed(3)),
    );
    v.push(
        ToolSpec::new(
            "nyx_detect_drift",
            "ai",
            "Detect drift between a specification and code. Returns drift score and details.",
            obj(
                json!({
                    "spec_content": {"type": "string", "description": "The specification document content"},
                    "code_content": {"type": "string", "description": "The code to compare against"},
                }),
                &["spec_content", "code_content"],
            ),
            detect_drift,
        )
        .parity(Parity::Exact)
        .needs(Needs::Llm)
        .cost(Cost::Fixed(2)),
    );
    v.push(
        ToolSpec::new(
            "nyx_drift_check",
            "sync",
            "Judge which specs the given changed workspace files may have drifted from (path matching + one model call per matched spec); results are stored and idempotent per file content.",
            strict(json!({"team_id": team, "changed_files": {"type": "array", "items": {"type": "string"}, "minItems": 1}}), &["changed_files"]),
            drift_check,
        )
        .needs(Needs::Llm)
        .cost(Cost::Fixed(2))
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_list_drift",
        "sync",
        "Stored drift findings: open ones for the team, or all for one document.",
        strict(
            json!({"team_id": team, "document_id": {"type": "string"}}),
            &[],
        ),
        list_drift,
    ));
    v.push(
        ToolSpec::new(
            "nyx_set_drift_status",
            "sync",
            "Mark a drift finding open, resolved or dismissed.",
            strict(
                json!({"drift_id": {"type": "string"}, "status": {"type": "string", "enum": ["open", "resolved", "dismissed"]}}),
                &["drift_id", "status"],
            ),
            set_drift_status,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_index_docs",
            "search",
            "Chunk and embed live documents for search (local lexical embedder offline). Up-to-date documents are skipped unless force=true.",
            strict(json!({"team_id": team, "force": {"type": "boolean"}}), &[]),
            index_docs,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_search",
        "search",
        "Search document content: semantic, keyword or hybrid ranking over indexed chunks (indexes missing documents first).",
        strict(
            json!({
                "query": {"type": "string"}, "team_id": team,
                "mode": {"type": "string", "enum": ["semantic", "keyword", "hybrid"]},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 50},
                "threshold": {"type": "number", "minimum": 0, "maximum": 1},
            }),
            &["query"],
        ),
        search,
    ));
    v.push(
        ToolSpec::new(
            "nyx_impact_link",
            "impact",
            "Add a weighted edge to the impact graph between specs, files and tickets.",
            strict(
                json!({
                    "team_id": team, "src_kind": kinds, "src": {"type": "string"}, "dst_kind": kinds, "dst": {"type": "string"},
                    "relation": {"type": "string"}, "weight": {"type": "number", "minimum": 0, "maximum": 1},
                }),
                &["src_kind", "src", "dst_kind", "dst"],
            ),
            link_impact,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_impact_unlink",
            "impact",
            "Remove an impact graph edge.",
            strict(
                json!({"team_id": team, "src_kind": kinds, "src": {"type": "string"}, "dst_kind": kinds, "dst": {"type": "string"}, "relation": {"type": "string"}}),
                &["src_kind", "src", "dst_kind", "dst"],
            ),
            unlink_impact,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_impact",
        "impact",
        "What does a change to this spec, file or ticket affect? Traverses the impact graph.",
        strict(
            json!({
                "team_id": team, "kind": kinds, "ref": {"type": "string"},
                "max_depth": {"type": "integer", "minimum": 1, "maximum": 10},
                "min_strength": {"type": "number", "minimum": 0, "maximum": 1},
            }),
            &["kind", "ref"],
        ),
        impact,
    ));
}
