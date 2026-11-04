//! Credit ledger: append-only, double-entry, hash-chained. Credits are agent-native utility
//! tokens, metered and spent by external agents via MCP/CLI; they are never sold.
//!
//! This module is a faithful port of `apps/api/src/services/credit-ledger.service.ts` and
//! section 9 of `docs/credits/utility-tokens-spec.md`. [`Ledger`] is a pure in-memory fold over
//! entries (no I/O). Persistence goes through [`LedgerStore`]; [`LedgerService`] glues the two.
//! The SQLite implementation lives in `store::credits`.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Signed integer credits. Command amounts are `> 0` (commit actual may be 0).
pub type Credits = i64;

/// Largest amount accepted; matches the TypeScript `Number.MAX_SAFE_INTEGER` for hash parity.
pub const MAX_AMOUNT: Credits = 9_007_199_254_740_991;

/// Global mint account. The only account allowed to be negative (`-total ever granted`).
pub const ISSUER_ACCOUNT: &str = "issuer";

/// Local-first single-user workspace id.
pub const LOCAL_WORKSPACE: &str = "local";
/// Default agent identity.
pub const LOCAL_AGENT: &str = "default";

/// Account holding the unallocated credits of a workspace.
#[must_use]
pub fn pool_account(ws: &str) -> String {
    format!("ws:{ws}:pool")
}
/// Spendable budget account of one agent.
#[must_use]
pub fn agent_account(ws: &str, agent: &str) -> String {
    format!("ws:{ws}:agent:{agent}")
}
/// Hold account of one reservation.
#[must_use]
pub fn hold_account(ws: &str, reservation_id: &str) -> String {
    format!("ws:{ws}:hold:{reservation_id}")
}
/// Account accumulating committed spend of a workspace.
#[must_use]
pub fn spent_account(ws: &str) -> String {
    format!("ws:{ws}:spent")
}

/// Kind of ledger entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum EntryKind {
    Grant,
    Allocate,
    Deallocate,
    Reserve,
    Commit,
    Release,
    Refund,
}

impl EntryKind {
    /// Lowercase wire/database name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Grant => "grant",
            Self::Allocate => "allocate",
            Self::Deallocate => "deallocate",
            Self::Reserve => "reserve",
            Self::Commit => "commit",
            Self::Release => "release",
            Self::Refund => "refund",
        }
    }

    /// Parse the lowercase name.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "grant" => Self::Grant,
            "allocate" => Self::Allocate,
            "deallocate" => Self::Deallocate,
            "reserve" => Self::Reserve,
            "commit" => Self::Commit,
            "release" => Self::Release,
            "refund" => Self::Refund,
            _ => return None,
        })
    }
}

/// Who performed a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum ActorKind {
    User,
    Agent,
    System,
}

impl ActorKind {
    /// Lowercase wire/database name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::System => "system",
        }
    }

    /// Parse the lowercase name.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "user" => Self::User,
            "agent" => Self::Agent,
            "system" => Self::System,
            _ => return None,
        })
    }
}

/// Actor attribution of an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Actor {
    /// Actor class.
    pub kind: ActorKind,
    /// Actor identifier.
    pub id: String,
}

impl Actor {
    /// Build an actor.
    #[must_use]
    pub fn new(kind: ActorKind, id: &str) -> Self {
        Self {
            kind,
            id: id.to_owned(),
        }
    }
    /// The default local desktop user.
    #[must_use]
    pub fn local_user() -> Self {
        Self::new(ActorKind::User, "local-user")
    }
}

/// Signed balance delta for one account. Postings of an entry sum to zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Posting {
    /// Account name.
    pub account: String,
    /// Signed, non-zero amount.
    pub amount: Credits,
}

impl Posting {
    fn new(account: String, amount: Credits) -> Self {
        Self { account, amount }
    }
}

/// One immutable ledger entry. Field names serialise as camelCase for cross-language hash parity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    /// 1-based gapless sequence.
    pub seq: u64,
    /// `le_` + seq zero-padded to 12 digits.
    pub id: String,
    /// Unix milliseconds.
    pub ts: i64,
    /// Entry kind.
    pub kind: EntryKind,
    /// Workspace scope.
    pub workspace_id: String,
    /// Agent scope, if any.
    pub agent_id: Option<String>,
    /// Caller-chosen idempotency key (unique across the ledger).
    pub idempotency_key: String,
    /// Hex sha256 of the canonical command payload.
    pub fingerprint: String,
    /// Reserve: own id; commit/release: the target reservation.
    pub reservation_id: Option<String>,
    /// Refund: the commit entry being refunded.
    pub ref_entry_id: Option<String>,
    /// Reserve only: expiry in unix ms.
    pub expires_at: Option<i64>,
    /// Task type metadata (reserve only).
    pub task_type: Option<String>,
    /// Free-form note.
    pub memo: String,
    /// Who did it.
    pub actor: Actor,
    /// Zero-sum postings.
    pub postings: Vec<Posting>,
    /// Previous entry hash (`""` for genesis).
    pub prev_hash: String,
    /// Hex sha256 of the canonical entry without this field.
    pub hash: String,
}

