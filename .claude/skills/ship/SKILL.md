---
name: ship
description: End-to-end implementation of a GitHub issue — implement with parallel agents, run tests, open PR, fix CI failures, and merge when green.
disable-model-invocation: true
allowed-tools: Bash(gh *), Bash(git *), Bash(pnpm *), Bash(lsof *), Bash(kill *), Bash(sleep *), Bash(curl *), Bash(psql *), Bash(ls *), Bash(cp *), Bash(mkdir *), Read, Write, Edit, Glob, Grep
argument-hint: [issue-number-or-url]
---

# Ship GitHub Issue

Fully implement, test, PR, fix CI, and merge issue #$ARGUMENTS.

## Phase 1: Setup

1. Kill any old dev server processes on ports 5173, 3000, 3001
2. Clean up stale git worktrees: `git worktree prune`
3. Switch to `main` and pull latest
4. Fetch the issue:
   ```
   gh issue view $ARGUMENTS --json title,body,labels
   ```

## Phase 2: Investigate

1. Read the issue carefully — understand the bug or feature request
2. Use an Explore agent to search the codebase for all relevant files (frontend, backend, tests, routes, services, schema)
3. Read key files to understand current behavior, patterns, and conventions
4. Identify the root cause or implementation plan

## Phase 3: Plan parallel work

Decompose the work into 2-4 independent units. Typical splits:
- **Backend** changes (routes, services, middleware, schema)
- **Frontend** changes (components, pages, API client, routes, sidebar)
- **Tests** (unit tests, E2E tests, selectors, test fixtures/mocks)

Create a feature branch from main:
```
git checkout -b feat/issue-$ARGUMENTS-<short-description>
```

## Phase 4: Dispatch parallel agents in worktrees

For each unit, launch an Agent with `isolation: "worktree"` and `run_in_background: true`.

Each agent prompt must include:
- Exactly which files to create or modify
- The complete implementation (code snippets, not vague descriptions)
- Where to place new code relative to existing code
- Import changes needed
- A commit message to use
- Instruction to read files before editing and base off `main`

Launch all agents in a single message for maximum parallelism.

## Phase 5: Start dev server

While agents work, start `pnpm dev` in the background so it's ready for testing.

## Phase 6: Merge worktree branches

As agents complete:
1. Check their worktree branches for commits: `git -C .claude/worktrees/<name> log --oneline -2`
2. If an agent finished its work but didn't commit, commit for it: `git -C <worktree> add -A && git -C <worktree> commit -m "<message>"`
3. Merge each branch into the feature branch: `git merge <worktree-branch> --no-edit`
4. Resolve any merge conflicts

## Phase 7: Run tests iteratively

1. Run unit tests: `pnpm test`
2. If unit tests fail:
   - Read the failure output
   - Fix the issue
   - Re-run until all pass
3. Run E2E tests for new test file first: `pnpm exec playwright test <new-spec-file>`
4. If E2E tests pass, run the full suite: `pnpm exec playwright test`
5. If tests fail:
   - Analyze failures (ignore pre-existing flaky tests)
   - Fix and re-run
6. Maximum 5 iterations per test suite

## Phase 8: Open PR

1. Clean up worktrees: `git worktree remove .claude/worktrees/<name> --force`
2. Push the branch: `git push -u origin <branch>`
3. Open PR with `gh pr create`:
   - Title referencing the issue
   - Body with summary bullets, test plan, and `Closes #$ARGUMENTS`

## Phase 9: Fix CI failures

1. Poll CI status: `gh pr checks <pr-number>`
2. If any required check fails (Security, Build, Unit Tests, E2E Tests, Code Quality):
   - Fetch the failure logs: `gh run view <run-id> --job <job-id> --log-failed`
   - Diagnose and fix the issue (e.g., dependency audit failures → add pnpm overrides)
   - Commit the fix, push, and re-poll
3. Maximum 3 CI fix iterations
4. Ignore non-blocking checks (Vercel preview deployments)

## Phase 10: Merge when green

1. Wait for all required checks to pass (poll with `gh pr checks` every 60-120 seconds)
2. Once all pass, merge: `gh pr merge <pr-number> --merge --delete-branch`
3. Confirm: `gh pr view <pr-number> --json state,mergedAt`
4. Switch back to main and pull: `git checkout main && git pull`
5. Report the merged PR URL

## Rules

- Always read files before modifying them
- Keep changes surgical — only modify what's necessary
- Do not skip or disable tests
- If a test failure is pre-existing/flaky and unrelated, note it but don't fix it
- When dispatching agents, include complete code — not placeholders
- For security audit fixes, use pnpm overrides rather than upgrading direct dependencies
- Surface clear status updates at each phase transition
