# Nyx credits as agent-native utility tokens

Status: design + reference ledger (AI-56). Reference implementation: `apps/api/src/services/credit-ledger.service.ts` (TypeScript, pure, tested). Rust port: AI-60, using section 9 as the contract. Wiring into the API/MCP/CLI: AI-57 and AI-58.

## 1. What a credit is

A credit is a local metering and budgeting unit. External agents (Claude Code, Cursor, scripts) that call Nyx through MCP or the CLI spend credits when they invoke compute-heavy operations (codebase scan, document generation, drift check, ticket generation). The human owner decides how many credits each agent may spend.

Hard statements (these are product rules, not implementation details):

1. Credits are **never sold**. There is no purchase flow, no checkout, no pack, no price.
2. Credits have **no fiat value** and no exchange rate. They are not money, not a security, not redeemable.
3. Credits are **non-transferable**. They cannot move between workspaces, users or installs. The only movements are inside one workspace: pool to agent, agent back to pool, and spend.
4. Credits have **no expiry and no plan grants**. There are no monthly allotments, tiers, free/starter/pro/team plans, or time-based decay. A reservation may have a short TTL; credits themselves never expire.
5. Credits are created only by an explicit **grant** made by the workspace owner (a config entry or a CLI/UI action). Nobody else, and no code path on a server, can mint them.
6. Credits are not billing for the in-app agent or chat. Those are removed from the product.

Unit: integer credits, indivisible (no decimals). Safe-integer range in TypeScript, `u64`/`i64` in Rust. Default cost table is a config file, not code; suggested starting values are the existing `CREDIT_COSTS` (scan 1, generation 3, drift 2, ticket 2).

## 2. Concepts

| Term | Meaning |
|---|---|
| Workspace | Scope of a budget. Desktop single-user: exactly one, `local`. Teams: one per team. |
| Pool | Unallocated credits of a workspace. |
| Agent | Named external caller identity (`claude-code`, `cursor`, ...), established by the MCP/CLI client name or an API token label. Local default agent: `default`. |
| Budget | An agent's allocated, spendable balance. |
| Reservation | A hold on part of an agent budget for one in-flight operation. |
| Issuer | Internal counter-account that records "total ever granted". It is the only account allowed to be negative. |

## 3. Operations

All operations require an **idempotency key** and an **actor** (`user`, `agent`, or `system`).

| Op | Effect | Who |
|---|---|---|
| `grant(ws, n)` | issuer -> pool | user/config only |
| `allocate(ws, agent, n)` | pool -> agent budget | user |
| `deallocate(ws, agent, n)` | agent budget -> pool | user |
| `reserve(ws, agent, n, ttl?, taskType)` | agent budget -> hold. Returns `reservationId` | agent |
| `commit(reservationId, actual)` | hold -> spent (`actual`), remainder -> agent budget. `actual <= reserved` | agent |
| `release(reservationId)` | hold -> agent budget (cancelled/failed op) | agent or system (TTL expiry) |
| `refund(commitEntryId, n)` | spent -> agent budget, total refunds of a commit <= its committed amount | user/system |

Reserve/commit flow for a metered tool call: `reserve(max_cost)` before work starts; do the work; `commit(actual_cost)` on success or `release` on failure/cancel. If the agent crashes, TTL expiry (`expireDue`, run on startup and before balance reads) releases the hold. A commit after expiry is rejected; the agent must reserve again.

Refunds are only for spend that already happened. There is no way to refund more than was committed, and refunds return credits to the same agent budget (never to the pool, never to a different agent).

## 4. Budgets: per-workspace and per-agent

- The owner grants credits to a workspace pool, then allocates slices to agents. An agent can never spend more than its own budget; the ledger rejects any reserve that would overdraft (`INSUFFICIENT_CREDITS`). Concurrent reservations count against the same budget because a hold is deducted immediately.
- Team workspaces: one pool per team, agents allocated from it. Per-member limits are expressed by giving each member's agent identity (`alice/claude-code`) its own allocation.
- Budgets are "hard": exhaustion returns a structured error to the agent (`insufficient_credits`, with `available` and `required`) so it can stop or ask the human; nothing silently continues.