/// Machine-readable ledger failure code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[allow(missing_docs)]
pub enum LedgerErrorCode {
    InvalidAmount,
    InvalidInput,
    InsufficientCredits,
    IdempotencyConflict,
    ReservationNotFound,
    ReservationClosed,
    ReservationExpired,
    OverReserved,
    EntryNotFound,
    NotACommit,
    OverRefund,
    ChainBroken,
    InvariantViolation,
}

impl LedgerErrorCode {
    /// Spec name, e.g. `INSUFFICIENT_CREDITS`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidAmount => "INVALID_AMOUNT",
            Self::InvalidInput => "INVALID_INPUT",
            Self::InsufficientCredits => "INSUFFICIENT_CREDITS",
            Self::IdempotencyConflict => "IDEMPOTENCY_CONFLICT",
            Self::ReservationNotFound => "RESERVATION_NOT_FOUND",
            Self::ReservationClosed => "RESERVATION_CLOSED",
            Self::ReservationExpired => "RESERVATION_EXPIRED",
            Self::OverReserved => "OVER_RESERVED",
            Self::EntryNotFound => "ENTRY_NOT_FOUND",
            Self::NotACommit => "NOT_A_COMMIT",
            Self::OverRefund => "OVER_REFUND",
            Self::ChainBroken => "CHAIN_BROKEN",
            Self::InvariantViolation => "INVARIANT_VIOLATION",
        }
    }
}

/// A rejected ledger operation. A rejected command appends nothing.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct LedgerError {
    /// Failure code.
    pub code: LedgerErrorCode,
    /// Human-readable detail.
    pub message: String,
}

fn lerr(code: LedgerErrorCode, message: impl Into<String>) -> LedgerError {
    LedgerError {
        code,
        message: message.into(),
    }
}

/// Reservation lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(missing_docs)]
pub enum ReservationStatus {
    Open,
    Committed,
    Released,
}

impl fmt::Display for ReservationStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Open => "open",
            Self::Committed => "committed",
            Self::Released => "released",
        })
    }
}

/// Derived view of a reservation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    /// Reservation id (the reserve entry id).
    pub id: String,
    /// Workspace.
    pub workspace_id: String,
    /// Agent that holds it.
    pub agent_id: String,
    /// Credits held.
    pub reserved: Credits,
    /// Expiry (unix ms), if any.
    pub expires_at: Option<i64>,
    /// State.
    pub status: ReservationStatus,
    /// Credits committed (0 until committed).
    pub committed: Credits,
}

/// Derived view of a commit, for refund accounting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRecord {
    /// Commit entry id.
    pub entry_id: String,
    /// Workspace.
    pub workspace_id: String,
    /// Agent.
    pub agent_id: String,
    /// Credits committed.
    pub committed: Credits,
    /// Credits refunded so far.
    pub refunded: Credits,
}

/// Fields shared by every command.
#[derive(Debug, Clone)]
pub struct Meta {
    /// Idempotency key (required, non-empty).
    pub idempotency_key: String,
    /// Actor.
    pub actor: Actor,
    /// Free-form note.
    pub memo: String,
    /// Override the ledger clock (unix ms).
    pub at: Option<i64>,
}

impl Meta {
    /// Build metadata with an empty memo and the ledger clock.
    #[must_use]
    pub fn new(idempotency_key: &str, actor: Actor) -> Self {
        Self {
            idempotency_key: idempotency_key.to_owned(),
            actor,
            memo: String::new(),
            at: None,
        }
    }
    /// Set the memo.
    #[must_use]
    pub fn memo(mut self, memo: &str) -> Self {
        memo.clone_into(&mut self.memo);
        self
    }
    /// Pin the timestamp.
    #[must_use]
    pub fn at(mut self, at: i64) -> Self {
        self.at = Some(at);
        self
    }
}

