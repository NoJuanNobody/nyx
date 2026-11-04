//! Mapping from parsed commands to `nyx-app` tool calls, plus the few local-only commands.

use std::io::Read;

use nyx_app::credits;
use nyx_app::{AppError, AppResult, Caller, NyxApp};
use serde_json::{json, Map, Value};

use crate::cli::{
    ApprovalCmd, AuditCmd, BranchCmd, ByokCmd, Cli, Cmd, CreditsCmd, DiffCmd, DocCmd, DriftCmd,
    FolderCmd, ImpactCmd, IntegrationCmd, Mode, PipelineCmd, ProfileCmd, SnapshotCmd, TeamCmd,
    TemplateCmd, TicketCmd, VersionCmd,
};

/// What `main` should do for a parsed command.
pub enum Plan {
    /// Call a tool.
    Tool(String, Value),
    /// Merge with optional automatic conflict resolution.
    Merge {
        /// Tool arguments for the first attempt.
        args: Value,
        /// Settle every conflict this way and retry.
        resolve: Option<&'static str>,
    },
    /// Sync a branch with optional automatic conflict resolution.
    Sync {
        /// Tool arguments for the first attempt.
        args: Value,
        /// Settle every conflict this way and retry.
        resolve: Option<&'static str>,
    },
    /// Done locally; the value is the result.
    Local(Value),
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        if !v.is_null() {
            m.insert(k.to_owned(), v);
        }
    }
    Value::Object(m)
}

fn opt<T: Into<Value>>(v: Option<T>) -> Value {
    v.map_or(Value::Null, Into::into)
}

/// Read text from a workspace file (through the jail) or stdin (`-`).
pub fn read_input(app: &NyxApp, spec: &str) -> AppResult<String> {
    if spec == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| AppError::new("io_error", e.to_string()))?;
        return Ok(s);
    }
    let jail = app
        .jail()
        .ok_or_else(|| AppError::not_configured("no workspace root available"))?;
    Ok(jail.read_to_string(spec)?)
}

fn body(app: &NyxApp, b: &crate::cli::Body) -> AppResult<Option<String>> {
    match (&b.content, &b.file) {
        (Some(c), _) => Ok(Some(c.clone())),
        (None, Some(f)) => Ok(Some(read_input(app, f)?)),
        (None, None) => Ok(None),
    }
}

fn read_secret_line() -> AppResult<String> {
    let mut s = String::new();
    std::io::stdin()
        .read_line(&mut s)
        .map_err(|e| AppError::new("io_error", e.to_string()))?;
    let s = s.trim().to_owned();
    if s.is_empty() {
        return Err(AppError::invalid(
            "expected the secret on stdin (pipe it in; it is never taken as an argument)",
        ));
    }
    Ok(s)
}

fn node(spec: &str) -> AppResult<(&str, &str)> {
    spec.split_once(':')
        .filter(|(k, r)| ["spec", "file", "ticket"].contains(k) && !r.is_empty())
        .ok_or_else(|| {
            AppError::invalid(format!(
                "`{spec}` is not KIND:REF (kind is spec, file or ticket)"
            ))
        })
}

fn key(k: Option<&String>) -> String {
    k.cloned()
        .unwrap_or_else(|| format!("cli-{}", uuid::Uuid::new_v4()))
}

fn format_arg(f: crate::cli::Format) -> Value {
    json!(f.as_str())
}

