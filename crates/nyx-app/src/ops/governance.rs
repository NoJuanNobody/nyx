//! Audit trail, notifications, approvals, secret scan and integration configuration.
//! Source: `nyx_core::{governance, notify, store::integrations}`. All new relative to the TS MCP
//! server.
//!
//! Integration *secrets* (tokens, API keys) are never accepted through tools: they are set by the
//! owner with `nyx byok set` / `nyx integration secret` into the OS keychain. Tools only handle
//! non-secret configuration and redact anything that looks like a credential.

use std::str::FromStr;

use nyx_core::governance::{
    detect_secrets, ApprovalService, ApprovalStatus, AuditFilter, AuditService, ExportFormat,
    NewApproval,
};
use nyx_core::model::{AuditEventType, IntegrationType, NewIntegration};
use nyx_core::notify::{EventBus, InboxQuery, NotificationService};
use nyx_core::security::redact::redact_json;
use nyx_core::store::{IntegrationRepo, SqliteIntegrations};
use nyx_core::sync::trace::document_trace;
use serde_json::{json, Value};

use super::{id, text, to_json};
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{strict, ToolSpec};
use crate::Cx;

fn filter(cx: &Cx<'_>, a: &Args<'_>) -> AppResult<AuditFilter> {
    let mut f = AuditFilter {
        team_id: Some(cx.team(a)),
        limit: Some(a.opt_i64("limit").unwrap_or(50).clamp(1, 1000) as u32),
        offset: a.opt_i64("offset").unwrap_or(0).max(0) as u32,
        since: a.opt_i64("since"),
        until: a.opt_i64("until"),
        text: a.opt_str("text").map(str::to_owned),
        document_id: a.opt_str("document_id").map(str::to_owned),
        ..AuditFilter::default()
    };
    if let Some(d) = &f.document_id {
        id("document_id", d)?;
    }
    for t in a.str_list("event_types") {
        f.event_types
            .push(AuditEventType::from_str(&t).map_err(|e| AppError::invalid(e.to_string()))?);
    }
    Ok(f)
}

fn audit_log(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let f = filter(cx, a)?;
    let svc = AuditService::new(cx.conn());
    Ok(json!({"entries": svc.query(&f)?, "total": svc.count(&f)?}))
}

fn audit_export(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let f = filter(cx, a)?;
    let fmt = match a.opt_str("format").unwrap_or("json") {
        "jsonl" => ExportFormat::Jsonl,
        "csv" => ExportFormat::Csv,
        _ => ExportFormat::Json,
    };
    let s = AuditService::new(cx.conn()).export(&f, fmt)?;
    Ok(json!({"format": a.opt_str("format").unwrap_or("json"), "content": s}))
}

fn audit_trace(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let t = document_trace(cx.conn(), d)?;
    Ok(json!({"summary": t.summary(), "trace": t}))
}

fn notifications(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let svc = NotificationService::new(cx.conn(), EventBus::new());
    let page = svc.inbox(&InboxQuery {
        user_id: cx.user_id().to_owned(),
        read: if a.opt_bool("unread_only").unwrap_or(false) {
            Some(false)
        } else {
            None
        },
        event: a.opt_str("event").map(nyx_core::notify::EventFilter::parse),
        limit: Some(a.opt_i64("limit").unwrap_or(20).clamp(1, 100) as u32),
        cursor: a.opt_str("cursor").map(str::to_owned),
    })?;
    to_json(&page)
}

fn mark_read(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let svc = NotificationService::new(cx.conn(), EventBus::new());
    let user = cx.user_id().to_owned();
    if a.opt_bool("all").unwrap_or(false) {
        return Ok(json!({"marked": svc.mark_all_read(&user)?}));
    }
    let n = a.str("id")?;
    id("id", n)?;
    to_json(&svc.mark_read(&user, n)?)
}