/// A ledger command (the operations of spec section 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// issuer -> pool.
    Grant {
        /// Workspace.
        workspace_id: String,
        /// Amount (> 0).
        amount: Credits,
    },
    /// pool -> agent budget.
    Allocate {
        /// Workspace.
        workspace_id: String,
        /// Agent.
        agent_id: String,
        /// Amount (> 0).
        amount: Credits,
    },
    /// agent budget -> pool.
    Deallocate {
        /// Workspace.
        workspace_id: String,
        /// Agent.
        agent_id: String,
        /// Amount (> 0).
        amount: Credits,
    },
    /// agent budget -> hold.
    Reserve {
        /// Workspace.
        workspace_id: String,
        /// Agent.
        agent_id: String,
        /// Amount (> 0).
        amount: Credits,
        /// Optional task type.
        task_type: Option<String>,
        /// Optional time-to-live in ms (> 0).
        ttl_ms: Option<i64>,
    },
    /// hold -> spent, remainder back to the agent.
    Commit {
        /// Target reservation.
        reservation_id: String,
        /// Actual metered cost (0 <= actual <= reserved).
        actual_amount: Credits,
    },
    /// hold -> agent budget.
    Release {
        /// Target reservation.
        reservation_id: String,
    },
    /// spent -> agent budget.
    Refund {
        /// Target commit entry.
        commit_entry_id: String,
        /// Amount (> 0).
        amount: Credits,
    },
}

/// Result of executing a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    /// The (new or replayed) entry.
    pub entry: LedgerEntry,
    /// True when the idempotency key matched an earlier identical command.
    pub replayed: bool,
}

// ── canonical JSON + hashing ─────────────────────────

/// Canonical JSON: object keys sorted bytewise, no whitespace, arrays keep order.
#[must_use]
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(canonical).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), canonical(&o[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Hash of an entry: sha256 over the canonical JSON of the entry without `hash`.
#[must_use]
pub fn entry_hash(e: &LedgerEntry) -> String {
    let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("hash");
    }
    sha256_hex(&canonical(&v))
}

fn assert_amount(n: Credits, what: &str) -> std::result::Result<(), LedgerError> {
    if n <= 0 || n > MAX_AMOUNT {
        return Err(lerr(
            LedgerErrorCode::InvalidAmount,
            format!("{what} must be a positive integer"),
        ));
    }
    Ok(())
}

fn assert_id(v: &str, what: &str) -> std::result::Result<(), LedgerError> {
    if v.is_empty() || v.chars().any(|c| c == ':' || c.is_whitespace()) {
        return Err(lerr(
            LedgerErrorCode::InvalidInput,
            format!("{what} must be non-empty without ':' or whitespace"),
        ));
    }
    Ok(())
}

fn system_clock() -> i64 {
    crate::model::now_ms()
}

type LResult<T> = std::result::Result<T, LedgerError>;

/// Scope computed while validating a command.
struct Scope {
    ws: String,
    agent: Option<String>,
    task_type: Option<String>,
}

/// Output of a command builder.
struct Built {
    reservation_id: Option<String>,
    ref_entry_id: Option<String>,
    expires_at: Option<i64>,
    postings: Vec<Posting>,
}

/// Pure in-memory ledger. Rebuild with [`Ledger::from_entries`], which re-validates every invariant.
pub struct Ledger {
    entries: Vec<LedgerEntry>,
    balances: HashMap<String, Credits>,
    keys: HashMap<String, usize>,
    reservations: HashMap<String, Reservation>,
    commits: HashMap<String, CommitRecord>,
    clock: Box<dyn Fn() -> i64 + Send>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Ledger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Ledger")
            .field("entries", &self.entries.len())
            .finish_non_exhaustive()
    }
}

impl Ledger {
    /// Empty ledger using the system clock.
    #[must_use]
    pub fn new() -> Self {
        Self::with_clock(system_clock)
    }

    /// Empty ledger with an injected clock (tests).
    #[must_use]
    pub fn with_clock(clock: impl Fn() -> i64 + Send + 'static) -> Self {
        Self {
            entries: Vec::new(),
            balances: HashMap::new(),
            keys: HashMap::new(),
            reservations: HashMap::new(),
            commits: HashMap::new(),
            clock: Box::new(clock),
        }
    }

    /// Rebuild state from persisted entries, re-validating every invariant.
    pub fn from_entries(entries: &[LedgerEntry]) -> LResult<Self> {
        let mut l = Self::new();
        for e in entries {
            l.apply(e.clone())?;
        }
        Ok(l)
    }

    /// All entries in order.
    #[must_use]
    pub fn entries(&self) -> &[LedgerEntry] {
        &self.entries
    }

    /// Hash of the newest entry (`""` when empty).
    #[must_use]
    pub fn head_hash(&self) -> &str {
        self.entries.last().map_or("", |e| e.hash.as_str())
    }

    /// Balance of any account (0 if unseen).
    #[must_use]
    pub fn balance(&self, account: &str) -> Credits {
        self.balances.get(account).copied().unwrap_or(0)
    }

