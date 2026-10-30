//! Credit metering over the append-only ledger (`nyx_core::ledger`), local single-user defaults.
//!
//! One workspace (`local`), agents identified by name. Every function opens the ledger from SQLite
//! (full hash-chain verification, O(entries)) so the CLI, the MCP server and the desktop app can
//! share one database file safely; commands persist before returning.
//!
//! Credits are agent-native utility tokens: there is no purchase, price or plan anywhere here.

use nyx_core::ledger::{
    Actor, ActorKind, Command, CommandResult, Credits, LedgerEntry, LedgerErrorCode, LedgerService,
    Meta, ReservationStatus, LOCAL_WORKSPACE,
};
use nyx_core::model::now_ms;
use nyx_core::store::SqliteLedgerStore;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

/// Default reservation time-to-live for per-call metering (5 minutes).
pub const CALL_TTL_MS: i64 = 300_000;

fn open(conn: &Connection) -> AppResult<LedgerService<SqliteLedgerStore<'_>>> {
    let mut svc = LedgerService::open(SqliteLedgerStore::new(conn))?;
    svc.expire_due(now_ms())?;
    Ok(svc)
}

/// Validate an agent identity (same rule as the ledger: no whitespace or `:`).
pub fn check_agent(agent: &str) -> AppResult<()> {
    if agent.is_empty() || agent.len() > 100 || agent.chars().any(|c| c == ':' || c.is_whitespace()) {
        return Err(AppError::invalid(
            "agent_id must be 1-100 chars without whitespace or ':'",
        ));
    }
    Ok(())
}

/// Turn a free-form client name into a valid agent id.
#[must_use]
pub fn sanitize_agent(raw: &str) -> String {
    let s: String = raw
        .trim()
        .chars()
        .map(|c| if c == ':' || c.is_whitespace() || c.is_control() { '-' } else { c })
        .take(100)
        .collect();
    if s.is_empty() {
        "default".into()
    } else {
        s
    }
}

fn user_actor() -> Actor {
    Actor::local_user()
}

fn agent_actor(agent: &str) -> Actor {
    Actor::new(ActorKind::Agent, agent)
}

fn system_actor() -> Actor {
    Actor::new(ActorKind::System, "nyx")
}

