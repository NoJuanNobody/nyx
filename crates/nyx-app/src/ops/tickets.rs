//! Tickets and the Sprint Gatekeeper. Source: `nyx_core::tickets::{tracker, draft, gatekeeper}`.
//! TS parity: `nyx_create_ticket` (extended with an optional `destination`).
//!
//! Posting goes through the `TrackerSet` in [`Services`](crate::Services); offline the call fails
//! with `not_configured` and nothing is recorded.

use nyx_core::model::{AuditEventType, NewAuditEvent, NewTicket, TicketStatus};
use nyx_core::store::{
    AuditRepo, DocumentRepo, IntegrationRepo, SqliteAudit, SqliteDocuments, SqliteIntegrations,
    SqliteTickets, TicketRepo,
};
use nyx_core::tickets::draft::{with_traceability, TraceRef};
use nyx_core::tickets::gatekeeper::{
    assess_readiness, evaluate_stage_gate, ReadinessConfig, SpecInput, TicketInput,
    DEFAULT_STAGE_ORDER,
};
use nyx_core::tickets::sprint::SprintStatus;
use nyx_core::tickets::tracker::{Destination, NewIssue, TrackerError};
use serde_json::{json, Value};
use std::str::FromStr;

use super::{id, name, text, to_json, MAX_CONTENT_BYTES};
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, strict, Cost, Parity, ToolSpec};
use crate::Cx;

fn tracker_err(e: TrackerError) -> AppError {
    match &e {
        TrackerError::Invalid(m) if m.starts_with("No ") => AppError::not_configured(m),
        TrackerError::Auth(_) => AppError::new("tracker_auth", e.to_string()),
        TrackerError::RateLimited { .. } => AppError::new("rate_limited", e.to_string()),
        _ => AppError::new("tracker_error", e.to_string()),
    }
}

/// Destination from the explicit argument, else from the team's integration config.
fn destination(
    cx: &Cx<'_>,
    team_id: &str,
    provider: &str,
    explicit: Option<&str>,
) -> AppResult<Destination> {
    if let Some(d) = explicit {
        return Destination::from_identifier(provider, d).map_err(tracker_err);
    }
    let integrations = SqliteIntegrations::new(cx.conn()).list(team_id)?;
    let hit = integrations
        .iter()
        .find(|i| i.r#type.to_string() == provider);
    let cfg = hit.map(|i| &i.config);
    let get = |keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| cfg?.get(*k)?.as_str().map(str::to_owned))
    };
    let ident = if provider == "jira" {
        get(&["projectKey", "project_key", "defaultProject", "project"])
    } else {
        get(&["repo", "repository", "fullName", "full_name"]).or_else(|| {
            let o = get(&["owner"])?;
            let r = get(&["name", "repoName"])?;
            Some(format!("{o}/{r}"))
        })
    };
    match ident {
        Some(i) => Destination::from_identifier(provider, &i).map_err(tracker_err),
        None => Err(AppError::invalid(format!(
            "no {provider} destination: pass `destination` (owner/repo or project key) or configure the {provider} integration"
        ))),
    }
}

fn create_ticket(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let provider = a.str("provider")?;
    let title = name("title", a.str("title")?, 300)?;
    let body = a.str("body")?;
    text("body", body, MAX_CONTENT_BYTES)?;
    let doc = SqliteDocuments::new(cx.conn()).get(d)?;
    let dest = destination(cx, &doc.team_id, provider, a.opt_str("destination"))?;
    let tracker = cx.services().trackers.clone();
    let tracker = tracker.for_destination(&dest).map_err(tracker_err)?;
    let body = with_traceability(
        body,
        &doc.title,
        &TraceRef {
            document_id: doc.id.clone(),
            draft_id: String::new(),
        },
    );
    let issue = tracker
        .create_issue(
            &dest,
            &NewIssue {
                title: title.clone(),
                body: body.clone(),
                labels: Vec::new(),
            },
        )
        .map_err(tracker_err)?;
    let tp = dest.kind().ticket_provider();
    let user = cx.user_id().to_owned();
    let row = cx.db.transaction(|c| {
        let t = SqliteTickets::new(c).create(&NewTicket {
            document_id: doc.id.clone(),
            provider: tp,
            external_id: issue.external_id.clone(),
            external_url: issue.external_url.clone(),
            title: title.clone(),
            body: body.clone(),
            insights: None,
            created_by_id: user.clone(),
        })?;
        let mut ev = NewAuditEvent::new(&doc.team_id, AuditEventType::TicketCreated);
        ev.actor_id = Some(user.clone());
        ev.document_id = Some(doc.id.clone());
        ev.ticket_id = Some(t.id.clone());
        ev.metadata = json!({"provider": tp, "externalId": issue.external_id});
        SqliteAudit::new(c).append(&ev)?;
        Ok(t)
    })?;
    Ok(json!({
        "id": row.id, "title": row.title, "url": row.external_url,
        "externalId": row.external_id, "provider": row.provider, "status": row.status,
    }))
}

