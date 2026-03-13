# Swarm Phases — Detailed Instructions

## Phase 1: Plan

### 1.1 Parse tickets

**Default: auto-fetch by label**

Unless the user has explicitly provided a ticket list, always start by fetching all open GitHub issues labelled `ready to code`:

```bash
gh issue list --label "ready to code" --state open --json number,title,body,labels,url
```

Present the results to the user before proceeding:

```
Found 4 issues labelled "ready to code":
  #42  Add rate limiting to /api/export
  #43  Fix session token expiry bug
  #44  Update user schema for roles
  #47  Improve error messages on auth failure

Proceed with all 4? (or tell me which to exclude)
```

Wait for confirmation. If the user excludes any, drop them from the plan.

**Fallback: manual input**

If the user has already provided tickets, or if the `gh` CLI is unavailable, accept any of:
- GitHub issue numbers (e.g. `#42`, `#43`)
- Plain-text descriptions (e.g. "Add rate limiting to /api/export")

For manually provided GitHub issues, fetch full details with:
```bash
gh issue view <number> --json number,title,body,labels,url
```

### 1.2 Detect dependencies

Look for:
- Explicit `Depends on #X` / `Blocks #Y` in ticket body
- Shared files: run `git grep -l` for key symbols/paths across tickets
- Sequential keywords: "after", "requires", "once X is done"

Build a simple dependency graph. Tickets with no dependencies form the first parallel batch.

### 1.3 Show the swarm plan

Present a table before spawning anything:

```
Batch 1 (parallel):  SD-101, SD-102, SD-104
Batch 2 (parallel):  SD-103  (depends on SD-101)
Sequential merge order: SD-101 → SD-102 → SD-104 → SD-103

Worktree branches:
  swarm/SD-101  →  ../worktrees/SD-101
  swarm/SD-102  →  ../worktrees/SD-102
  ...

Test command: pnpm run test:unit
Target branch: main
SyncDocs project: syncdocs/core
```

Wait for explicit user approval (yes/proceed/go) before continuing.

---

## Phase 2: Swarm

### 2.1 Set up worktrees

For each ticket in the current batch:

```bash
git worktree add ../worktrees/<TICKET_ID> -b swarm/<TICKET_ID>
```

### 2.2 Spawn agents

Use Claude Code's subagent/batch mechanism to spawn one agent per ticket in parallel.
Each agent gets:
- The ticket description
- The worktree path
- The test command
- The agent playbook from references/agent-playbook.md

### 2.3 Monitor progress

Poll for completion. Surface any agent that:
- Fails tests after 2 retries
- Exits with an error
- Produces an empty commit

Flag these to the user before proceeding to Merge.

---

## Phase 3: Merge

### 3.1 Validate before merging

For each completed worktree, verify:
```bash
cd ../worktrees/<TICKET_ID>
git log --oneline main..HEAD   # should have at least 1 commit
$TEST_COMMAND                  # should pass
```

### 3.2 Merge in order

For each branch in dependency-sorted order:
```bash
git checkout main  (or target branch)
git merge --no-ff swarm/<TICKET_ID> -m "merge(swarm): SD-XXX — <title>"
```

On conflict:
1. Run `git diff --name-only --diff-filter=U` to list conflicted files
2. Present the conflict to the user with context
3. Wait for resolution before continuing

### 3.3 Clean up worktrees

After all merges:
```bash
git worktree remove ../worktrees/<TICKET_ID>
git branch -d swarm/<TICKET_ID>
```

---

## Phase 4: SyncDocs PR

### 4.1 Gather notes

Collect all files from `swarm-notes/` and aggregate:
- What changed (per ticket)
- Assumptions made
- Follow-up items

### 4.2 Open the PR

Use the template in references/pr-template.md.
If the user has GitHub CLI available:
```bash
gh pr create --title "[Swarm] <summary>" --body "<rendered template>" --base main
```

If they use a SyncDocs-specific PR flow, follow the instructions the user provides for their SyncDocs API/CLI integration.
