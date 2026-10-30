//! Credit metering tools: `nyx_credits_{balance,reserve,commit,release,spend}` with the argument
//! names of `packages/mcp-server/src/credits.ts`, plus read-only `nyx_credits_history`.
//!
//! Credits are agent-native utility tokens, metered and spent by agents, never sold. Granting and
//! allocating are owner actions and therefore CLI-only (`nyx credits grant|allocate`), not tools.
//! Like the zod `.strict()` schemas of the TS server, unknown arguments are rejected.

use serde_json::{json, Value};

use crate::args::Args;
use crate::credits;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, Cost, Parity, ToolSpec};
use crate::Cx;

fn only(a: &Args<'_>, allowed: &[&str]) -> AppResult<()> {
    if let Some(o) = a.0.as_object() {
        for k in o.keys() {
            if !allowed.contains(&k.as_str()) {
                return Err(AppError::invalid(format!("Invalid arguments: {k}: unknown property")));
            }
        }
    }
    Ok(())
}

fn agent<'a>(cx: &'a Cx<'_>, a: &Args<'a>) -> AppResult<String> {
    let id = a.opt_str("agent_id").map_or_else(|| cx.caller.agent_id.clone(), str::to_owned);
    credits::check_agent(&id)?;
    credits::ensure_agent(cx.conn(), &id, cx.app.auto_allocate_amount())?;
    Ok(id)
}

fn key<'a>(a: &Args<'a>) -> AppResult<&'a str> {
    let k = a.str("idempotency_key")?;
    if !(8..=200).contains(&k.chars().count()) {
        return Err(AppError::invalid("idempotency_key must be 8-200 characters"));
    }
    Ok(k)
}

fn memo<'a>(a: &Args<'a>) -> AppResult<Option<&'a str>> {
    let m = a.opt_str("memo");
    if m.is_some_and(|m| m.chars().count() > 500) {
        return Err(AppError::invalid("memo must be at most 500 characters"));
    }
    Ok(m)
}

fn task<'a>(a: &Args<'a>) -> AppResult<Option<&'a str>> {
    let t = a.opt_str("task_type");
    if t.is_some_and(|t| t.is_empty() || t.chars().count() > 100) {
        return Err(AppError::invalid("task_type must be 1-100 characters"));
    }
    Ok(t)
}

fn amount(a: &Args<'_>, k: &str, min: i64) -> AppResult<i64> {
    let n = a.i64(k)?;
    if n < min {
        return Err(AppError::invalid(format!("{k} must be an integer >= {min}")));
    }
    Ok(n)
}

fn balance(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    only(a, &["agent_id"])?;
    let ag = agent(cx, a)?;
    credits::balance(cx.conn(), &ag)
}

fn reserve(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    only(a, &["idempotency_key", "agent_id", "amount", "task_type", "ttl_ms", "memo"])?;
    let k = key(a)?;
    let amt = amount(a, "amount", 1)?;
    let ttl = a.opt_i64("ttl_ms");
    if ttl.is_some_and(|t| t < 1) {
        return Err(AppError::invalid("ttl_ms must be a positive integer"));
    }
    let ag = agent(cx, a)?;
    credits::reserve(cx.conn(), &ag, k, amt, task(a)?, ttl, memo(a)?)
}

fn commit(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    only(a, &["idempotency_key", "reservation_id", "actual_amount", "memo"])?;
    let k = key(a)?;
    let rid = a.str("reservation_id")?;
    let actual = amount(a, "actual_amount", 0)?;
    credits::commit(cx.conn(), &cx.caller.agent_id.clone(), k, rid, actual, memo(a)?)
}

fn release(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    only(a, &["idempotency_key", "reservation_id", "memo"])?;
    let k = key(a)?;
    let rid = a.str("reservation_id")?;
    credits::release(cx.conn(), &cx.caller.agent_id.clone(), k, rid, memo(a)?)
}

fn spend(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    only(a, &["idempotency_key", "agent_id", "amount", "task_type", "memo"])?;
    let k = key(a)?;
    let amt = amount(a, "amount", 1)?;
    let ag = agent(cx, a)?;
    credits::spend(cx.conn(), &ag, k, amt, task(a)?, memo(a)?)
}

fn history(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    only(a, &["agent_id", "limit"])?;
    let ag = agent(cx, a)?;
    let limit = a.opt_i64("limit").unwrap_or(50).clamp(1, 500) as usize;
    credits::history(cx.conn(), Some(&ag), limit)
}

/// Register credit tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let key = json!({"type": "string", "minLength": 8, "maxLength": 200, "description": "Caller-chosen key; reuse the same key to safely retry. Use your tool-call id."});
    let agent = json!({"type": "string", "description": "Agent identity; defaults to NYX_AGENT_ID, the MCP client name, or \"default\"."});
    v.push(
        ToolSpec::new(
            "nyx_credits_balance",
            "credits",
            "Show the spendable credit balance of an agent (and held/pool amounts when reported). Credits are utility tokens, never sold.",
            obj(json!({"agent_id": agent}), &[]),
            balance,
        )
        .cost(Cost::Ledger)
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_credits_reserve",
            "credits",
            "Hold credits for an in-flight operation. Returns a reservation id to commit or release. Fails with insufficient_credits (available, required) when the budget is too low.",
            obj(
                json!({
                    "idempotency_key": key, "agent_id": agent,
                    "amount": {"type": "integer", "minimum": 1, "description": "Max credits to hold"},
                    "task_type": {"type": "string"},
                    "ttl_ms": {"type": "integer", "minimum": 1, "description": "Hold expiry in ms"},
                    "memo": {"type": "string"},
                }),
                &["idempotency_key", "amount"],
            ),
            reserve,
        )
        .cost(Cost::Ledger)
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_credits_commit",
            "credits",
            "Settle a reservation with the actual cost (<= reserved); the remainder returns to the agent budget.",
            obj(
                json!({
                    "idempotency_key": key, "reservation_id": {"type": "string"},
                    "actual_amount": {"type": "integer", "minimum": 0}, "memo": {"type": "string"},
                }),
                &["idempotency_key", "reservation_id", "actual_amount"],
            ),
            commit,
        )
        .cost(Cost::Ledger)
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_credits_release",
            "credits",
            "Cancel a reservation (operation failed or was cancelled); all held credits return to the agent budget.",
            obj(
                json!({"idempotency_key": key, "reservation_id": {"type": "string"}, "memo": {"type": "string"}}),
                &["idempotency_key", "reservation_id"],
            ),
            release,
        )
        .cost(Cost::Ledger)
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_credits_spend",
            "credits",
            "One-shot spend of a known cost (reserve + commit in a single call).",
            obj(
                json!({
                    "idempotency_key": key, "agent_id": agent,
                    "amount": {"type": "integer", "minimum": 1},
                    "task_type": {"type": "string"}, "memo": {"type": "string"},
                }),
                &["idempotency_key", "amount"],
            ),
            spend,
        )
        .cost(Cost::Ledger)
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_credits_history",
            "credits",
            "Newest-first ledger entries of an agent (reserve, commit, release, allocations).",
            obj(json!({"agent_id": agent, "limit": {"type": "integer", "minimum": 1, "maximum": 500}}), &[]),
            history,
        )
        .cost(Cost::Ledger),
    );
}