    /// Spendable credits of an agent (excludes open holds).
    #[must_use]
    pub fn agent_balance(&self, ws: &str, agent: &str) -> Credits {
        self.balance(&agent_account(ws, agent))
    }

    /// Unallocated credits of a workspace.
    #[must_use]
    pub fn pool_balance(&self, ws: &str) -> Credits {
        self.balance(&pool_account(ws))
    }

    /// Credits held by open reservations of an agent.
    #[must_use]
    pub fn agent_held(&self, ws: &str, agent: &str) -> Credits {
        self.reservations
            .values()
            .filter(|r| {
                r.status == ReservationStatus::Open && r.workspace_id == ws && r.agent_id == agent
            })
            .map(|r| r.reserved)
            .sum()
    }

    /// Total committed spend of a workspace (net of refunds).
    #[must_use]
    pub fn total_spent(&self, ws: &str) -> Credits {
        self.balance(&spent_account(ws))
    }

    /// Reservation by id.
    #[must_use]
    pub fn reservation(&self, id: &str) -> Option<&Reservation> {
        self.reservations.get(id)
    }

    /// Commit record by entry id.
    #[must_use]
    pub fn commit_record(&self, entry_id: &str) -> Option<&CommitRecord> {
        self.commits.get(entry_id)
    }

    /// Verify hash chain, gapless seq, zero-sum postings and non-negative balances.
    pub fn verify(&self) -> LResult<()> {
        Self::from_entries(&self.entries).map(|_| ())
    }

    /// Release every open reservation whose TTL has passed (idempotent via `expire:<id>` keys).
    pub fn expire_due(&mut self, now: i64) -> LResult<Vec<LedgerEntry>> {
        let mut due: Vec<String> = self
            .reservations
            .values()
            .filter(|r| {
                r.status == ReservationStatus::Open && r.expires_at.is_some_and(|t| t <= now)
            })
            .map(|r| r.id.clone())
            .collect();
        due.sort();
        let mut out = Vec::new();
        for id in due {
            let meta = Meta::new(
                &format!("expire:{id}"),
                Actor::new(ActorKind::System, "expiry"),
            )
            .memo("reservation expired")
            .at(now);
            out.push(
                self.execute(meta, Command::Release { reservation_id: id })?
                    .entry,
            );
        }
        Ok(out)
    }

    // ── commands ────────────────────────────────────

    /// Validate and apply a command. Nothing changes if it is rejected.
    pub fn execute(&mut self, meta: Meta, cmd: Command) -> LResult<CommandResult> {
        if meta.idempotency_key.is_empty() {
            return Err(lerr(
                LedgerErrorCode::InvalidInput,
                "idempotencyKey is required",
            ));
        }
        let (kind, payload) = Self::validate_and_payload(&cmd)?;
        let mut fp = payload;
        fp.insert("kind".into(), json!(kind.as_str()));
        let fingerprint = sha256_hex(&canonical(&Value::Object(fp)));

        if let Some(&i) = self.keys.get(&meta.idempotency_key) {
            let prior = &self.entries[i];
            if prior.fingerprint != fingerprint {
                return Err(lerr(
                    LedgerErrorCode::IdempotencyConflict,
                    format!(
                        "idempotency key {} was used with a different request",
                        meta.idempotency_key
                    ),
                ));
            }
            return Ok(CommandResult {
                entry: prior.clone(),
                replayed: true,
            });
        }

        let now = meta.at.unwrap_or_else(|| (self.clock)());
        let scope = self.scope_for(&cmd, now)?;
        let seq = self.entries.len() as u64 + 1;
        let id = format!("le_{seq:012}");
        let built = self.build(&cmd, &id, now)?;

        let mut entry = LedgerEntry {
            seq,
            id,
            ts: now,
            kind,
            workspace_id: scope.ws,
            agent_id: scope.agent,
            idempotency_key: meta.idempotency_key,
            fingerprint,
            reservation_id: built.reservation_id,
            ref_entry_id: built.ref_entry_id,
            expires_at: built.expires_at,
            task_type: scope.task_type,
            memo: meta.memo,
            actor: meta.actor,
            postings: built.postings,
            prev_hash: self.head_hash().to_owned(),
            hash: String::new(),
        };
        entry.hash = entry_hash(&entry);
        self.apply(entry.clone())?;
        Ok(CommandResult {
            entry,
            replayed: false,
        })
    }