/// Turn the parsed command line into a [`Plan`].
#[allow(clippy::too_many_lines)]
pub fn plan(cli: &Cli, app: &NyxApp, caller: &Caller) -> AppResult<Plan> {
    let team = cli.team.clone().unwrap_or_else(|| app.team_id().to_owned());
    let t = |n: &str, a: Value| Ok(Plan::Tool(n.to_owned(), a));
    match &cli.cmd {
        Cmd::Mcp | Cmd::Completions { .. } => Err(AppError::new("internal", "handled by main")),
        Cmd::Doc(c) => match c {
            DocCmd::List => t("nyx_search_docs", json!({"team_id": team})),
            DocCmd::Show { id } => t("nyx_read_doc", json!({"document_id": id})),
            DocCmd::Create {
                title,
                path,
                body: b,
            } => {
                let content = body(app, b)?.unwrap_or_default();
                t(
                    "nyx_create_doc",
                    json!({"team_id": team, "title": title, "path": path, "content": content}),
                )
            }
            DocCmd::Update { id, title, body: b } => t(
                "nyx_update_doc",
                obj(vec![
                    ("document_id", json!(id)),
                    ("title", opt(title.clone())),
                    ("content", opt(body(app, b)?)),
                ]),
            ),
            DocCmd::Delete { id } => t("nyx_delete_doc", json!({"document_id": id})),
            DocCmd::Restore { id } => t("nyx_restore_doc", json!({"document_id": id})),
            DocCmd::Stage {
                id,
                stage,
                pipeline,
                sequential,
            } => t(
                "nyx_set_stage",
                obj(vec![
                    ("document_id", json!(id)),
                    ("stage", opt(stage.clone())),
                    ("pipeline", opt(pipeline.clone())),
                    (
                        "policy",
                        if *sequential {
                            json!("sequential")
                        } else {
                            Value::Null
                        },
                    ),
                ]),
            ),
            DocCmd::Move { id, to } => {
                t("nyx_move_doc", json!({"document_id": id, "new_parent": to}))
            }
        },
        Cmd::Team(c) => match c {
            TeamCmd::List => t("nyx_list_teams", json!({})),
            TeamCmd::Show { id } => t("nyx_get_team", json!({"team_id": id})),
            TeamCmd::Create { name, slug } => {
                t("nyx_create_team", json!({"name": name, "slug": slug}))
            }
        },
        Cmd::Version(c) => match c {
            VersionCmd::List { doc } => t("nyx_list_versions", json!({"document_id": doc})),
            VersionCmd::Show { id, doc, number } => t(
                "nyx_get_version",
                obj(vec![
                    ("version_id", opt(id.clone())),
                    ("document_id", opt(doc.clone())),
                    ("version", opt(*number)),
                ]),
            ),
            VersionCmd::Create {
                doc,
                message,
                body: b,
            } => t(
                "nyx_create_version",
                obj(vec![
                    ("document_id", json!(doc)),
                    ("message", opt(message.clone())),
                    ("content", opt(body(app, b)?)),
                ]),
            ),
            VersionCmd::Restore { doc, version_id } => t(
                "nyx_restore_version",
                json!({"document_id": doc, "version_id": version_id}),
            ),
        },
        Cmd::Branch(c) => match c {
            BranchCmd::Create { doc, name, base } => t(
                "nyx_create_branch",
                obj(vec![
                    ("document_id", json!(doc)),
                    ("name", json!(name)),
                    ("base_version_id", opt(base.clone())),
                ]),
            ),
            BranchCmd::List { doc } => t("nyx_list_branches", json!({"document_id": doc})),
            BranchCmd::Show { id } => t("nyx_get_branch", json!({"branch_id": id})),
            BranchCmd::Edit { id, body: b } => {
                let content =
                    body(app, b)?.ok_or_else(|| AppError::invalid("give --content or --file"))?;
                t(
                    "nyx_update_branch",
                    json!({"branch_id": id, "content": content}),
                )
            }
            BranchCmd::Submit { id } => t(
                "nyx_branch_review",
                json!({"branch_id": id, "action": "submit"}),
            ),
            BranchCmd::Approve { id } => t(
                "nyx_branch_review",
                json!({"branch_id": id, "action": "approve"}),
            ),
            BranchCmd::Reject { id } => t(
                "nyx_branch_review",
                json!({"branch_id": id, "action": "reject"}),
            ),
            BranchCmd::Reopen { id } => t(
                "nyx_branch_review",
                json!({"branch_id": id, "action": "reopen"}),
            ),
            BranchCmd::Diff { id, head } => t(
                "nyx_diff_branch",
                json!({"branch_id": id, "against": if *head { "head" } else { "base" }}),
            ),
            BranchCmd::Sync { id, resolve } => Ok(Plan::Sync {
                args: json!({"branch_id": id}),
                resolve: resolve.map(crate::cli::Resolve::as_str),
            }),
        },
        Cmd::Diff(c) => match c {
            DiffCmd::Versions { a, b, format } => t(
                "nyx_diff_versions",
                json!({"version_a": a, "version_b": b, "format": format.as_str()}),
            ),
            DiffCmd::Files { old, new, format } => t(
                "nyx_diff_text",
                json!({"old": read_input(app, old)?, "new": read_input(app, new)?, "format": format.as_str()}),
            ),
            DiffCmd::Branch { id, head } => t(
                "nyx_diff_branch",
                json!({"branch_id": id, "against": if *head { "head" } else { "base" }}),
            ),
            DiffCmd::Snapshot { id } => t("nyx_diff_snapshot", json!({"snapshot_id": id})),
        },
        Cmd::Merge(m) => {
            let mut args = obj(vec![
                ("branch_id", json!(m.branch)),
                ("dry_run", if m.dry_run { json!(true) } else { Value::Null }),
            ]);
            if let Some(f) = &m.resolutions {
                let parsed: Value = serde_json::from_str(&read_input(app, f)?)?;
                args["resolutions"] = parsed;
            }
            Ok(Plan::Merge {
                args,
                resolve: m.resolve.map(crate::cli::Resolve::as_str),
            })
        }
        Cmd::Snapshot(c) => match c {
            SnapshotCmd::Create { name, docs } => t(
                "nyx_create_snapshot",
                json!({"name": name, "document_ids": docs}),
            ),
            SnapshotCmd::List { doc } => t(
                "nyx_list_snapshots",
                obj(vec![
                    ("document_id", opt(doc.clone())),
                    ("team_id", json!(team)),
                ]),
            ),
            SnapshotCmd::Restore { id } => t("nyx_restore_snapshot", json!({"snapshot_id": id})),
        },
        Cmd::Tree { path } => t(
            "nyx_get_tree",
            obj(vec![("team_id", json!(team)), ("path", opt(path.clone()))]),
        ),
        Cmd::Folder(c) => match c {
            FolderCmd::Create { name, parent } => t(
                "nyx_create_folder",
                json!({"team_id": team, "name": name, "parent_path": parent}),
            ),
            FolderCmd::Rename { path, name } => t(
                "nyx_rename_folder",
                json!({"team_id": team, "path": path, "name": name}),
            ),
            FolderCmd::Move { path, to } => t(
                "nyx_move_folder",
                json!({"team_id": team, "path": path, "new_parent": to}),
            ),
            FolderCmd::Delete { path, cascade } => t(
                "nyx_delete_folder",
                json!({"team_id": team, "path": path, "cascade": cascade}),
            ),
        },
        Cmd::Pipeline(c) => match c {
            PipelineCmd::List => t("nyx_list_pipelines", json!({})),
            PipelineCmd::Show { slug } => t("nyx_get_pipeline", json!({"slug": slug})),
        },
        Cmd::Template(c) => match c {
            TemplateCmd::List { pipeline, stage } => t(
                "nyx_list_templates",
                obj(vec![
                    ("pipeline", opt(pipeline.clone())),
                    ("stage", opt(stage.clone())),
                ]),
            ),
            TemplateCmd::New {
                pipeline,
                stage,
                template,
                title,
                path,
                vars,
            } => {
                let mut variables = Map::new();
                for v in vars {
                    let (k, val) = v
                        .split_once('=')
                        .ok_or_else(|| AppError::invalid(format!("--var {v} is not NAME=VALUE")))?;
                    variables.insert(k.to_owned(), json!(val));
                }
                t(
                    "nyx_create_from_template",
                    obj(vec![
                        ("team_id", json!(team)),
                        ("pipeline", json!(pipeline)),
                        ("stage", json!(stage)),
                        ("template", json!(template)),
                        ("title", opt(title.clone())),
                        ("path", opt(path.clone())),
                        ("variables", Value::Object(variables)),
                    ]),
                )
            }
            TemplateCmd::Check {
                doc,
                pipeline,
                stage,
                template,
            } => t(
                "nyx_template_completeness",
                json!({"document_id": doc, "pipeline": pipeline, "stage": stage, "template": template}),
            ),
        },
        Cmd::Export(e) => t(
            "nyx_export_doc",
            obj(vec![
                ("document_id", json!(e.doc)),
                ("format", format_arg(e.format)),
                ("path", opt(e.out.clone())),
                ("latex_theme", opt(e.latex_theme.clone())),
            ]),
        ),
        Cmd::Bundle(b) => t(
            "nyx_export_bundle",
            json!({"document_ids": b.docs, "formats": b.formats.iter().map(|f| f.as_str()).collect::<Vec<_>>(), "path": b.out}),
        ),
        Cmd::Ticket(c) => match c {
            TicketCmd::Create {
                doc,
                provider,
                title,
                body: b,
                body_file,
                destination,
            } => {
                let text = match (b, body_file) {
                    (Some(b), _) => b.clone(),
                    (None, Some(f)) => read_input(app, f)?,
                    (None, None) => String::new(),
                };
                t(
                    "nyx_create_ticket",
                    obj(vec![
                        ("document_id", json!(doc)),
                        ("provider", json!(provider)),
                        ("title", json!(title)),
                        ("body", json!(text)),
                        ("destination", opt(destination.clone())),
                    ]),
                )
            }
            TicketCmd::List { doc } => t("nyx_list_tickets", json!({"document_id": doc})),
            TicketCmd::Status { id, status } => t(
                "nyx_set_ticket_status",
                json!({"ticket_id": id, "status": status}),
            ),
            TicketCmd::Gate { doc, stage } => t(
                "nyx_stage_gate",
                json!({"document_id": doc, "target_stage": stage}),
            ),
            TicketCmd::Readiness { docs } => t(
                "nyx_assess_readiness",
                json!({"team_id": team, "document_ids": docs}),
            ),
        },
        Cmd::Scan(s) => t(
            "nyx_scan",
            obj(vec![
                ("team_id", json!(team)),
                ("path", json!(s.path)),
                ("repo_name", opt(s.repo_name.clone())),
                ("plan_only", if s.plan { json!(true) } else { Value::Null }),
                ("force", if s.force { json!(true) } else { Value::Null }),
                ("max_files", opt(s.max_files)),
            ]),
        ),
        Cmd::Drift(c) => match c {
            DriftCmd::Detect { spec, code } => t(
                "nyx_detect_drift",
                json!({"spec_content": read_input(app, spec)?, "code_content": read_input(app, code)?}),
            ),
            DriftCmd::Check { files } => t(
                "nyx_drift_check",
                json!({"team_id": team, "changed_files": files}),
            ),
            DriftCmd::List { doc } => t(
                "nyx_list_drift",
                obj(vec![
                    ("team_id", json!(team)),
                    ("document_id", opt(doc.clone())),
                ]),
            ),
            DriftCmd::Resolve { id, status } => t(
                "nyx_set_drift_status",
                json!({"drift_id": id, "status": status}),
            ),
        },
        Cmd::Search(s) => t(
            "nyx_search",
            json!({"team_id": team, "query": s.query, "mode": match s.mode { Mode::Semantic => "semantic", Mode::Keyword => "keyword", Mode::Hybrid => "hybrid" }, "top_k": s.top_k}),
        ),
        Cmd::CodeSearch { query, top_k } => t(
            "nyx_search_code",
            json!({"team_id": team, "query": query, "top_k": top_k}),
        ),
        Cmd::Index { force } => t("nyx_index_docs", json!({"team_id": team, "force": force})),
        Cmd::Impact(c) => match c {
            ImpactCmd::Link { edge, weight } => {
                let (sk, sr) = node(&edge.src)?;
                let (dk, dr) = node(&edge.dst)?;
                t(
                    "nyx_impact_link",
                    json!({"team_id": team, "src_kind": sk, "src": sr, "dst_kind": dk, "dst": dr, "relation": edge.relation, "weight": weight}),
                )
            }
            ImpactCmd::Unlink { edge } => {
                let (sk, sr) = node(&edge.src)?;
                let (dk, dr) = node(&edge.dst)?;
                t(
                    "nyx_impact_unlink",
                    json!({"team_id": team, "src_kind": sk, "src": sr, "dst_kind": dk, "dst": dr, "relation": edge.relation}),
                )
            }
            ImpactCmd::Show { node: n, depth } => {
                let (k, r) = node(n)?;
                t(
                    "nyx_impact",
                    json!({"team_id": team, "kind": k, "ref": r, "max_depth": depth}),
                )
            }
        },
        Cmd::Audit(c) => match c {
            AuditCmd::Log {
                doc,
                types,
                text,
                limit,
            } => t(
                "nyx_audit_log",
                obj(vec![
                    ("team_id", json!(team)),
                    ("document_id", opt(doc.clone())),
                    (
                        "event_types",
                        if types.is_empty() {
                            Value::Null
                        } else {
                            json!(types)
                        },
                    ),
                    ("text", opt(text.clone())),
                    ("limit", json!(limit)),
                ]),
            ),
            AuditCmd::Export { format, doc } => t(
                "nyx_audit_export",
                obj(vec![
                    ("team_id", json!(team)),
                    ("format", json!(format)),
                    ("document_id", opt(doc.clone())),
                ]),
            ),
            AuditCmd::Trace { doc } => t("nyx_audit_trace", json!({"document_id": doc})),
        },
        Cmd::Notifications { unread, limit, .. } => t(
            "nyx_notifications",
            json!({"unread_only": unread, "limit": limit}),
        ),
        Cmd::Approval(c) => match c {
            ApprovalCmd::Request { action, resource } => t(
                "nyx_approval_request",
                json!({"team_id": team, "action": action, "resource_id": resource}),
            ),
            ApprovalCmd::Review {
                id,
                decision,
                reason,
            } => t(
                "nyx_approval_review",
                obj(vec![
                    ("approval_id", json!(id)),
                    ("decision", json!(decision)),
                    ("reason", opt(reason.clone())),
                ]),
            ),
            ApprovalCmd::List { status } => t(
                "nyx_approvals_list",
                obj(vec![
                    ("team_id", json!(team)),
                    ("status", opt(status.clone())),
                ]),
            ),
        },
        Cmd::Integration(c) => match c {
            IntegrationCmd::List => t("nyx_integrations_list", json!({"team_id": team})),
            IntegrationCmd::Set { kind, config } => {
                let cfg: Value = serde_json::from_str(config)?;
                t(
                    "nyx_integration_set",
                    json!({"team_id": team, "type": kind, "config": cfg}),
                )
            }
            IntegrationCmd::Remove { id } => t("nyx_integration_remove", json!({"id": id})),
            IntegrationCmd::Secret { provider } => {
                use nyx_core::profile::{Provider, SecretKey};
                let p = Provider::from_slug(provider)?;
                let secret = read_secret_line()?;
                app.secrets()
                    .set(&SecretKey::access_token(p), secrecy_string(secret))
                    .map_err(AppError::from)?;
                Ok(Plan::Local(
                    json!({"stored": true, "provider": provider, "kind": "access-token"}),
                ))
            }
        },
        Cmd::Byok(c) => byok(app, c).map(Plan::Local),
        Cmd::Profile(c) => profile(app, c).map(Plan::Local),
        Cmd::Credits(c) => credits_plan(app, caller, c),
        Cmd::Quality { file } => t(
            "nyx_check_quality",
            json!({"content": read_input(app, file)?}),
        ),
        Cmd::Secrets { file } => t(
            "nyx_scan_secrets",
            json!({"content": read_input(app, file)?}),
        ),
        Cmd::Whoami => t("nyx_whoami", json!({})),
        Cmd::Tools => Ok(Plan::Local(Value::Array(
            nyx_app::registry()
                .iter()
                .map(|s| {
                    json!({
                        "name": s.name, "domain": s.domain, "price": app.price_of(s),
                        "cost": format!("{:?}", s.cost), "needs": format!("{:?}", s.needs),
                        "tsParity": s.parity.label(), "mutates": s.mutates,
                    })
                })
                .collect(),
        ))),
        Cmd::Tool { name, args } => {
            let parsed: Value = serde_json::from_str(args)?;
            Ok(Plan::Tool(name.clone(), parsed))
        }
    }
}

