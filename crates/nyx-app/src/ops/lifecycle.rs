//! Lifecycle pipelines, stages and templates. Source: `nyx_core::lifecycle`.
//! All tools are new relative to the TS MCP server.

use nyx_core::lifecycle::{
    instantiate, plan_transition, template::completeness, Registry, TransitionPolicy, Vars,
};
use nyx_core::model::NewDocument;
use nyx_core::store::{DocumentRepo, LifecycleRepo, SqliteDocuments, SqliteLifecycles};
use nyx_core::tree::path as tpath;
use serde_json::{json, Value};

use super::{id, name, to_json};
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{strict, ToolSpec};
use crate::Cx;

fn list_pipelines(_cx: &mut Cx<'_>, _a: &Args<'_>) -> AppResult<Value> {
    let reg = Registry::builtin();
    Ok(Value::Array(
        reg.list()
            .iter()
            .map(|p| {
                json!({
                    "slug": p.slug, "label": p.label, "description": p.description,
                    "isDefault": p.is_default,
                    "stages": p.stages.iter().map(|s| json!({"slug": s.slug, "label": s.label})).collect::<Vec<_>>(),
                })
            })
            .collect(),
    ))
}

fn get_pipeline(_cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let slug = a.str("slug")?;
    let p = Registry::builtin()
        .get(slug)
        .ok_or_else(|| AppError::not_found(format!("pipeline {slug}")))?;
    to_json(p)
}

fn set_stage(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let doc = SqliteDocuments::new(cx.conn()).get(d)?;
    let pipeline_slug = a.opt_str("pipeline");
    let lifecycles = SqliteLifecycles::new(cx.conn());
    let reg = Registry::builtin();
    let lifecycle_slug = match (&doc.lifecycle_id, pipeline_slug) {
        (_, Some(p)) => Some(p.to_owned()),
        (Some(lid), None) => lifecycles.get(lid).ok().map(|l| l.slug),
        (None, None) => None,
    };
    let pipeline = reg
        .resolve(lifecycle_slug.as_deref())
        .ok_or_else(|| AppError::not_found("pipeline"))?;
    let to = a.opt_str("stage");
    let policy = if a.opt_str("policy") == Some("sequential") {
        TransitionPolicy::Sequential
    } else {
        TransitionPolicy::Free
    };
    let t = plan_transition(pipeline, doc.stage.as_deref(), to, policy)?;
    let lc = lifecycles.find_by_slug(&pipeline.slug)?.map(|l| l.id);
    let updated = cx
        .db
        .transaction(|c| SqliteDocuments::new(c).set_stage(d, to, lc.as_deref()))?;
    Ok(
        json!({"documentId": updated.id, "stage": updated.stage, "pipeline": pipeline.slug, "transition": t}),
    )
}

fn list_templates(_cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let reg = Registry::builtin();
    let stage = a.opt_str("stage");
    let pipeline = a.opt_str("pipeline");
    let mut out = Vec::new();
    for (p, t) in reg.all_templates() {
        if pipeline.is_some_and(|s| s != p.slug) || stage.is_some_and(|s| s != t.stage) {
            continue;
        }
        out.push(json!({"pipeline": p.slug, "stage": t.stage, "name": t.name, "description": t.description}));
    }
    Ok(Value::Array(out))
}

fn create_from_template(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let (pslug, stage, tname) = (a.str("pipeline")?, a.str("stage")?, a.str("template")?);
    let reg = Registry::builtin();
    let p = reg
        .get(pslug)
        .ok_or_else(|| AppError::not_found(format!("pipeline {pslug}")))?;
    let t = p
        .template(stage, tname)
        .ok_or_else(|| AppError::not_found(format!("template {tname} in stage {stage}")))?;
    let mut vars = Vars::new();
    if let Some(Value::Object(m)) = a.raw("variables") {
        for (k, v) in m {
            if let Some(s) = v.as_str() {
                vars.set(k, s);
            }
        }
    }
    let rendered = instantiate(t, &vars)?;
    let team = cx.team(a);
    let title = name("title", a.opt_str("title").unwrap_or(&t.name), 300)?;
    let path = tpath::normalize_lenient(a.opt_str("path").unwrap_or("/"));
    let user = cx.user_id().to_owned();
    let lc = SqliteLifecycles::new(cx.conn())
        .find_by_slug(&p.slug)?
        .map(|l| l.id);
    let doc = cx.db.transaction(|c| {
        SqliteDocuments::new(c).create(&NewDocument {
            title,
            content: rendered.content.clone(),
            path,
            team_id: team,
            created_by_id: user,
            stage: Some(stage.to_owned()),
            lifecycle_id: lc,
        })
    })?;
    Ok(
        json!({"id": doc.id, "title": doc.title, "path": doc.path, "stage": doc.stage, "unresolved": rendered.unresolved}),
    )
}

fn template_completeness(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let doc = SqliteDocuments::new(cx.conn()).get(d)?;
    let (pslug, stage, tname) = (a.str("pipeline")?, a.str("stage")?, a.str("template")?);
    let p = Registry::builtin()
        .get(pslug)
        .ok_or_else(|| AppError::not_found(format!("pipeline {pslug}")))?;
    let t = p
        .template(stage, tname)
        .ok_or_else(|| AppError::not_found(format!("template {tname}")))?;
    to_json(&completeness(&t.content, &doc.content))
}

/// Register lifecycle tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let team =
        json!({"type": "string", "description": "Team UUID (defaults to the local workspace)"});
    v.push(ToolSpec::new(
        "nyx_list_pipelines",
        "lifecycle",
        "List the built-in domain pipelines (lifecycle stage sets) with their stages.",
        strict(json!({}), &[]),
        list_pipelines,
    ));
    v.push(ToolSpec::new(
        "nyx_get_pipeline",
        "lifecycle",
        "Full definition of one pipeline: stages, connectors and templates.",
        strict(json!({"slug": {"type": "string"}}), &["slug"]),
        get_pipeline,
    ));
    v.push(
        ToolSpec::new(
            "nyx_set_stage",
            "lifecycle",
            "Move a document to a lifecycle stage (omit stage to clear). policy=sequential forbids skipping ahead.",
            strict(
                json!({
                    "document_id": {"type": "string"},
                    "stage": {"type": "string"},
                    "pipeline": {"type": "string", "description": "Pipeline slug (default: the document's, else software_development)"},
                    "policy": {"type": "string", "enum": ["free", "sequential"]},
                }),
                &["document_id"],
            ),
            set_stage,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_list_templates",
        "lifecycle",
        "List document templates, optionally for one pipeline or stage.",
        strict(
            json!({"pipeline": {"type": "string"}, "stage": {"type": "string"}}),
            &[],
        ),
        list_templates,
    ));
    v.push(
        ToolSpec::new(
            "nyx_create_from_template",
            "lifecycle",
            "Create a document from a pipeline template, filling {{variables}}; the document starts at that stage.",
            strict(
                json!({
                    "team_id": team,
                    "pipeline": {"type": "string"}, "stage": {"type": "string"}, "template": {"type": "string"},
                    "title": {"type": "string"}, "path": {"type": "string"},
                    "variables": {"type": "object"},
                }),
                &["pipeline", "stage", "template"],
            ),
            create_from_template,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_template_completeness",
        "lifecycle",
        "How completely a document follows a template's sections (missing and unfilled sections).",
        strict(
            json!({"document_id": {"type": "string"}, "pipeline": {"type": "string"}, "stage": {"type": "string"}, "template": {"type": "string"}}),
            &["document_id", "pipeline", "stage", "template"],
        ),
        template_completeness,
    ));
}
