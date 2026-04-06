---
name: watch-ci
description: Watch a PR's CI pipeline, auto-diagnose failures, fix code, and retrigger. Polls every 30s until all checks pass.
allowed-tools: Bash(gh *), Bash(git *), Bash(grep *), Bash(curl *), Bash(sleep *), Bash(cat *), Read, Edit, Write, Glob, Grep
argument-hint: [pr-number]
---

# Watch CI

Continuously monitor a PR's CI checks, auto-diagnose failures, fix them, push, and retrigger — looping until CI is green.

## Arguments

- PR number (required) — e.g. `318`

## Workflow

### Phase 1: Poll

Poll CI status every 30 seconds until all jobs complete:

```bash
gh pr checks <PR> --repo NoJuanNobody/nyx
```

While any job has `pending` status, keep polling. Report status changes to the user as they happen (e.g. "Unit Tests passed, Build passed, waiting on Smoke Tests...").

### Phase 2: Diagnose failures

When a job fails:

1. Get the job ID and logs:
   ```bash
   gh api repos/NoJuanNobody/nyx/actions/jobs/<job-id>/logs
   ```

2. Categorize the failure:
   - **TypeScript errors** — `error TS####`
   - **Test failures** — `FAIL`, `✘`, assertion errors
   - **Build failures** — compilation errors
   - **Server startup failures** — timeout, ECONNREFUSED
   - **Syntax errors** — unexpected token, parse errors

3. Identify the root cause file and line number.

### Phase 3: Fix

1. Switch to the PR branch:
   ```bash
   git checkout <branch> && git pull
   ```

2. Fix the issue:
   - Read the failing file
   - Apply the minimal fix
   - Verify locally if possible (`pnpm --filter <pkg> build` or `pnpm --filter <pkg> test`)

3. Commit and push:
   ```bash
   git add <files>
   git commit -m "fix(ci): <description>"
   git push
   ```

   The push auto-triggers a new CI run.

4. Switch back and return to Phase 1 (poll the new run).

### Phase 4: Success

When ALL checks pass (ignoring Vercel deployment status):
- Report success to the user
- Show the final check status
- Stop polling

## Rules

- **Be surgical** — only fix what CI reports as broken
- **Don't modify test assertions** unless they're clearly wrong
- **Don't skip or disable tests**
- **Ignore Vercel deployment failures** — those are environment issues
- **Report progress** — tell the user each time a job passes or fails
- **Max iterations** — stop after 10 fix attempts to avoid infinite loops
- **Always verify locally** before pushing when possible
- **Don't wait forever** — if a single poll cycle exceeds 20 minutes with no change, report and ask the user

## Status Reporting Format

On each poll, show a compact status line:

```
[CI #3] ✓ Security ✓ Quality ✓ Tests ✓ Build ⏳ Smoke ⏳ E2E
```

On failure:

```
[CI #3] ✗ Smoke Tests failed — diagnosing...
  → Error: TimeoutError at test-base.ts:973
  → Fix: increasing authenticatedPage timeout
  → Pushing fix and retriggering...
```

On success:

```
[CI #4] ✓ All 6 checks passed! PR #318 is green.
```