fn approval_request(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let (action, rid) = (a.str("action")?, a.str("resource_id")?);
    id("resource_id", rid)?;
    text("action", action, 100)?;
    let team = cx.team(a);
    let user = cx.user_id().to_owned();
    let ap = ApprovalService::new(cx.conn()).create(&NewApproval {
        action: action.to_owned(),
        resource_id: rid.to_owned(),
        requested_by_id: user,
        team_id: team,
        metadata: a.raw("metadata").cloned().unwrap_or_else(|| json!({})),
        expires_in_ms: a.opt_i64("expires_in_ms"),
    })?;
    to_json(&ap)
}

fn approval_review(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let aid = a.str("approval_id")?;
    id("approval_id", aid)?;
    let user = cx.user_id().to_owned();
    let svc = ApprovalService::new(cx.conn());
    let out = match a.str("decision")? {
        "approve" => svc.approve(aid, &user, a.opt_str("reason"))?,
        "reject" => svc.reject(aid, &user, a.opt_str("reason"))?,
        o => return Err(AppError::invalid(format!("unknown decision {o}"))),
    };
    to_json(&out)
}

fn approvals_list(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let status = a
        .opt_str("status")
        .map(|s| ApprovalStatus::from_str(s).map_err(|e| AppError::invalid(e.to_string())))
        .transpose()?;
    to_json(&ApprovalService::new(cx.conn()).list_by_team(&cx.team(a), status)?)
}

fn scan_secrets(_cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let c = a.str("content")?;
    text("content", c, super::MAX_CONTENT_BYTES)?;
    let v = detect_secrets(c);
    Ok(json!({"clean": v.is_empty(), "violations": v}))
}

