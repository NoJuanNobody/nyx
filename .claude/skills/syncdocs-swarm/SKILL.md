---
name: syncdocs-swarm
description: Plans and executes a parallel AI agent swarm using git worktrees to implement multiple tickets simultaneously, then merges all branches and opens a SyncDocs PR. Use this skill when the user wants to implement several tickets in parallel, run a multi-agent swarm, batch-implement issues, or coordinate parallel Claude Code agents across worktrees for a SyncDocs change. Also trigger when the user mentions "swarm", "parallel agents", "worktrees", "batch tickets", or "open a SyncDocs PR".
allowed-tools: Bash, Read, Write, Edit, TodoWrite, Grep
---

# SyncDocs Agent Swarm

Orchestrates a parallel agent swarm over git worktrees to implement a set of tickets, then merges all branches and opens a SyncDocs pull request.

## Overview

The workflow has four phases:

1. **Plan** — Analyze tickets, detect dependencies, group into parallel batches
2. **Swarm** — Spawn one background agent per ticket in an isolated git worktree
3. **Merge** — Sequentially merge each branch back to `main` (or target branch), resolving conflicts
4. **SyncDocs PR** — Open a PR in SyncDocs with a structured summary of all changes

Read [references/phases.md](references/phases.md) for detailed instructions for each phase.

---

## Quick Start

When the user invokes this skill, immediately do the following:

1. Ask for the ticket list if not already provided (see Inputs below)
2. Run the pre-flight script: `bash scripts/preflight.sh`
3. Show a swarm plan for approval before spawning any agents
4. Execute phase by phase, pausing for confirmation before Merge and PR steps

---

## Inputs

Collect these before planning:

- **Tickets**: Auto-fetched from GitHub using the `ready to code` label by default. If you want to target specific tickets instead, provide issue numbers or descriptions directly.
- **Target branch**: Default is `main`. Ask if unclear.
- **SyncDocs project slug**: The SyncDocs project identifier for the PR (e.g. `nyx/core`). Check `package.json` or ask the user.
- **PR title prefix**: Optional. Default: `[Swarm]`.
- **Test command**: Command to validate each worktree (e.g. `npm test`, `pnpm run test:unit`). Auto-detect from `package.json` if possible.

---

## Agent Instructions (per worktree)

Each spawned agent receives this playbook:

> You are implementing ticket `$TICKET_ID` in an isolated git worktree.
> Branch: `swarm/$TICKET_ID`
> 
> Steps:
> 1. Read the ticket description carefully
> 2. Implement the change — keep scope tight, no unrelated edits
> 3. Run `$TEST_COMMAND` — fix failures before finishing
> 4. Commit with message: `feat($TICKET_ID): <one-line summary>`
> 5. Do NOT merge or push — the orchestrator handles that
> 6. Write a brief implementation note to `swarm-notes/$TICKET_ID.md`:
>    - What changed
>    - Any assumptions made
>    - Any follow-up work flagged

Read [references/agent-playbook.md](references/agent-playbook.md) for the full agent instructions to inject.

---

## Conflict Strategy

When merging, follow the strategy in [references/merge-strategy.md](references/merge-strategy.md).

Default rules:
- Merge in dependency order (leaves first)
- On conflict: pause, summarize the conflict, ask user to resolve or choose a side
- Never silently drop code — always surface conflicts to the user

---

## SyncDocs PR Format

After all merges succeed, open a PR in SyncDocs using the format in [references/pr-template.md](references/pr-template.md).

The PR must include:
- List of tickets implemented, each linked to its branch
- Aggregate test results
- Any flagged follow-up items from `swarm-notes/`