## 5. Idempotency

- Every command carries a caller-chosen `idempotencyKey` (agents should use their tool-call id; the CLI derives one per invocation; config grants use `cfg:<file-hash>:<n>`).
- Same key + same payload: returns the original entry with `replayed = true`, no new entry. Safe to retry after timeouts.
- Same key + different payload: `IDEMPOTENCY_CONFLICT`. Keys are unique across the whole ledger and persist forever (append-only).
- The fingerprint covers the operation payload and ignores the timestamp, memo and actor.

## 6. Audit trail

- The ledger is append-only. Each entry stores: gapless `seq`, id, timestamp, kind, workspace, agent, idempotency key, fingerprint, reservation/ref ids, task type, memo, actor (kind + id), signed postings, `prevHash` and `hash` (SHA-256 over the canonical JSON of the entry without `hash`).
- The hash chain makes edits, deletions and reordering detectable (`Ledger.verify()`, `CHAIN_BROKEN`). It is tamper-evident, not tamper-proof: a local user with file access can rebuild the chain. That is acceptable because credits have no monetary value and the owner is the only authority.
- Corrections are new entries (refund, deallocate), never edits.
- `.agentpolicy/state/ledger.json` (the repo-level agent action log) stays a separate concept; a later ticket may append a pointer from it to credit entry ids.

## 7. Local-first defaults (desktop app)

- First launch creates workspace `local` and agent `default`, and the config file (`credits.toml` in the app data dir) grants an initial amount (suggested 1000) with key `cfg:init`. It is a convenience number, not an entitlement; the user can edit it.
- MCP/CLI clients that present a name get their own agent identity. Unknown agents start with a budget of 0 unless config sets `auto_allocate = N` (default for single-user: `auto_allocate` from pool on first sight, capped at a configured value). The first-run UI/CLI prompt says so explicitly.
- Everything works offline, in one SQLite file, with no network and no account. No telemetry of balances.
- Config changes are applied by the app as ledger commands (grants/allocations), so config edits are also audited; the config is never the balance.

## 8. SQLite design

Drizzle definition: `apps/api/src/db/credit-ledger.schema.ts` (`credit_entries`, `credit_postings`). Balances are derived (`SUM(amount) GROUP BY account`); an optional cache table or view may be added but is rebuildable.

Append-only enforcement, to be included in the migration that AI-57/AI-58 generate:

```sql
CREATE TRIGGER credit_entries_no_update BEFORE UPDATE ON credit_entries
BEGIN SELECT RAISE(ABORT, 'credit_entries is append-only'); END;
CREATE TRIGGER credit_entries_no_delete BEFORE DELETE ON credit_entries
BEGIN SELECT RAISE(ABORT, 'credit_entries is append-only'); END;
CREATE TRIGGER credit_postings_no_update BEFORE UPDATE ON credit_postings
BEGIN SELECT RAISE(ABORT, 'credit_postings is append-only'); END;
CREATE TRIGGER credit_postings_no_delete BEFORE DELETE ON credit_postings
BEGIN SELECT RAISE(ABORT, 'credit_postings is append-only'); END;
```

Write protocol: one `BEGIN IMMEDIATE` transaction per command: load the tail hash and affected account balances, run the pure `decide`/command logic, insert the entry and its postings, commit. `BEGIN IMMEDIATE` serialises writers, which is what makes seq gapless and overdraft checks race-free. The unique index on `idempotency_key` is the backstop for duplicate keys.

Legacy tables (`credit_balances`, `credit_transactions`, `team_credit_balances`, migration `0021_team_credit_balances.sql`) are superseded. Migration for existing data is not needed for the open-source desktop (fresh start); a hosted import, if ever wanted, would be a single `grant` per workspace with memo `legacy import`, which is still a grant by the owner, not a sale.

## 9. Rust-portable ledger spec