fn integrations_list(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let list = SqliteIntegrations::new(cx.conn()).list(&cx.team(a))?;
    Ok(Value::Array(
        list.iter()
            .map(|i| json!({"id": i.id, "type": i.r#type, "config": redact_json(&i.config), "updatedAt": i.updated_at}))
            .collect(),
    ))
}

fn looks_secret(v: &Value) -> Option<String> {
    match v {
        Value::Object(o) => o.iter().find_map(|(k, val)| {
            let kl = k.to_ascii_lowercase();
            if [
                "token",
                "secret",
                "password",
                "apikey",
                "api_key",
                "privatekey",
                "credential",
            ]
            .iter()
            .any(|w| kl.contains(w))
                && !val.is_null()
            {
                Some(k.clone())
            } else {
                looks_secret(val)
            }
        }),
        Value::Array(a) => a.iter().find_map(looks_secret),
        _ => None,
    }
}

fn integration_set(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let ty =
        IntegrationType::from_str(a.str("type")?).map_err(|e| AppError::invalid(e.to_string()))?;
    let cfg = a.raw("config").cloned().unwrap_or_else(|| json!({}));
    if let Some(k) = looks_secret(&cfg) {
        return Err(AppError::invalid(format!(
            "config key `{k}` looks like a credential; store secrets with `nyx integration secret` (OS keychain), not in config"
        )));
    }
    let existing = SqliteIntegrations::new(cx.conn())
        .list(&team)?
        .into_iter()
        .find(|i| i.r#type == ty);
    let saved = cx.db.transaction(|c| {
        let repo = SqliteIntegrations::new(c);
        match &existing {
            Some(e) => repo.update_config(&e.id, &cfg),
            None => repo.create(&NewIntegration {
                team_id: team.clone(),
                r#type: ty,
                config: cfg.clone(),
            }),
        }
    })?;
    Ok(json!({"id": saved.id, "type": saved.r#type, "config": redact_json(&saved.config)}))
}

fn integration_remove(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let i = a.str("id")?;
    id("id", i)?;
    Ok(json!({"removed": SqliteIntegrations::new(cx.conn()).delete(i)?}))
}

/// Register governance tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let team =
        json!({"type": "string", "description": "Team UUID (defaults to the local workspace)"});
    let audit_props = json!({
        "team_id": team, "document_id": {"type": "string"},
        "event_types": {"type": "array", "items": {"type": "string", "enum": ["doc_edit", "snapshot_created", "ticket_created", "ticket_updated", "code_commit", "proposal_created", "proposal_approved", "proposal_pushed"]}},
        "since": {"type": "integer", "description": "Unix ms, inclusive"}, "until": {"type": "integer", "description": "Unix ms, inclusive"},
        "text": {"type": "string", "description": "Substring of the event metadata"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 1000}, "offset": {"type": "integer", "minimum": 0},
    });
    v.push(ToolSpec::new(
        "nyx_audit_log",
        "audit",
        "Query the append-only audit trail (filter by document, event type, time range, text).",
        strict(audit_props.clone(), &[]),
        audit_log,
    ));
    let mut export_props = audit_props;
    export_props["format"] = json!({"type": "string", "enum": ["json", "jsonl", "csv"]});
    v.push(ToolSpec::new(
        "nyx_audit_export",
        "audit",
        "Export the filtered audit trail as JSON, JSONL or CSV (spreadsheet-injection safe).",
        strict(export_props, &[]),
        audit_export,
    ));
    v.push(ToolSpec::new(
        "nyx_audit_trace",
        "audit",
        "Traceability graph and one-paragraph lineage summary for a document (spec to commits to tickets).",
        strict(json!({"document_id": {"type": "string"}}), &["document_id"]),
        audit_trace,
    ));
    v.push(ToolSpec::new(
        "nyx_notifications",
        "notifications",
        "Notification inbox (newest first, cursor paged) with unread count.",
        strict(
            json!({"unread_only": {"type": "boolean"}, "event": {"type": "string", "description": "review, a category (ticket) or an exact event (ticket.created)"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "cursor": {"type": "string"}}),
            &[],
        ),
        notifications,
    ));
    v.push(
        ToolSpec::new(
            "nyx_notifications_mark_read",
            "notifications",
            "Mark one notification (id) or all (all=true) as read.",
            strict(
                json!({"id": {"type": "string"}, "all": {"type": "boolean"}}),
                &[],
            ),
            mark_read,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_approval_request",
            "approvals",
            "Request approval for an action on a resource (default 7 day expiry).",
            strict(
                json!({"team_id": team, "action": {"type": "string"}, "resource_id": {"type": "string"}, "metadata": {"type": "object"}, "expires_in_ms": {"type": "integer", "minimum": 1}}),
                &["action", "resource_id"],
            ),
            approval_request,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_approval_review",
            "approvals",
            "Approve or reject a pending approval.",
            strict(
                json!({"approval_id": {"type": "string"}, "decision": {"type": "string", "enum": ["approve", "reject"]}, "reason": {"type": "string"}}),
                &["approval_id", "decision"],
            ),
            approval_review,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_approvals_list",
        "approvals",
        "List approvals of the team, optionally by status.",
        strict(json!({"team_id": team, "status": {"type": "string", "enum": ["pending", "approved", "rejected", "expired"]}}), &[]),
        approvals_list,
    ));
    v.push(ToolSpec::new(
        "nyx_scan_secrets",
        "governance",
        "Check content for secret patterns (API keys, tokens, private keys) before committing it to a document.",
        strict(json!({"content": {"type": "string"}}), &["content"]),
        scan_secrets,
    ));
    v.push(ToolSpec::new(
        "nyx_integrations_list",
        "integrations",
        "Configured integrations (GitHub, GitLab, Bitbucket, Jira, Confluence); credentials are redacted.",
        strict(json!({"team_id": team}), &[]),
        integrations_list,
    ));
    v.push(
        ToolSpec::new(
            "nyx_integration_set",
            "integrations",
            "Create or update the non-secret configuration of an integration (e.g. {\"repo\":\"owner/name\"} or {\"projectKey\":\"PROJ\"}). Credentials are rejected: use the OS keychain via the CLI.",
            strict(
                json!({"team_id": team, "type": {"type": "string", "enum": ["github", "gitlab", "bitbucket", "jira", "confluence"]}, "config": {"type": "object"}}),
                &["type", "config"],
            ),
            integration_set,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_integration_remove",
            "integrations",
            "Remove an integration by id.",
            strict(json!({"id": {"type": "string"}}), &["id"]),
            integration_remove,
        )
        .mutates(),
    );
}
