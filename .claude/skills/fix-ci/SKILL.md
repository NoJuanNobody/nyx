---
name: fix-ci
description: Diagnose and fix failing CI checks on a GitHub PR — typecheck errors, lint errors, test failures, and merge conflicts.
disable-model-invocation: true
allowed-tools: Bash(gh *), Bash(git *), Bash(pnpm *), Bash(lsof *), Bash(kill *), Bash(sleep *), Read, Write, Edit, Glob, Grep
argument-hint: [pr-number]
---

# Fix CI

Diagnose and fix failing CI checks on PR #$ARGUMENTS from the repo remote.

## Phase 1: Diagnose

1. Check which CI checks failed:
   ```bash
   gh pr checks $ARGUMENTS
   ```

2. For each failed check (ignore Vercel deployment failures — those are environment issues), get the logs:
   ```bash
   gh run view <run-id> --job <job-id> --log-failed
   ```
   If `--log-failed` returns empty, try:
   ```bash
   gh run view <run-id> --job <job-id> --log | grep -i "error\|fail" | grep -v "warning"
   ```
   Or use the API:
   ```bash
   gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs | grep "error TS\|error\b" | head -20
   ```

3. Categorize the failures:
   - **TypeScript errors** — `error TS####` in the type check step
   - **Lint errors** — `error` (not `warning`) in the lint step
   - **Test failures** — `FAIL` in the unit test step
   - **Build failures** — errors in the build step
   - **Merge conflicts** — check PR merge status

## Phase 2: Fix

1. Identify the PR's branch:
   ```bash
   gh pr view $ARGUMENTS --json headRefName -q .headRefName
   ```

2. Switch to the branch:
   ```bash
   git stash 2>/dev/null
   git checkout <branch>
   git pull origin <branch>
   ```

3. Fix each issue:

   **TypeScript errors:**
   - Read the file at the reported line
   - Fix the type error (add type cast, fix import, correct type signature)
   - Verify with `pnpm --filter <package> exec tsc --noEmit`

   **Lint errors:**
   - Read the file at the reported line
   - Fix the lint error (remove unused imports, fix `Function` type, etc.)
   - Verify with `pnpm --filter <package> lint`

   **Test failures:**
   - Read the failing test file
   - Read the source file it tests
   - Fix the assertion or mock (usually a mock chain mismatch)
   - Verify with `pnpm --filter <package> test`

   **Merge conflicts:**
   - Merge main into the branch: `git fetch origin main && git merge origin/main --no-edit`
   - If conflicts, read each conflicted file and resolve
   - Prefer main's version for unrelated changes; keep the branch's version for feature changes
   - `git add <resolved-files> && git commit --no-edit`

4. After all fixes, run the full verification:
   ```bash
   pnpm --filter api exec tsc --noEmit    # typecheck
   pnpm --filter api lint 2>&1 | grep "error" | grep -v "warning"  # lint errors only
   pnpm --filter api test                  # unit tests
   ```

## Phase 3: Push

1. Stage and commit fixes:
   ```bash
   git add <fixed-files>
   git commit -m "fix: resolve CI failures (<brief description>)"
   ```

2. Push:
   ```bash
   git push
   ```

3. Report what was fixed to the user.

## Rules

- Be surgical — only fix what's causing CI to fail
- Do not modify test assertions to force them to pass unless the assertion is clearly wrong
- Do not skip or disable tests
- Do not modify unrelated code
- Ignore Vercel deployment failures — those are environment/config issues, not code issues
- If a failure is pre-existing and unrelated to the PR's changes, note it but don't fix it
- Always verify fixes locally before pushing