fn secrecy_string(s: String) -> secrecy::SecretString {
    secrecy::SecretString::from(s)
}

fn byok(app: &NyxApp, c: &ByokCmd) -> AppResult<Value> {
    use nyx_core::ai::{ByokKeys, ProviderKind};
    let keys = ByokKeys::new(app.secrets().as_ref());
    match c {
        ByokCmd::Set { provider } => {
            let kind = ProviderKind::from_slug(provider)?;
            let key = read_secret_line()?;
            let status = match keys.add(kind, &key) {
                Err(nyx_core::Error::Conflict(_)) => keys.rotate(kind, &key)?,
                other => other?,
            };
            Ok(serde_json::to_value(status)?)
        }
        ByokCmd::Status { provider } => Ok(serde_json::to_value(
            keys.status(ProviderKind::from_slug(provider)?)?,
        )?),
        ByokCmd::Remove { provider } => {
            keys.remove(ProviderKind::from_slug(provider)?)?;
            Ok(json!({"removed": true, "provider": provider}))
        }
    }
}

fn profile(app: &NyxApp, c: &ProfileCmd) -> AppResult<Value> {
    use nyx_core::profile::ProfileStore;
    let store = match app.data_dir() {
        Some(d) => ProfileStore::at(d),
        None => ProfileStore::default_location()?,
    };
    let mut p = store.load_or_create("Local user")?;
    if let ProfileCmd::SetName { name } = c {
        nyx_core::security::validate::check_name("name", name, 100)?;
        name.trim().clone_into(&mut p.display_name);
        store.save(&p)?;
    }
    Ok(json!({
        "id": p.id, "displayName": p.display_name, "createdAt": p.created_at,
        "userId": app.user_id(), "teamId": app.team_id(),
        "dataDir": store.dir().display().to_string(),
    }))
}

