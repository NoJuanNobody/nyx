# Merge PR

Check if a PR's CI checks pass, then merge it.

## Arguments

- PR number (required) — e.g. `/merge-pr 67`

## Steps

1. Check the PR's CI status:
   ```bash
   gh pr checks <number>
   ```

2. Evaluate results:
   - If all **required** checks pass, proceed to merge
   - Ignore Vercel preview deployment failures (these are non-blocking)
   - If any required check (Build, Unit Tests, E2E Tests, Code Quality, Security) fails, **do not merge** — report the failures to the user

3. Merge the PR with squash:
   ```bash
   gh pr merge <number> --squash
   ```

4. Confirm the merge:
   ```bash
   gh pr view <number> --json state,mergedAt
   ```

5. Report the result to the user.
