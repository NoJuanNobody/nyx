---
name: implement-issue
description: Implement a GitHub issue using parallel worktree agents, merge branches, run tests iteratively, and open a PR.
disable-model-invocation: true
allowed-tools: Bash(gh *), Bash(git *), Bash(pnpm *), Bash(lsof *), Bash(kill *), Bash(sleep *), Bash(curl *), Bash(psql *), Bash(ls *), Bash(cp *), Bash(mkdir *), Read, Write, Edit, Glob, Grep
argument-hint: [issue-number]
---

# Implement GitHub Issue

Implement issue #$ARGUMENTS from the repo remote.

## Phase 1: Setup

1. Kill any old dev server processes on ports 5173, 3000, 3001
2. Clean up any stale git worktrees
3. Switch to `main` and pull latest
4. Fetch the issue:
   ```
   gh issue view $ARGUMENTS --json title,body,labels
   ```

## Phase 2: Investigate

1. Read the issue carefully — understand the bug or feature request
2. Search the codebase for all relevant files (frontend, backend, tests, routes, services)
3. Read those files to fully understand the current behavior
4. Identify the root cause or implementation plan

## Phase 3: Plan parallel work

Decompose the work into 2-4 independent units that can be implemented in parallel. Typical splits:
- **Backend** changes (routes, services, middleware)
- **Frontend** changes (components, pages, API client)
- **Tests** (unit tests, E2E tests)

Create a feature branch from main:
```
git checkout -b fix/issue-$ARGUMENTS-<short-description>
```

## Phase 4: Dispatch parallel agents in worktrees

For each unit, launch an Agent with `isolation: "worktree"` and `run_in_background: true`.

Each agent prompt must include:
- Exactly which files to modify
- What changes to make (be specific about the fix/feature)
- A commit message to use
- Instruction to base off `main`

Launch all agents in a single message for maximum parallelism.

## Phase 5: Start dev server

While agents work, start `pnpm dev` in the background so it's ready for testing.

## Phase 6: Merge worktree branches

As agents complete:
1. Check their worktree branches for commits: `git -C .claude/worktrees/<name> log --oneline -2`
2. Merge each branch: `git merge <worktree-branch> --no-edit`
3. If an agent's test file wasn't committed, copy it manually with `cp`
4. Resolve any merge conflicts

## Phase 7: Run tests iteratively

1. Run unit tests: `pnpm test`
2. If unit tests fail:
   - Read the failure output
   - Fix the issue (usually a small assertion mismatch)
   - Re-run until all pass
3. Run E2E tests: `pnpm exec playwright test`
4. If E2E tests fail:
   - Analyze failures (ignore pre-existing flaky tests)
   - Fix and re-run
5. Maximum 5 iterations per test suite

## Phase 8: Commit and open PR

1. Check if a PR already exists: `gh pr list --head <branch>`
2. If no PR, commit any remaining changes and push:
   ```
   git push -u origin <branch>
   ```
3. Open PR with:
   - Title referencing the issue
   - Body with summary bullets, test plan, and `Closes #$ARGUMENTS`
   - Use `gh pr create`

## Phase 9: Cleanup

1. Remove all agent worktrees: `git worktree remove .claude/worktrees/<name> --force`
2. Report the PR URL to the user

## Rules

- Always read files before modifying them
- Keep changes surgical — only modify what's necessary
- Do not skip or disable tests
- If a test failure is pre-existing/flaky and unrelated, note it but don't fix it
- Surface clear error messages to the user at each milestone