/// First-run setup: the owner's initial grant (`cfg:init`, idempotent) into the pool.
pub fn ensure_init(conn: &Connection, initial_grant: Credits) -> AppResult<()> {
    if initial_grant <= 0 {
        return Ok(());
    }
    let mut svc = open(conn)?;
    let meta = Meta::new("cfg:init", system_actor()).memo("initial local grant (owner config, not an entitlement)");
    match svc.execute(
        meta,
        Command::Grant {
            workspace_id: LOCAL_WORKSPACE.into(),
            amount: initial_grant,
        },
    ) {
        Ok(_) => Ok(()),
        // The owner edited the configured amount after first run: the original grant stands.
        Err(nyx_core::Error::Ledger(l)) if l.code == LedgerErrorCode::IdempotencyConflict => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// First sight of an agent: move up to `auto_allocate` credits from the pool to its budget.
/// Idempotent per agent (`auto:<agent>`); a later change of the amount never double-allocates.
pub fn ensure_agent(conn: &Connection, agent: &str, auto_allocate: Credits) -> AppResult<()> {
    check_agent(agent)?;
    if auto_allocate <= 0 {
        return Ok(());
    }
    let mut svc = open(conn)?;
    let key = format!("auto:{agent}");
    // Cap at what the pool holds so a small pool still funds the first agent.
    let pool = svc.ledger().pool_balance(LOCAL_WORKSPACE);
    let amount = auto_allocate.min(pool);
    if amount <= 0 {
        return Ok(());
    }
    let meta = Meta::new(&key, system_actor()).memo("auto-allocation on first sight");
    match svc.execute(
        meta,
        Command::Allocate {
            workspace_id: LOCAL_WORKSPACE.into(),
            agent_id: agent.into(),
            amount,
        },
    ) {
        Ok(_) => Ok(()),
        Err(nyx_core::Error::Ledger(l))
            if matches!(
                l.code,
                LedgerErrorCode::IdempotencyConflict | LedgerErrorCode::InsufficientCredits
            ) =>
        {
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

fn entry_json(e: &LedgerEntry, replayed: bool) -> Value {
    json!({
        "entryId": e.id,
        "seq": e.seq,
        "kind": e.kind.as_str(),
        "agentId": e.agent_id,
        "reservationId": e.reservation_id,
        "taskType": e.task_type,
        "memo": e.memo,
        "ts": e.ts,
        "expiresAt": e.expires_at,
        "postings": e.postings.iter().map(|p| json!({"account": p.account, "amount": p.amount})).collect::<Vec<_>>(),
        "replayed": replayed,
    })
}

fn result_json(r: &CommandResult) -> Value {
    entry_json(&r.entry, r.replayed)
}

/// Balance view of one agent.
pub fn balance(conn: &Connection, agent: &str) -> AppResult<Value> {
    check_agent(agent)?;
    let svc = open(conn)?;
    let l = svc.ledger();
    Ok(json!({
        "workspaceId": LOCAL_WORKSPACE,
        "agentId": agent,
        "balance": l.agent_balance(LOCAL_WORKSPACE, agent),
        "held": l.agent_held(LOCAL_WORKSPACE, agent),
        "pool": l.pool_balance(LOCAL_WORKSPACE),
        "totalSpent": l.total_spent(LOCAL_WORKSPACE),
        "entries": l.entries().len(),
        "note": "Credits are utility tokens for metering agent work; they are never sold.",
    }))
}

fn exec(
    conn: &Connection,
    key: &str,
    actor: Actor,
    memo: Option<&str>,
    cmd: Command,
) -> AppResult<CommandResult> {
    let mut svc = open(conn)?;
    let mut meta = Meta::new(key, actor);
    if let Some(m) = memo {
        meta = meta.memo(m);
    }
    svc.execute(meta, cmd).map_err(Into::into)
}

fn insufficient(available: Credits, required: Credits) -> AppError {
    AppError::new(
        "insufficient_credits",
        format!("insufficient credits: {available} available, {required} required"),
    )
    .with_data(json!({"available": available, "required": required}))
}

/// Hold `amount` credits of `agent`'s budget.
pub fn reserve(
    conn: &Connection,
    agent: &str,
    key: &str,
    amount: Credits,
    task_type: Option<&str>,
    ttl_ms: Option<i64>,
    memo: Option<&str>,
) -> AppResult<Value> {
    check_agent(agent)?;
    // Replays of an accepted key must succeed even if the budget has since changed, so only
    // pre-check when the key is new; the ledger remains the authority either way.
    let r = exec(
        conn,
        key,
        agent_actor(agent),
        memo,
        Command::Reserve {
            workspace_id: LOCAL_WORKSPACE.into(),
            agent_id: agent.into(),
            amount,
            task_type: task_type.map(str::to_owned),
            ttl_ms,
        },
    );
    match r {
        Ok(r) => Ok(result_json(&r)),
        Err(e) if e.code == "insufficient_credits" => {
            let available = open(conn)?.ledger().agent_balance(LOCAL_WORKSPACE, agent);
            Err(insufficient(available, amount))
        }
        Err(e) => Err(e),
    }
}

/// Settle a reservation with the actual cost.
pub fn commit(
    conn: &Connection,
    agent: &str,
    key: &str,
    reservation_id: &str,
    actual: Credits,
    memo: Option<&str>,
) -> AppResult<Value> {
    let r = exec(
        conn,
        key,
        agent_actor(agent),
        memo,
        Command::Commit {
            reservation_id: reservation_id.into(),
            actual_amount: actual,
        },
    )?;
    Ok(result_json(&r))
}

/// Cancel a reservation.
pub fn release(
    conn: &Connection,
    agent: &str,
    key: &str,
    reservation_id: &str,
    memo: Option<&str>,
) -> AppResult<Value> {
    let r = exec(
        conn,
        key,
        agent_actor(agent),
        memo,
        Command::Release {
            reservation_id: reservation_id.into(),
        },
    )?;
    Ok(result_json(&r))
}

/// One-shot spend (reserve + commit, each idempotent under `<key>:reserve` / `<key>:commit`).
pub fn spend(
    conn: &Connection,
    agent: &str,
    key: &str,
    amount: Credits,
    task_type: Option<&str>,
    memo: Option<&str>,
) -> AppResult<Value> {
    let reserved = reserve(conn, agent, &format!("{key}:reserve"), amount, task_type, Some(CALL_TTL_MS), memo)?;
    let rid = reserved["reservationId"]
        .as_str()
        .ok_or_else(|| AppError::new("internal", "reservation id missing"))?
        .to_owned();
    let committed = commit(conn, agent, &format!("{key}:commit"), &rid, amount, memo)?;
    Ok(json!({
        "reservationId": rid,
        "spent": amount,
        "reserve": reserved,
        "commit": committed,
        "replayed": reserved["replayed"] == json!(true) && committed["replayed"] == json!(true),
    }))
}

/// Owner action: add credits to the pool.
pub fn grant(conn: &Connection, key: &str, amount: Credits, memo: Option<&str>) -> AppResult<Value> {
    let r = exec(
        conn,
        key,
        user_actor(),
        memo,
        Command::Grant {
            workspace_id: LOCAL_WORKSPACE.into(),
            amount,
        },
    )?;
    Ok(result_json(&r))
}

/// Owner action: pool to agent budget.
pub fn allocate(conn: &Connection, key: &str, agent: &str, amount: Credits, memo: Option<&str>) -> AppResult<Value> {
    check_agent(agent)?;
    let r = exec(
        conn,
        key,
        user_actor(),
        memo,
        Command::Allocate {
            workspace_id: LOCAL_WORKSPACE.into(),
            agent_id: agent.into(),
            amount,
        },
    )?;
    Ok(result_json(&r))
}

/// Owner action: agent budget back to the pool.
pub fn deallocate(conn: &Connection, key: &str, agent: &str, amount: Credits, memo: Option<&str>) -> AppResult<Value> {
    check_agent(agent)?;
    let r = exec(
        conn,
        key,
        user_actor(),
        memo,
        Command::Deallocate {
            workspace_id: LOCAL_WORKSPACE.into(),
            agent_id: agent.into(),
            amount,
        },
    )?;
    Ok(result_json(&r))
}

/// Newest-first ledger history, optionally for one agent.
pub fn history(conn: &Connection, agent: Option<&str>, limit: usize) -> AppResult<Value> {
    let svc = open(conn)?;
    let rows: Vec<Value> = svc
        .ledger()
        .entries()
        .iter()
        .rev()
        .filter(|e| agent.is_none() || e.agent_id.as_deref() == agent)
        .take(limit)
        .map(|e| entry_json(e, false))
        .collect();
    Ok(json!({"entries": rows}))
}

/// Re-verify the whole hash chain and report head and counts.
pub fn verify(conn: &Connection) -> AppResult<Value> {
    let svc = open(conn)?;
    svc.ledger().verify().map_err(nyx_core::Error::from)?;
    Ok(json!({"ok": true, "entries": svc.ledger().entries().len(), "headHash": svc.ledger().head_hash()}))
}

/// Meter one tool call: reserve, run, commit on success or release on failure.
pub fn metered<T>(
    conn: &Connection,
    agent: &str,
    tool: &str,
    cost: Credits,
    f: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let id = uuid::Uuid::new_v4().to_string();
    let key = format!("call:{id}");
    let reserved = reserve(conn, agent, &key, cost, Some(tool), Some(CALL_TTL_MS), None)?;
    let rid = reserved["reservationId"].as_str().unwrap_or_default().to_owned();
    match f() {
        Ok(v) => {
            commit(conn, agent, &format!("{key}:commit"), &rid, cost, None)?;
            Ok(v)
        }
        Err(e) => {
            // A failed release leaves the hold to expire by TTL; report the original error.
            let _ = release(conn, agent, &format!("{key}:release"), &rid, Some("operation failed"));
            Err(e)
        }
    }
}

/// True when the reservation is still open (used by tests and `nyx credits show`).
pub fn reservation_open(conn: &Connection, id: &str) -> AppResult<bool> {
    let svc = open(conn)?;
    Ok(svc
        .ledger()
        .reservation(id)
        .is_some_and(|r| r.status == ReservationStatus::Open))
}