    /// Input validation plus the fingerprint payload (without `kind`).
    fn validate_and_payload(cmd: &Command) -> LResult<(EntryKind, Map<String, Value>)> {
        let mut p = Map::new();
        let kind = match cmd {
            Command::Grant {
                workspace_id,
                amount,
            } => {
                assert_id(workspace_id, "workspaceId")?;
                assert_amount(*amount, "amount")?;
                p.insert("workspaceId".into(), json!(workspace_id));
                p.insert("amount".into(), json!(amount));
                EntryKind::Grant
            }
            Command::Allocate {
                workspace_id,
                agent_id,
                amount,
            }
            | Command::Deallocate {
                workspace_id,
                agent_id,
                amount,
            } => {
                assert_id(workspace_id, "workspaceId")?;
                assert_id(agent_id, "agentId")?;
                assert_amount(*amount, "amount")?;
                p.insert("workspaceId".into(), json!(workspace_id));
                p.insert("agentId".into(), json!(agent_id));
                p.insert("amount".into(), json!(amount));
                if matches!(cmd, Command::Allocate { .. }) {
                    EntryKind::Allocate
                } else {
                    EntryKind::Deallocate
                }
            }
            Command::Reserve {
                workspace_id,
                agent_id,
                amount,
                task_type,
                ttl_ms,
            } => {
                assert_id(workspace_id, "workspaceId")?;
                assert_id(agent_id, "agentId")?;
                assert_amount(*amount, "amount")?;
                if let Some(t) = ttl_ms {
                    assert_amount(*t, "ttlMs")?;
                }
                p.insert("workspaceId".into(), json!(workspace_id));
                p.insert("agentId".into(), json!(agent_id));
                p.insert("amount".into(), json!(amount));
                if let Some(t) = task_type {
                    p.insert("taskType".into(), json!(t));
                }
                if let Some(t) = ttl_ms {
                    p.insert("ttlMs".into(), json!(t));
                }
                EntryKind::Reserve
            }
            Command::Commit {
                reservation_id,
                actual_amount,
            } => {
                if *actual_amount < 0 || *actual_amount > MAX_AMOUNT {
                    return Err(lerr(
                        LedgerErrorCode::InvalidAmount,
                        "actualAmount must be a non-negative integer",
                    ));
                }
                p.insert("reservationId".into(), json!(reservation_id));
                p.insert("actualAmount".into(), json!(actual_amount));
                EntryKind::Commit
            }
            Command::Release { reservation_id } => {
                p.insert("reservationId".into(), json!(reservation_id));
                EntryKind::Release
            }
            Command::Refund {
                commit_entry_id,
                amount,
            } => {
                assert_amount(*amount, "amount")?;
                p.insert("commitEntryId".into(), json!(commit_entry_id));
                p.insert("amount".into(), json!(amount));
                EntryKind::Refund
            }
        };
        Ok((kind, p))
    }

    fn open_reservation(&self, id: &str, now: Option<i64>) -> LResult<&Reservation> {
        let r = self.reservations.get(id).ok_or_else(|| {
            lerr(
                LedgerErrorCode::ReservationNotFound,
                format!("reservation {id} not found"),
            )
        })?;
        if r.status != ReservationStatus::Open {
            return Err(lerr(
                LedgerErrorCode::ReservationClosed,
                format!("reservation {id} is already {}", r.status),
            ));
        }
        if let (Some(now), Some(exp)) = (now, r.expires_at) {
            if exp <= now {
                return Err(lerr(
                    LedgerErrorCode::ReservationExpired,
                    format!("reservation {id} expired"),
                ));
            }
        }
        Ok(r)
    }

    fn scope_for(&self, cmd: &Command, now: i64) -> LResult<Scope> {
        Ok(match cmd {
            Command::Grant { workspace_id, .. } => Scope {
                ws: workspace_id.clone(),
                agent: None,
                task_type: None,
            },
            Command::Allocate {
                workspace_id,
                agent_id,
                ..
            }
            | Command::Deallocate {
                workspace_id,
                agent_id,
                ..
            } => Scope {
                ws: workspace_id.clone(),
                agent: Some(agent_id.clone()),
                task_type: None,
            },
            Command::Reserve {
                workspace_id,
                agent_id,
                task_type,
                ..
            } => Scope {
                ws: workspace_id.clone(),
                agent: Some(agent_id.clone()),
                task_type: task_type.clone(),
            },
            Command::Commit {
                reservation_id,
                actual_amount,
            } => {
                let r = self.open_reservation(reservation_id, Some(now))?;
                if *actual_amount > r.reserved {
                    return Err(lerr(
                        LedgerErrorCode::OverReserved,
                        format!(
                            "actual {actual_amount} exceeds reserved {}; reserve more up front",
                            r.reserved
                        ),
                    ));
                }
                Scope {
                    ws: r.workspace_id.clone(),
                    agent: Some(r.agent_id.clone()),
                    task_type: None,
                }
            }
            Command::Release { reservation_id } => {
                let r = self.open_reservation(reservation_id, None)?;
                Scope {
                    ws: r.workspace_id.clone(),
                    agent: Some(r.agent_id.clone()),
                    task_type: None,
                }
            }
            Command::Refund {
                commit_entry_id,
                amount,
            } => {
                let rec = self.commits.get(commit_entry_id).ok_or_else(|| {
                    let known = self.entries.iter().any(|e| &e.id == commit_entry_id);
                    lerr(
                        if known {
                            LedgerErrorCode::NotACommit
                        } else {
                            LedgerErrorCode::EntryNotFound
                        },
                        format!("entry {commit_entry_id} is not a refundable commit"),
                    )
                })?;
                if rec.refunded + amount > rec.committed {
                    return Err(lerr(
                        LedgerErrorCode::OverRefund,
                        format!(
                            "refund {amount} exceeds remaining {}",
                            rec.committed - rec.refunded
                        ),
                    ));
                }
                Scope {
                    ws: rec.workspace_id.clone(),
                    agent: Some(rec.agent_id.clone()),
                    task_type: None,
                }
            }
        })
    }