For the `nyx-core` crate (AI-60). The TypeScript module is the executable reference; port its tests as the conformance suite (serialise entries to JSON and check identical hashes).

### 9.1 Types

```rust
pub type Credits = i64;            // postings are signed; amounts in commands are > 0 (commit actual may be 0)
pub type AccountId = String;       // see 9.2

pub enum EntryKind { Grant, Allocate, Deallocate, Reserve, Commit, Release, Refund }
pub enum ActorKind { User, Agent, System }
pub struct Actor { pub kind: ActorKind, pub id: String }
pub struct Posting { pub account: AccountId, pub amount: Credits }   // amount != 0

pub struct LedgerEntry {
    pub seq: u64,                  // 1-based, gapless
    pub id: String,                // "le_" + seq zero-padded to 12 digits
    pub ts: i64,                   // unix ms
    pub kind: EntryKind,
    pub workspace_id: String,
    pub agent_id: Option<String>,
    pub idempotency_key: String,
    pub fingerprint: String,       // hex sha256 of canonical({kind, ...payload})
    pub reservation_id: Option<String>, // reserve: own id; commit/release: target
    pub ref_entry_id: Option<String>,   // refund: target commit
    pub expires_at: Option<i64>,   // reserve only
    pub task_type: Option<String>,
    pub memo: String,
    pub actor: Actor,
    pub postings: Vec<Posting>,
    pub prev_hash: String,         // "" for genesis
    pub hash: String,              // hex sha256 of canonical(entry without hash)
}

pub enum LedgerError {
    InvalidAmount, InvalidInput, InsufficientCredits, IdempotencyConflict,
    ReservationNotFound, ReservationClosed, ReservationExpired, OverReserved,
    EntryNotFound, NotACommit, OverRefund, ChainBroken, InvariantViolation,
}

pub struct CommandResult { pub entry: LedgerEntry, pub replayed: bool }
```

Define `trait LedgerStore { fn load_all(&self) -> Result<Vec<LedgerEntry>>; fn append(&mut self, e: &LedgerEntry) -> Result<()>; }` and keep `Ledger` a pure in-memory fold over entries (no I/O), as in TypeScript. The SQLite store implements the trait inside a `BEGIN IMMEDIATE` transaction.

### 9.2 Accounts

```
issuer                      (only account allowed negative)
ws:{W}:pool
ws:{W}:agent:{A}
ws:{W}:hold:{reservationId}
ws:{W}:spent
```
Ids W and A are non-empty and contain no `:` or whitespace.

### 9.3 Posting recipes

