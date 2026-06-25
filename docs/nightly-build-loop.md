# Nightly autonomous build loop

A self-contained prompt for an **unattended nightly run** (a 5am cron via
`/schedule`) that drains the `ready to code` backlog the way a normal session
would, following this fixed loop:

1. **`next-issues 5`** — pick the next 5 buildable issues in build order.
2. **research each** — deep-dive every picked issue (root cause + plan).
3. **implement each** — build every issue in its own git worktree.
4. **merge to an integration branch** — `nightly/<YYYY-MM-DD>`.
5. **fix CI repeatedly until it passes** — open ONE PR so CI runs, then loop
   `fix-ci` until the gate is green.

It **never merges to main** and **never pushes to main** — you review and merge
the green PR in the morning.

- **For the true 5am cron:** use `/schedule` to create a cloud routine at
  `7 5 * * *` with the prompt below. It runs server-side without your machine —
  the same mechanism the versailles-court-simulator nightly loop uses.
- **`/loop`** runs the same prompt but only while a live session is open, so it
  is not a real unattended cron — use it only if you keep the machine awake.

Set `<<NIGHTLY_TOKEN_BUDGET>>` to a safety ceiling (recommend ~50–60% of your
5-hour output budget so morning interactive work keeps headroom). The natural
stop — "no eligible issues left" — usually fires before the budget does.

---

## Prompt

```
Autonomous nightly build for NoJuanNobody/nyx.
Running UNATTENDED at ~5am — there is no human to confirm anything, so auto-proceed
through every phase without waiting for approval. Conservative: open ONE PR on an
integration branch, never merge, never push to main, leave a clean tree. Budget
~<<NIGHTLY_TOKEN_BUDGET>> output tokens; stop early if hit.

## 1. Orient
- `gh repo view`; `git checkout main && git pull`; `git worktree prune`.
- List OPEN issues (number,title,labels,body) and OPEN PRs (avoid redoing in-flight
  work). Read each candidate issue body fully (acceptance criteria + any "Depends on #N").
- Read CLAUDE.md and Nyx_ProductBrief.md for conventions and product context.

## 2. next-issues 5 — pick tonight's wave (in dependency order)
- Apply the `next-issues` selection logic (no interactive confirm — this is unattended).
- Eligible = `ready to code`, NOT `decision`/`blocked`/`wontfix`/`P4: Post-MVP` unless
  nothing else is ready, and every dependency is EITHER already merged to main OR
  included earlier in tonight's ordered set (so a chain can be built in one night).
- Sort topologically: deps first, then phase (P3: MVP before P4: Post-MVP), smallest
  surface first. Take up to 5. If none eligible, skip to step 7.

## 3. research each issue
- For every picked issue, run the `research-issue` deep-dive: trace the root cause /
  affected files through the codebase, confirm acceptance criteria, and write a short
  implementation plan. Post the findings as a comment on the issue. If research shows an
  issue is actually blocked or under-specified, drop it from tonight's wave and note why.

## 4. Integration branch + per-issue worktrees + implement each
- Create the integration branch off main: `nightly/<YYYY-MM-DD>`.
- BEFORE parallelizing, pre-add every new dependency the wave needs to the right
  package.json and run one `pnpm install`, then commit — so parallel work never races on
  pnpm-lock.yaml. (CI uses `--frozen-lockfile`; keep the lockfile current.)
- For each issue, IN DEPENDENCY ORDER, create a REAL git worktree off the current
  integration tip (so prior deps are present):
    git worktree add .nightly-wt/issue-<n> -b feat/issue-<n>-<slug> nightly/<date>
  Create the worktree explicitly and operate in that directory — do NOT rely on an agent
  "isolation: worktree" flag for isolation.
- Implement each issue with the `implement-issue` workflow, to repo conventions
  (CLAUDE.md): pnpm 9.15.4 monorepo (Turborepo), TypeScript strict, ESM, Drizzle for
  schema, Zod in @nyx/shared, Fastify routes in apps/api, React 18 in apps/web, Vitest
  unit tests + Playwright e2e. Write tests with the code; keep that slice green
  (pnpm typecheck / lint / test). Commit on its branch.
- Independent issues' worktrees MAY run in parallel; dependent ones branch off the
  updated integration tip.

## 5. Merge into the integration branch
- Merge each worktree branch into `nightly/<date>` in dependency order
  (`git merge --no-edit`); resolve conflicts.
- Do the cross-cutting INTEGRATION WIRING here (package barrels/exports, route
  registration in apps/api, App mounting in apps/web, shared config) — the glue that
  doesn't belong to any one issue.
- Run the FULL gate locally on the integration branch: `pnpm typecheck`, `pnpm lint`,
  `pnpm test`, `pnpm build`. Fix until green. Never weaken or skip tests.

## 6. Open ONE PR, then fix CI repeatedly until it passes
- Push `nightly/<date>`; open ONE NON-draft PR -> main, listing each issue with a test
  plan, and `Closes #<n>` for every issue in the wave. DO NOT merge.
- Then LOOP: run `gh pr checks` on that PR; while any required check fails (ignore Vercel
  deployment env failures), apply the `fix-ci` workflow — pull the failed job logs,
  categorize (typecheck / lint / test / build / merge conflict), fix on the integration
  branch, push, wait for CI to re-run. Repeat until all required checks are green OR a
  check fails the same way 3 times in a row OR the token budget is hit.
- If a single issue is the cause of an unfixable red and dropping it would let the rest go
  green, back it out of the integration branch (revert its merge), note it on its issue,
  and continue. Never force a red build into a "ready for review" state — if it can't go
  green, mark the PR draft and explain why.
- Remove all worktrees (`git worktree remove --force`); delete the throwaway per-issue
  branches; kill any dev servers.

## 7. Stop conditions & report
- Stop when: no eligible issues, token budget hit, or the same CI check fails 3x — then
  leave the offending issue OUT and note it. Never push to main; never force-push main.
- End with a summary comment on the PR: issues included, research links, CI state
  (green / which checks still red and why), anything skipped/blocked and why.

Guardrails: integration branch off main only; never merge to main, never push to main,
never force-push main; real `git worktree` per issue (not the agent flag); ONE PR per
night off the integration branch; the loop's terminal goal is a GREEN PR left for human
review; clean tree + no leftover worktrees at exit.
```

---

## Hard lessons baked in

Carried over from the versailles-court-simulator nightly loop — they are why the
prompt is shaped this way:

1. **Pre-add all deps + one `pnpm install` before parallelizing.** Parallel
   worktrees editing `package.json` / `pnpm-lock.yaml` independently produce
   guaranteed lockfile merge conflicts — and nyx CI runs `--frozen-lockfile`.
2. **Use real `git worktree add`, not the agent `isolation: "worktree"` flag.**
   In practice that flag collapsed to one shared working tree and parallel
   agents raced on git state.
3. **Integration wiring is its own step** on the integration branch after the
   merges — route registration, barrels, App mounting, shared config. It belongs
   to no single issue and is easy to drop.
4. **CI is the source of truth, not the local gate.** A headless cron can pass
   `pnpm test` locally and still fail CI (e.g. Playwright e2e, environment).
   The loop opens the PR and drives `fix-ci` against real CI until green rather
   than trusting the local run.