    fn build(&self, cmd: &Command, id: &str, now: i64) -> LResult<Built> {
        let mut b = Built {
            reservation_id: None,
            ref_entry_id: None,
            expires_at: None,
            postings: Vec::new(),
        };
        match cmd {
            Command::Grant {
                workspace_id: w,
                amount: n,
            } => {
                b.postings = vec![
                    Posting::new(ISSUER_ACCOUNT.into(), -n),
                    Posting::new(pool_account(w), *n),
                ];
            }
            Command::Allocate {
                workspace_id: w,
                agent_id: a,
                amount: n,
            } => {
                b.postings = vec![
                    Posting::new(pool_account(w), -n),
                    Posting::new(agent_account(w, a), *n),
                ];
            }
            Command::Deallocate {
                workspace_id: w,
                agent_id: a,
                amount: n,
            } => {
                b.postings = vec![
                    Posting::new(agent_account(w, a), -n),
                    Posting::new(pool_account(w), *n),
                ];
            }
            Command::Reserve {
                workspace_id: w,
                agent_id: a,
                amount: n,
                ttl_ms,
                ..
            } => {
                b.reservation_id = Some(id.to_owned());
                b.expires_at = match ttl_ms {
                    Some(t) => Some(now.checked_add(*t).ok_or_else(|| {
                        lerr(LedgerErrorCode::InvalidAmount, "ttlMs overflows the clock")
                    })?),
                    None => None,
                };
                b.postings = vec![
                    Posting::new(agent_account(w, a), -n),
                    Posting::new(hold_account(w, id), *n),
                ];
            }
            Command::Commit {
                reservation_id,
                actual_amount,
            } => {
                let r = self.open_reservation(reservation_id, Some(now))?;
                let (w, a) = (&r.workspace_id, &r.agent_id);
                b.reservation_id = Some(r.id.clone());
                b.postings
                    .push(Posting::new(hold_account(w, &r.id), -r.reserved));
                if *actual_amount > 0 {
                    b.postings
                        .push(Posting::new(spent_account(w), *actual_amount));
                }
                if r.reserved > *actual_amount {
                    b.postings.push(Posting::new(
                        agent_account(w, a),
                        r.reserved - actual_amount,
                    ));
                }
            }
            Command::Release { reservation_id } => {
                let r = self.open_reservation(reservation_id, None)?;
                b.reservation_id = Some(r.id.clone());
                b.postings = vec![
                    Posting::new(hold_account(&r.workspace_id, &r.id), -r.reserved),
                    Posting::new(agent_account(&r.workspace_id, &r.agent_id), r.reserved),
                ];
            }
            Command::Refund {
                commit_entry_id,
                amount,
            } => {
                let rec = self.commits.get(commit_entry_id).ok_or_else(|| {
                    lerr(
                        LedgerErrorCode::EntryNotFound,
                        format!("entry {commit_entry_id} not found"),
                    )
                })?;
                b.ref_entry_id = Some(rec.entry_id.clone());
                b.postings = vec![
                    Posting::new(spent_account(&rec.workspace_id), -amount),
                    Posting::new(agent_account(&rec.workspace_id, &rec.agent_id), *amount),
                ];
            }
        }
        Ok(b)
    }

