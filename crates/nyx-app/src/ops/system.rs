//! Web search and identity/status. TS parity: `nyx_web_search`.

use nyx_core::store::{DocumentRepo, SqliteDocuments, SqliteTeams, TeamRepo};
use serde_json::{json, Value};

use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, strict, Cost, Needs, Parity, ToolSpec};
use crate::Cx;

fn web_search(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let query = a.str("query")?;
    super::text("query", query, 1000)?;
    let search_type = a.opt_str("search_type").unwrap_or("general");
    let max = a.opt_i64("max_results").unwrap_or(5).clamp(1, 10) as usize;
    let backend = cx
        .services()
        .web_search
        .clone()
        .ok_or_else(|| AppError::not_configured("no web search backend configured"))?;
    // Same query shaping idea as the TS service: bias results by search type.
    let q = match search_type {
        "api_reference" => format!("{query} API reference"),
        "changelog" => format!("{query} changelog release notes"),
        "documentation" => format!("{query} documentation"),
        _ => query.to_owned(),
    };
    let results = backend.search(&q)?;
    Ok(json!({
        "query": query,
        "searchType": search_type,
        "results": results.into_iter().take(max).collect::<Vec<_>>(),
    }))
}

fn whoami(cx: &mut Cx<'_>, _a: &Args<'_>) -> AppResult<Value> {
    let team = SqliteTeams::new(cx.conn()).get(cx.app.team_id())?;
    let docs = SqliteDocuments::new(cx.conn()).list_live(&team.id)?.len();
    Ok(json!({
        "userId": cx.user_id(),
        "teamId": team.id,
        "teamSlug": team.slug,
        "agentId": cx.caller.agent_id,
        "client": cx.caller.client,
        "documents": docs,
        "version": nyx_core::VERSION,
        "mode": "local",
        "services": {
            "llm": cx.services().llm.as_ref().map(|l| l.name().to_owned()),
            "webSearch": cx.services().web_search.is_some(),
            "embedder": cx.services().embedder.model(),
        },
    }))
}

/// Register system tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    v.push(
        ToolSpec::new(
            "nyx_web_search",
            "search",
            "Search the web for information relevant to documentation. Returns search results with titles, URLs, and snippets. Useful for finding API references, library documentation, changelogs, and technical articles.",
            obj(
                json!({
                    "query": {"type": "string", "description": "The search query"},
                    "search_type": {"type": "string", "enum": ["general", "api_reference", "changelog", "documentation"], "description": "Type of search to optimize results (default: general)"},
                    "max_results": {"type": "number", "description": "Maximum number of results to return (1-10, default: 5)"},
                }),
                &["query"],
            ),
            web_search,
        )
        .parity(Parity::Exact)
        .needs(Needs::Search)
        .cost(Cost::Fixed(1)),
    );
    v.push(ToolSpec::new(
        "nyx_whoami",
        "system",
        "Local identity, default team, agent identity used for credit metering, and which services are configured.",
        strict(json!({}), &[]),
        whoami,
    ));
}