fn list_tickets(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let ts = SqliteTickets::new(cx.conn()).list_by_document(d)?;
    Ok(Value::Array(
        ts.iter()
            .map(|t| json!({"id": t.id, "title": t.title, "provider": t.provider, "externalId": t.external_id, "url": t.external_url, "status": t.status}))
            .collect(),
    ))
}

fn set_ticket_status(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let t = a.str("ticket_id")?;
    id("ticket_id", t)?;
    let status =
        TicketStatus::from_str(a.str("status")?).map_err(|e| AppError::invalid(e.to_string()))?;
    to_json(&SqliteTickets::new(cx.conn()).set_status(t, status)?)
}

fn stage_gate(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let doc = SqliteDocuments::new(cx.conn()).get(d)?;
    let target = a.str("target_stage")?;
    let r = evaluate_stage_gate(
        &doc.content,
        doc.stage.as_deref(),
        target,
        &DEFAULT_STAGE_ORDER,
    );
    to_json(&r)
}

fn readiness(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let mut ids = a.str_list("document_ids");
    let docs_repo = SqliteDocuments::new(cx.conn());
    if ids.is_empty() {
        ids = docs_repo
            .list_live(&team)?
            .into_iter()
            .map(|d| d.id)
            .collect();
    }
    let mut specs = Vec::new();
    let mut tickets = Vec::new();
    for i in &ids {
        id("document_ids", i)?;
        let d = docs_repo.get(i)?;
        specs.push(SpecInput {
            id: d.id.clone(),
            title: d.title.clone(),
            content: d.content.clone(),
            stage: d.stage.clone(),
            quality_score: None,
        });
        for t in SqliteTickets::new(cx.conn()).list_by_document(i)? {
            tickets.push(TicketInput {
                id: t.id,
                title: t.title,
                body: t.body,
                labels: Vec::new(),
                status: match t.status {
                    TicketStatus::Open => SprintStatus::Todo,
                    TicketStatus::InProgress => SprintStatus::InProgress,
                    TicketStatus::Closed => SprintStatus::Done,
                },
                document_id: Some(t.document_id),
            });
        }
    }
    let report = assess_readiness(&tickets, &specs, None, &ReadinessConfig::default());
    to_json(&report)
}

/// Register ticket tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    v.push(
        ToolSpec::new(
            "nyx_create_ticket",
            "tickets",
            "Create a ticket (GitHub issue or Jira) linked to a Nyx document.",
            obj(
                json!({
                    "document_id": {"type": "string", "description": "UUID of the linked document"},
                    "provider": {"type": "string", "enum": ["github", "jira"], "description": "Ticket provider"},
                    "title": {"type": "string", "description": "Ticket title"},
                    "body": {"type": "string", "description": "Ticket description body (markdown)"},
                    "destination": {"type": "string", "description": "owner/repo or Jira project key (default: from the team integration)"},
                }),
                &["document_id", "provider", "title", "body"],
            ),
            create_ticket,
        )
        .parity(Parity::Extended)
        .cost(Cost::Fixed(2))
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_list_tickets",
        "tickets",
        "Tickets linked to a document.",
        strict(json!({"document_id": {"type": "string"}}), &["document_id"]),
        list_tickets,
    ));
    v.push(
        ToolSpec::new(
            "nyx_set_ticket_status",
            "tickets",
            "Set the locally tracked status of a ticket (open, in_progress, closed).",
            strict(
                json!({"ticket_id": {"type": "string"}, "status": {"type": "string", "enum": ["open", "in_progress", "closed"]}}),
                &["ticket_id", "status"],
            ),
            set_ticket_status,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_stage_gate",
        "gatekeeper",
        "Sprint Gatekeeper stage gate: may this document move to target_stage (content length, stage order)?",
        strict(
            json!({"document_id": {"type": "string"}, "target_stage": {"type": "string", "enum": DEFAULT_STAGE_ORDER}}),
            &["document_id", "target_stage"],
        ),
        stage_gate,
    ));
    v.push(ToolSpec::new(
        "nyx_assess_readiness",
        "gatekeeper",
        "Sprint readiness over documents and their tickets: score, blockers and warnings (default: all live documents).",
        strict(json!({"team_id": {"type": "string"}, "document_ids": {"type": "array", "items": {"type": "string"}}}), &[]),
        readiness,
    ));
}