    /// Validate then fold one entry into state. Used for new entries and for loading.
    fn apply(&mut self, e: LedgerEntry) -> LResult<()> {
        let bad = |c, m: String| Err(lerr(c, m));
        if e.seq != self.entries.len() as u64 + 1 {
            return bad(
                LedgerErrorCode::ChainBroken,
                format!("expected seq {}, got {}", self.entries.len() + 1, e.seq),
            );
        }
        if e.prev_hash != self.head_hash() {
            return bad(
                LedgerErrorCode::ChainBroken,
                format!("prevHash mismatch at seq {}", e.seq),
            );
        }
        if entry_hash(&e) != e.hash {
            return bad(
                LedgerErrorCode::ChainBroken,
                format!("hash mismatch at seq {}", e.seq),
            );
        }
        if self.keys.contains_key(&e.idempotency_key) {
            return bad(
                LedgerErrorCode::InvariantViolation,
                format!("duplicate idempotency key at seq {}", e.seq),
            );
        }
        if e.postings.len() < 2 || e.postings.iter().any(|p| p.amount == 0) {
            return bad(
                LedgerErrorCode::InvariantViolation,
                format!("malformed postings at seq {}", e.seq),
            );
        }
        let mut sum: i128 = 0;
        for p in &e.postings {
            sum += i128::from(p.amount);
        }
        if sum != 0 {
            return bad(
                LedgerErrorCode::InvariantViolation,
                format!("postings do not sum to zero at seq {}", e.seq),
            );
        }
        // Invariant 9: no entry touches another workspace's accounts.
        let prefix = format!("ws:{}:", e.workspace_id);
        if e.postings
            .iter()
            .any(|p| p.account != ISSUER_ACCOUNT && !p.account.starts_with(&prefix))
        {
            return bad(
                LedgerErrorCode::InvariantViolation,
                format!("cross-workspace posting at seq {}", e.seq),
            );
        }
        if e.kind != EntryKind::Grant && e.postings.iter().any(|p| p.account == ISSUER_ACCOUNT) {
            return bad(
                LedgerErrorCode::InvariantViolation,
                format!("issuer touched by non-grant at seq {}", e.seq),
            );
        }

        let mut delta: Vec<(String, i128)> = Vec::new();
        for p in &e.postings {
            if let Some(d) = delta.iter_mut().find(|(a, _)| a == &p.account) {
                d.1 += i128::from(p.amount);
            } else {
                delta.push((p.account.clone(), i128::from(p.amount)));
            }
        }
        for (acct, d) in &delta {
            let have = i128::from(self.balance(acct));
            if acct != ISSUER_ACCOUNT && have + d < 0 {
                return bad(
                    LedgerErrorCode::InsufficientCredits,
                    format!("{acct} has {have}, needs {} (seq {})", -d, e.seq),
                );
            }
            if i64::try_from(have + d).is_err() {
                return bad(
                    LedgerErrorCode::InvariantViolation,
                    format!("balance overflow at seq {}", e.seq),
                );
            }
        }

        self.fold_kind(&e)?;

        for (acct, d) in delta {
            let nb = i64::try_from(i128::from(self.balance(&acct)) + d).unwrap_or(0);
            self.balances.insert(acct, nb);
        }
        self.keys
            .insert(e.idempotency_key.clone(), self.entries.len());
        self.entries.push(e);
        Ok(())
    }

    /// Kind-specific state. Validates fully before mutating.
    fn fold_kind(&mut self, e: &LedgerEntry) -> LResult<()> {
        match e.kind {
            EntryKind::Reserve => {
                let hold = e
                    .postings
                    .iter()
                    .find(|p| p.amount > 0)
                    .map_or(0, |p| p.amount);
                let agent = e.agent_id.clone().ok_or_else(|| {
                    lerr(
                        LedgerErrorCode::InvariantViolation,
                        format!("reserve without agent at seq {}", e.seq),
                    )
                })?;
                self.reservations.insert(
                    e.id.clone(),
                    Reservation {
                        id: e.id.clone(),
                        workspace_id: e.workspace_id.clone(),
                        agent_id: agent,
                        reserved: hold,
                        expires_at: e.expires_at,
                        status: ReservationStatus::Open,
                        committed: 0,
                    },
                );
            }
            EntryKind::Commit => {
                let rid = e.reservation_id.clone().unwrap_or_default();
                let (ws, agent, reserved) = {
                    let r = self.open_reservation(&rid, None)?;
                    (r.workspace_id.clone(), r.agent_id.clone(), r.reserved)
                };
                let spent = e
                    .postings
                    .iter()
                    .find(|p| p.account == spent_account(&ws))
                    .map_or(0, |p| p.amount);
                if spent > reserved {
                    return Err(lerr(
                        LedgerErrorCode::OverReserved,
                        format!("commit exceeds reservation at seq {}", e.seq),
                    ));
                }
                if let Some(r) = self.reservations.get_mut(&rid) {
                    r.status = ReservationStatus::Committed;
                    r.committed = spent;
                }
                self.commits.insert(
                    e.id.clone(),
                    CommitRecord {
                        entry_id: e.id.clone(),
                        workspace_id: ws,
                        agent_id: agent,
                        committed: spent,
                        refunded: 0,
                    },
                );
            }
            EntryKind::Release => {
                let rid = e.reservation_id.clone().unwrap_or_default();
                self.open_reservation(&rid, None)?;
                if let Some(r) = self.reservations.get_mut(&rid) {
                    r.status = ReservationStatus::Released;
                }
            }
            EntryKind::Refund => {
                let target = e.ref_entry_id.clone().unwrap_or_default();
                let amt = e
                    .postings
                    .iter()
                    .find(|p| p.amount > 0)
                    .map_or(0, |p| p.amount);
                let rec = self.commits.get_mut(&target).ok_or_else(|| {
                    lerr(
                        LedgerErrorCode::EntryNotFound,
                        format!("refund target missing at seq {}", e.seq),
                    )
                })?;
                if rec.refunded + amt > rec.committed {
                    return Err(lerr(
                        LedgerErrorCode::OverRefund,
                        format!("over-refund at seq {}", e.seq),
                    ));
                }
                rec.refunded += amt;
            }
            EntryKind::Grant | EntryKind::Allocate | EntryKind::Deallocate => {}
        }
        Ok(())
    }
}

