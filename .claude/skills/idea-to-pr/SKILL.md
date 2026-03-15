---
name: idea-to-pr
description: End-to-end workflow from a raw idea to a merged PR. Converts a description into a GitHub issue, triggers the Claude GitHub app for an implementation plan, waits for the plan, labels the issue, implements with parallel agents, monitors CI, and merges when green. Use when the user describes a feature or bug and wants it fully shipped.
disable-model-invocation: true
allowed-tools: Bash(gh *), Bash(git *), Bash(pnpm *), Bash(lsof *), Bash(kill *), Bash(sleep *), Bash(curl *), Bash(psql *), Bash(ls *), Bash(cp *), Bash(mkdir *), Read, Write, Edit, Glob, Grep
argument-hint: <description of the feature or bug>
---

# Idea to Merged PR

Take a raw idea from the user and ship it end-to-end: issue creation → implementation plan → parallel implementation → tests → PR → CI → merge.

## Phase 1: Create GitHub Issue

1. Take the user's description from `$ARGUMENTS` (or ask if not provided)
2. Use AI to expand the raw description into a professional GitHub issue with:
   - Clear title
   - Summary and motivation
   - Proposed behavior (numbered steps)
   - Technical considerations
   - Out of scope section
   - Acceptance criteria checklist
3. Create the issue:
   ```
   gh issue create --repo NoJuanNobody/nyx --label "enhancement" --title "<title>" --body "<body>"
   ```
4. Create any needed labels if they don't exist
5. Report the issue URL to the user

## Phase 2: Trigger Implementation Plan

1. Comment on the issue to trigger the Claude GitHub app:
   ```
   gh issue comment <number> --repo NoJuanNobody/nyx --body "@claude can you write an implementation plan?"
   ```
2. Poll for the implementation plan to complete:
   - Check `gh issue view <number> --json comments` every 30-45 seconds
   - The plan is done when the latest comment from `claude` has no unchecked task items (`- [ ]`) and has checked items (`- [x]`)
   - Maximum 10 minutes of polling
3. Once complete, add the `ready to code` label:
   ```
   gh issue edit <number> --repo NoJuanNobody/nyx --add-label "ready to code"
   ```

## Phase 3: Setup

1. Kill any old dev server processes on ports 5173, 3000, 3001
2. Clean up stale git worktrees: `git worktree prune`
3. Switch to `main` and pull latest
4. Fetch the full issue with the implementation plan:
   ```
   gh issue view <number> --json title,body,labels,comments
   ```
5. Read the implementation plan from the comments — use it to guide your work

## Phase 4: Investigate

1. Read the issue and implementation plan carefully
2. Use an Explore agent to search the codebase for all relevant files (frontend, backend, tests, routes, services, schema)
3. Read key files to understand current behavior, patterns, and conventions
4. Identify the implementation approach

## Phase 5: Plan parallel work

Decompose the work into 2-4 independent units. Typical splits:
- **Backend** changes (routes, services, middleware, schema)
- **Frontend** changes (components, pages, API client, routes, sidebar)
- **Tests** (unit tests, E2E tests, selectors, test fixtures/mocks)

Create a feature branch from main:
```
git checkout -b feat/issue-<number>-<short-description>
```

## Phase 6: Dispatch parallel agents in worktrees

For each unit, launch an Agent with `isolation: "worktree"` and `run_in_background: true`.

Each agent prompt must include:
- Exactly which files to create or modify
- The complete implementation (code snippets, not vague descriptions)
- Where to place new code relative to existing code
- Import changes needed
- A commit message to use
- Instruction to read files before editing and base off `main`

Launch all agents in a single message for maximum parallelism.

## Phase 7: Start dev server

While agents work, start `pnpm dev` in the background so it's ready for testing.

## Phase 8: Merge worktree branches

As agents complete:
1. Check their worktree branches for commits: `git -C .claude/worktrees/<name> log --oneline -2`
2. If an agent finished but didn't commit, commit for it: `git -C <worktree> add -A && git -C <worktree> commit -m "<message>"`
3. Merge each branch into the feature branch: `git merge <worktree-branch> --no-edit`
4. Resolve any merge conflicts

## Phase 9: Run tests iteratively

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

## Phase 10: Open PR

1. Clean up worktrees: `git worktree remove .claude/worktrees/<name> --force`
2. Push the branch: `git push -u origin <branch>`
3. Open PR with `gh pr create`:
   - Title referencing the issue
   - Body with summary bullets, test plan, and `Closes #<number>`

## Phase 11: Monitor CI and merge

1. Poll CI status every 60-120 seconds: `gh pr checks <pr-number>`
2. Required checks: Security, Build, Unit Tests, E2E Tests, Code Quality
3. Ignore non-blocking checks: Vercel preview deployments, claude-review
4. If any required check fails:
   - Fetch failure logs: `gh run view <run-id> --job <job-id> --log-failed`
   - Diagnose and fix the issue
   - Commit, push, and re-poll
   - Maximum 3 CI fix iterations
5. Once all required checks pass, merge:
   ```
   gh pr merge <pr-number> --squash --delete-branch
   ```
6. Confirm: `gh pr view <pr-number> --json state,mergedAt`
7. Switch back to main and pull: `git checkout main && git pull`
8. Report the merged PR URL

## Rules

- Always read files before modifying them
- Keep changes surgical — only modify what's necessary
- Do not skip or disable tests
- If a test failure is pre-existing/flaky and unrelated, note it but don't fix it
- When dispatching agents, include complete code — not placeholders
- For security audit fixes, use pnpm overrides rather than upgrading direct dependencies
- Surface clear status updates at each phase transition
- The implementation plan from the Claude GitHub app is advisory — use your own judgment when the codebase context suggests a different approach
