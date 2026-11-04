# Product version control (`nyx_core::vcs`)

Ticket: AI-70. Ported from `apps/api/src/services/{version,branch,snapshot,timeline,approval,change-proposal}.service.ts` and their routes. Built on `store/documents.rs`, `branches.rs`, `snapshots.rs`, `audit.rs`, `tickets.rs`.

Services are free functions over `&Connection` (a `&Transaction` works too). Multi-step operations use a SQLite savepoint, so they are atomic with or without an outer transaction. Time-sensitive approval functions have `_at(.., now)` twins for tests.

## Modules

| Module | TS source | Contents |
|---|---|---|
| `diff` | client-side diff of `versions.ts` / `branch.diff` | `diff_lines` (hunks with context, stats, line numbers), `diff_words`, `unified` text; uses the `similar` crate |
| `merge` | none (AI-60 gap) | `merge3(base, ours, theirs)`: diff3-style three-way line merge, `Conflict` structs, `render` with `<<<<<<<`/`=======`/`>>>>>>>` (optional `|||||||` base section), `resolve` with `Resolution::{Ours,Theirs,Base,Both,Custom}` |
| `version` | `version.service.ts`, `versions.ts` | list (newest first), create, get, diff (line and word), `restore_to_version` |
| `branch` | `branch.service.ts`, `branches.ts` | create/list/get/update, review transitions (`submit_for_review`, `approve`, `reject`, `reopen`), `diff`, `diff_against_head`, `plan_merge`, `merge`, `update_from_head` |
| `timeline` | `timeline.service.ts`, `timeline.ts` | `record`, `events`, and `assemble` (stored events + history derived from versions, branches, snapshots, proposals, deduped) |
| `snapshot` | `snapshot.service.ts`, `snapshots.ts` | create (multi-document, audit + timeline), get/list, `restore`, `diff_with_head` |
| `approval` | `approval.service.ts`, `approvals.ts` | `pending -> approved|rejected|expired` state machine, `check`/`is_approved` gate, `expire_overdue` sweep |
| `proposal` | `change-proposal.service.ts`, `change-proposals.ts` | `generate` (via `ChangeAnalyzer`), `propose` (content for a branch), `approve`, `reject`, `accept`/`apply_to_branch`, `push` (via `TicketSink`) |

Migration `0170_vcs.sql` (version 170) adds `timeline_events`, `approvals`, `change_proposals` (Drizzle tables of the same names; `change_proposals` gains `target_branch_id`, `base_content`, `proposed_content` and the `applied` status).

## Merge semantics

`base` = version the branch forked from, `ours` = document head, `theirs` = branch content.

- Head still at the fork version: **fast-forward** (branch content becomes the head).
- Head moved, edits do not overlap: **clean** three-way merge.
- Overlapping edits: `branch::merge` returns `MergeAttempt::Conflicted` with structured conflicts and marker text, and writes nothing (branch stays `approved`). Retry with one `Resolution` per conflict to land a `Resolved` merge.
- Granularity is whole lines; edits separated by an unchanged line merge cleanly (git behaviour).
- `branch::update_from_head` folds head changes into a branch and advances its fork point (so the later merge fast-forwards).

## Approval and proposal state machines

```text
approval:  pending -> approved | rejected | expired      (others terminal; acting on non-pending is a no-op)
proposal:  pending -> approved | rejected
           approved -> pushed (tickets) | applied (branch content) | rejected
branch:    unchanged from store/branches.rs; merge requires approved
```

Content proposals: `propose` records the branch content as the merge ancestor; `accept` approves and applies in one step using a three-way merge against the branch's *current* content, so later branch edits survive. Conflicts roll the approval back and return the conflicts.

## Differences from the TypeScript services (intentional)

- Unknown ids are `Error::NotFound` (TS returned `null`/undefined or threw a string).
- Snapshot restore and `restore_to_version` append a document version; TS snapshot restore overwrote the head with no history.
- Identical content never creates a duplicate version (repo behaviour; TS appended anyway).
- Branch approve follows the repo state machine (TS only refused merged branches); merge requires `approved` as in TS.
- Proposal transitions are enforced (TS allowed any status change).
- Timeline/audit writes are synchronous in the same savepoint (TS fired them with `setImmediate` and swallowed errors).

## Gaps and TODOs

- `generate` used the removed in-app AI service. `ChangeAnalyzer` is the seam; `HeuristicAnalyzer` (one ticket per version message) is the offline default. TODO(AI-75): LLM-backed analyzer behind `LlmProvider`.
- `push` created GitHub tickets through `ticket.service`. `TicketSink` is the seam (tests use a fake); TODO(AI-66): real implementation over `GitProvider`.
- Role checks (`requireRole` viewer/editor/developer) are HTTP-layer concerns and are not ported; the wiring wave (AI-74) decides authorization for MCP/CLI/Tauri.
- No approval-gate enforcement inside `branch::merge`; callers combine `approval::is_approved` with merge where policy requires it.
- Merge is line-based; there is no word-level merge or rename detection.