// ── persistence seam ─────────────────────────────────

/// Persistence for ledger entries. Implementations must reject an `append` whose `seq`/`prev_hash`
/// does not extend the stored tail with [`Error::Conflict`] (this is how concurrent writers lose safely).
pub trait LedgerStore {
    /// All entries in `seq` order.
    fn load_all(&self) -> Result<Vec<LedgerEntry>>;
    /// Atomically persist one entry.
    fn append(&mut self, entry: &LedgerEntry) -> Result<()>;
}

/// In-memory store, for tests and ephemeral sessions.
#[derive(Debug, Default)]
pub struct MemoryLedgerStore {
    entries: Vec<LedgerEntry>,
}

impl LedgerStore for MemoryLedgerStore {
    fn load_all(&self) -> Result<Vec<LedgerEntry>> {
        Ok(self.entries.clone())
    }
    fn append(&mut self, entry: &LedgerEntry) -> Result<()> {
        let tail = self.entries.last();
        if entry.seq != tail.map_or(0, |t| t.seq) + 1
            || entry.prev_hash != tail.map_or("", |t| t.hash.as_str())
        {
            return Err(Error::Conflict("stale ledger tail".into()));
        }
        self.entries.push(entry.clone());
        Ok(())
    }
}

/// A [`Ledger`] bound to a [`LedgerStore`]. Every accepted command is persisted before it is
/// returned; on a lost race the ledger reloads from the store and retries once.
#[derive(Debug)]
pub struct LedgerService<S: LedgerStore> {
    store: S,
    ledger: Ledger,
}

impl<S: LedgerStore> LedgerService<S> {
    /// Load and fully verify the stored ledger.
    pub fn open(store: S) -> Result<Self> {
        let ledger = Ledger::from_entries(&store.load_all()?)?;
        Ok(Self { store, ledger })
    }

    /// Read-only view of the in-memory ledger.
    #[must_use]
    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    /// Borrow the store.
    #[must_use]
    pub fn store(&self) -> &S {
        &self.store
    }

    fn reload(&mut self) -> Result<()> {
        self.ledger = Ledger::from_entries(&self.store.load_all()?)?;
        Ok(())
    }

    /// Execute and persist a command (replays are not re-persisted).
    pub fn execute(&mut self, meta: Meta, cmd: Command) -> Result<CommandResult> {
        for attempt in 0..2 {
            let res = self.ledger.execute(meta.clone(), cmd.clone())?;
            if res.replayed {
                return Ok(res);
            }
            match self.store.append(&res.entry) {
                Ok(()) => return Ok(res),
                Err(Error::Conflict(_)) if attempt == 0 => self.reload()?,
                Err(e) => {
                    self.reload()?;
                    return Err(e);
                }
            }
        }
        Err(Error::Conflict("ledger changed concurrently".into()))
    }

    /// Release expired reservations and persist the releases.
    pub fn expire_due(&mut self, now: i64) -> Result<Vec<LedgerEntry>> {
        let due = self.ledger.expire_due(now);
        match due {
            Ok(entries) => {
                for e in &entries {
                    if let Err(err) = self.store.append(e) {
                        self.reload()?;
                        return Err(err);
                    }
                }
                Ok(entries)
            }
            Err(e) => Err(e.into()),
        }
    }
}