fn credits_plan(app: &NyxApp, caller: &Caller, c: &CreditsCmd) -> AppResult<Plan> {
    let t = |n: &str, a: Value| Ok(Plan::Tool(n.to_owned(), a));
    match c {
        CreditsCmd::Balance => t("nyx_credits_balance", json!({})),
        CreditsCmd::Reserve {
            amount,
            task_type,
            ttl_ms,
            memo,
            idempotency_key,
        } => t(
            "nyx_credits_reserve",
            obj(vec![
                ("idempotency_key", json!(key(idempotency_key.as_ref()))),
                ("amount", json!(amount)),
                ("task_type", opt(task_type.clone())),
                ("ttl_ms", opt(*ttl_ms)),
                ("memo", opt(memo.clone())),
            ]),
        ),
        CreditsCmd::Commit {
            reservation_id,
            actual,
            memo,
            idempotency_key,
        } => t(
            "nyx_credits_commit",
            obj(vec![
                ("idempotency_key", json!(key(idempotency_key.as_ref()))),
                ("reservation_id", json!(reservation_id)),
                ("actual_amount", json!(actual)),
                ("memo", opt(memo.clone())),
            ]),
        ),
        CreditsCmd::Release {
            reservation_id,
            memo,
            idempotency_key,
        } => t(
            "nyx_credits_release",
            obj(vec![
                ("idempotency_key", json!(key(idempotency_key.as_ref()))),
                ("reservation_id", json!(reservation_id)),
                ("memo", opt(memo.clone())),
            ]),
        ),
        CreditsCmd::Spend {
            amount,
            task_type,
            memo,
            idempotency_key,
        } => t(
            "nyx_credits_spend",
            obj(vec![
                ("idempotency_key", json!(key(idempotency_key.as_ref()))),
                ("amount", json!(amount)),
                ("task_type", opt(task_type.clone())),
                ("memo", opt(memo.clone())),
            ]),
        ),
        CreditsCmd::History { limit, all } => {
            if *all {
                let v = app.with_cx(caller, |cx| {
                    credits::history(cx.conn(), None, *limit as usize)
                })?;
                Ok(Plan::Local(v))
            } else {
                t("nyx_credits_history", json!({"limit": limit}))
            }
        }
        CreditsCmd::Verify => Ok(Plan::Local(
            app.with_cx(caller, |cx| credits::verify(cx.conn()))?,
        )),
        CreditsCmd::Grant {
            amount,
            memo,
            idempotency_key,
        } => {
            let k = key(idempotency_key.as_ref());
            Ok(Plan::Local(app.with_cx(caller, |cx| {
                credits::grant(cx.conn(), &k, *amount, memo.as_deref())
            })?))
        }
        CreditsCmd::Allocate {
            agent,
            amount,
            idempotency_key,
        } => {
            let k = key(idempotency_key.as_ref());
            Ok(Plan::Local(app.with_cx(caller, |cx| {
                credits::allocate(cx.conn(), &k, agent, *amount, None)
            })?))
        }
        CreditsCmd::Deallocate {
            agent,
            amount,
            idempotency_key,
        } => {
            let k = key(idempotency_key.as_ref());
            Ok(Plan::Local(app.with_cx(caller, |cx| {
                credits::deallocate(cx.conn(), &k, agent, *amount, None)
            })?))
        }
    }
}