| Kind | Postings |
|---|---|
| grant n | issuer -n, pool +n |
| allocate n | pool -n, agent +n |
| deallocate n | agent -n, pool +n |
| reserve n | agent -n, hold(id) +n (id = this entry's id) |
| commit actual (reserved r) | hold -r, spent +actual (omit if 0), agent +(r-actual) (omit if 0) |
| release | hold -r, agent +r |
| refund n | spent -n, agent +n |

### 9.4 Invariants (enforced on every append AND on load)

1. `seq` equals previous seq + 1, starting at 1.
2. `prev_hash` equals the previous entry's `hash`; `hash` equals SHA-256 of the canonical JSON of the entry without `hash`.
3. Canonical JSON: object keys sorted lexicographically (byte order), no whitespace, `undefined`/absent fields omitted, `null` kept, integers without exponent or fraction, strings JSON-escaped. Arrays keep order (posting order is part of the hash).
4. Each entry has at least 2 postings, none zero, and they sum to exactly 0 (conservation).
5. Net change per account within an entry never takes a non-issuer account below 0 (no overdraft). The issuer balance always equals minus total granted.
6. Idempotency keys are unique; a repeated key with equal fingerprint returns the earlier entry (`replayed`), with a different fingerprint fails `IdempotencyConflict`. A rejected command appends nothing.
7. A reservation is `open` until exactly one commit or release closes it. Commit requires `open`, not expired (`expires_at > now` when set) and `actual <= reserved`. Release requires `open`.
8. Refund targets a commit entry; the sum of refunds per commit never exceeds its committed amount.
9. No kind moves credits between workspaces. (Every entry other than grant touches only accounts with its own `workspace_id`.)
10. `expire_due(now)` releases every open reservation with `expires_at <= now`, actor `system:expiry`, key `expire:{reservationId}` (idempotent).

### 9.5 Fingerprint payloads (for cross-language hash parity)

`fingerprint = sha256(canonical({kind, ...command fields minus idempotencyKey, actor, memo, at}))`. Fields per kind: grant `{workspaceId, amount}`; allocate/deallocate `{workspaceId, agentId, amount}`; reserve `{workspaceId, agentId, amount, taskType?, ttlMs?}`; commit `{reservationId, actualAmount}`; release `{reservationId}`; refund `{commitEntryId, amount}`. Use camelCase keys in the canonical form so Rust and TypeScript hashes match.

## 10. Out of scope here (later tickets)

- MCP/CLI tool wrappers and error shapes (AI-57/AI-58), SQLite store and migrations, UI for allocations.
- Cost table loading from config; metering of real work (agents report `actual`; Nyx computes cost for its own operations from the table).
- Removal of Stripe, plans and credit packs (separate tickets); this spec just makes them unnecessary.

## 11. Wiring map (existing files AI-57/AI-58 must change)

| File | Change |
|---|---|
| `apps/api/src/db/schema.ts` | Drop `creditBalances`, `creditTransactions`, `teamCreditBalances`, `creditTransactionTypeEnum` (`purchase` type); export the new ledger tables (or move them to SQLite schema). |
| `apps/api/src/services/credits.service.ts` | Replace body with a thin adapter over `Ledger` + store: `getBalance`, `checkCredits`, `reserve/commit/release`; delete `addCredits`, `addTeamCredits`, `MONTHLY_CREDITS`, stripe-id idempotency. |
| `apps/api/src/routes/credits.ts` | Remove `/purchase`, `/packs`, `CREDIT_PACKS`, Stripe import and `/deduct`; add grant/allocate/balance/history routes over the ledger. Registered in `apps/api/src/app.ts` (line ~272), keep prefix. |
| `apps/api/src/routes/mcp.ts` | Replace `checkCredits` + fire-and-forget `deductCredits` (lines ~99-123) with reserve before and commit/release after the tool call; use client name as agent id; return `insufficient_credits`. Errors must no longer be swallowed (`.catch(() => {})`). |
| `apps/api/src/routes/ai.ts` | Remove or convert the `deductCredits` call (~line 70) once in-app AI routes are deleted. |
| `apps/api/src/services/agent/loop.ts` | In-app agent is being removed; delete its `checkCredits/deductCredits/getAgentCost` use. |
| `apps/api/src/services/pipeline-access.service.ts` | Line ~51 `deductCredits` for pipeline activation: replace with reserve/commit or drop pipeline credit charging. |
| `apps/api/src/services/stripe.service.ts` | Remove `addCredits`/`addTeamCredits`/`MONTHLY_CREDITS` use (lines ~218, 302, 476) along with Stripe removal. |
| `apps/api/drizzle/0021_team_credit_balances.sql` | Superseded; add a new migration for the ledger tables and triggers instead of editing it. |
| `apps/api/drizzle.config.ts` | Point at the SQLite ledger schema when the desktop DB is introduced. |
| Tests | `src/__tests__/routes/credits.test.ts`, `src/routes/__tests__/mcp.test.ts`, `src/services/__tests__/{credits,team-credits,stripe,pipeline-access}.service.test.ts`, `src/services/agent/__tests__/loop.test.ts`. |
| Web (UI removal/relabel) | `apps/web/src/lib/api.ts`, `pages/Pricing.tsx`, `pages/Settings.tsx`, `components/Sidebar.tsx`, `components/UnifiedAIPanel.tsx`, `lib/agent-stream.ts`, `lib/lifecycles.ts` (credit/purchase/pricing references). |
