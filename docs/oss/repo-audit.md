# Repo audit before open-sourcing (AI-50)

Audited: `NoJuanNobody/nyx` at commit `HEAD` of the AI-50 worktree (base `main`), 844 tracked files, 1105 commits across all refs (`git rev-list --all`).
Method: no `gitleaks` or `trufflehog` on PATH, so the scan used `git grep` on tracked files plus a regex pass over the added lines of the full patch history (`git log --all -p`, ~270k added lines, `pnpm-lock.yaml` excluded). Patterns: `sk_live/sk_test/pk_live/pk_test/rk_live/whsec_`, `AKIA`, `ghp_/gho_/github_pat_`, `xox[bpa]-`, `BEGIN ... PRIVATE KEY`, `sk-ant-`, `sk-or-v1-`, `tvly-`, `re_` (Resend), `AIza`, JWTs, DB URLs with passwords, generic `password/secret/token = "<24+ chars>"`, `KEY=value` lines in env/sh/yml/toml/md, IPs, phones, street addresses, emails. Also checked every path ever added for `.env*`, key/cert files, DB dumps, docs, grant files.
No secret values appear in this document. Values are reported as file, commit, type and a redacted prefix only.

## Verdict

- **No live credential was found in tracked files or in any commit.** Every key-shaped string is a placeholder, a test fixture or a public-by-design identifier (details below).
- `.env` was never committed. Only `.env.example` ever existed in history.
- `docs/grants/` (address and phone, gitignored) was never committed on any ref.
- **History rewrite: not required for secrets.** A rewrite is only worth considering for a small set of non-secret items (see "History rewrite recommendation"). Recommended path: publish the current history as is, after the HEAD cleanups below.
- The biggest open-source risks are **configuration, not leaked keys**: the nightly DB-backup workflow uploads production dumps as GitHub Actions artifacts (public once the repo is public), and the repo is wired to production SaaS hosts.

Limits of this audit: regex based, not entropy based. Secrets stored only in GitHub Actions secrets, Railway and Vercel were not inspected (no access). Run `gitleaks detect --log-opts="--all"` and `trufflehog git file://. --only-verified` once installed, as a second opinion, before flipping visibility.

## Findings (severity ranked)

| # | Sev | Where | Type | Detail | Action |
|---|-----|-------|------|--------|--------|
| 1 | High | `.github/workflows/db-backup.yml` (all runs since 2e1a4dc, 2026-06-25) | SaaS-only config / data exposure | Daily `pg_dump` of the production Railway DB (`secrets.DATABASE_PUBLIC_URL`) uploaded with `actions/upload-artifact` (30 day retention). Artifacts of a public repo are downloadable by anyone signed in to GitHub. Workflow only runs on the owner's prod DB. | Delete the workflow from the OSS tree. Before going public, delete every existing `db-backup-*` artifact (Actions tab, or `gh api` delete) and delete the `DATABASE_PUBLIC_URL` repo secret. Store backups off-repo (S3/R2 encrypted). |
| 2 | High | `.github/workflows/e2e-auto-fix.yml:40` | Secret handling | Uses `secrets.GH_PAT` (repo-admin PAT, per the comment) to push to branches. On a public repo, workflows triggered from forks do not get secrets, but a PAT with admin rights is a standing risk. | Remove or rewrite to use `GITHUB_TOKEN`. Rotate the PAT (list below). |
| 3 | Medium | `.github/workflows/claude.yml`, `claude-code-review.yml` | Secret handling | Use `secrets.CLAUDE_CODE_OAUTH_TOKEN`; `ci.yml` / others reference `secrets.ANTHROPIC_API_KEY`. Public repos let anyone trigger `@claude` flows. | Restrict triggers to collaborators/maintainers, or remove. Rotate the tokens once public. |
| 4 | Medium | `vercel.json`, `railway.toml`, `apps/api/Dockerfile` deploy path, `apps/web/index.html`, `apps/web/public/{robots.txt,sitemap.xml}`, `apps/web/prerender-meta.mjs`, `apps/api/src/app.ts:121-126`, `apps/api/src/lib/cors.ts`, `apps/api/src/routes/redirects.ts`, `apps/api/src/routes/mcp.ts:167`, `apps/api/src/lib/llm.ts:275`, `packages/harness-core/src/client.ts:21` | Hardcoded prod hosts / SaaS-only | Hardcoded `nyx-creative.com`, `clerk.nyx-creative.com`, `accounts.nyx-creative.com`, `api.nyx-creative.com` (CSP, canonical, OG tags, redirects, MCP resource URL), default API URL `https://nyx-api.up.railway.app`. CSP also whitelists Google Ads/GTM/DoubleClick. | Move hosts to config/env with `localhost` defaults. Delete Vercel/Railway deploy files (or move to `deploy/saas/` outside the OSS repo). Drop ad-tech CSP entries. |
| 5 | Medium | `scripts/rotate-secrets.sh` (7b9c425, 2026-10-13) | Internal ops runbook | No secrets inside, only placeholders (`sk_live_<new>` etc.). Documents Clerk/Railway/Vercel/Neon rotation and names the staging host `nyx-staging.up.railway.app`. | Remove from OSS tree. |
| 6 | Medium | `apps/api/generated-videos/*.mp4` (3 files, ~3.6 MB; added in 0db7781) | Generated user/demo content tracked despite `.gitignore` | Possibly user-generated content with unclear rights/provenance. Present in HEAD and history. | `git rm`; confirm provenance. Candidate for history scrub (see below). |
| 7 | Low | `apps/web/src/main.tsx` (597f95a, 6040215, 2026-03-15; since removed from HEAD) | Publishable key in history | Hardcoded Clerk publishable keys as fallbacks (`pk_test_…`, redacted; staging instance slug in commit message). Publishable keys are public by design (shipped in the browser bundle); not a secret. Reveals Clerk instance names. | No rotation needed. Optionally rotate/retire the staging Clerk instance. |
| 8 | Low | `apps/web/src/lib/analytics.ts:19` | Hardcoded analytics ID | GA4 measurement ID `G-KV…` fallback (public in page source but ties forks' traffic to the owner's property). | Remove fallback; read from env only. |
| 9 | Low | `.env.example` | Env template | Placeholders only (`sk_test_…`, `pk_test_…`, `whsec_…`, `ghp_…` truncated/empty). Comments reference SaaS-only vars: Stripe, Clerk, Resend, Recall.ai, Tavily, OpenAI TTS, Sentry, `nyx-creative.com`, `nyx-staging.up.railway.app`. Local DB password in comment and in `docker-compose.yml` is a dev default (`devpassword`, `postgres`). | Rewrite for the OSS config (drop Stripe/Clerk/agent vars, tied to the removal tickets). Dev defaults are fine. |
| 10 | Low | `Nyx_ProductBrief.md:9,101,169`, `Nyx_Landing.jsx:536`, `README.md:300`, `.agentpolicy/*`, `CLAUDE.md` | Personal info | Owner name, personal Gmail address (`al…@gmail.com`) and GitHub handle in the product brief; owner first name throughout `.agentpolicy/*.json`. `swarm-notes/349.md:110`, `swarm-notes/350.md:149` contain a local path `/Users/…/dev/worktrees/`. No phone numbers or street addresses found in tracked files or history. | Decide whether attribution is wanted (README credit is fine). Remove the personal email from the brief (or remove the brief). Scrub local paths. |
| 11 | Low | `SyncDocs_ProductBrief.docx`, `Nyx_ProductBrief.md`, `nyx-conference-itinerary-2026.md`, `nyx-conferences-2026.ics`, `marketing/ad-campaign-v1.md`, `preview-validation-dashboard.html`, `RUN_ISSUE.txt`, `LOCAL_DEV_KEYS_GUIDE.md`, `playwright-tests.md` | Internal business docs | Go-to-market plan, ad budget (~$25/day), conference travel plan, pricing strategy, old product name (SyncDocs). No credentials, but business-private and irrelevant to an OSS repo. `docx` is binary and was not text-scanned for hidden metadata. | Remove or move to a private repo. Check `.docx` author metadata if kept. |
| 12 | Low | `swarm-notes/` (144 files), `.agentpolicy/`, `.claude/skills/` | Internal agent process notes | Reference Railway/Vercel/Clerk workflow and internal ticket numbers; no secrets found. | Decide to keep as dev-process docs or drop. |
| 13 | Info | `.gitleaks.toml`, commits 49b0fea, 0d91e6f, ea7c8dd | Known false positive | Test fixture `sk_live_abc123…` (placeholder, replaced in 0d91e6f) allowlisted by commit. Related hardening in `apps/api/src/lib/config.ts:100-131` rejects `sk_test_`/`sk_live_` placeholder values in production. | Keep the gitleaks config and CI check. If history is rewritten, the commit allowlist must be updated. |
| 14 | Info | `apps/api/src/__tests__/services/governance.service.test.ts` (a8eaf62, e62de8e), `encryption.service.test.ts`, `ai-keys.test.ts`, `health.test.ts`, `stripe.service.test.ts`, `config.test.ts` | Test fixtures | Key-shaped strings are fake (`AKIA…EXAMPLE`, `ghp_ABCDEF…`, `xoxb-12345…`, truncated `BEGIN RSA` header, `sk-ant-api03-xxx…`, `whsec_test`, `pk_test_dGVzdC5j…` which base64-decodes to a fake host). Intentional fixtures for the secret-scanner tests. | Keep. Expect scanners to flag them; extend the allowlist by path instead of by commit. |
| 15 | Info | All `DATABASE_URL=postgres…:***@localhost/db` occurrences (README, docker-compose, tests, CI) | Local DB creds | Default dev passwords for localhost/docker only. | None. |
| 16 | Info | Git author identities | PII in history | 929 commits by the owner's Gmail, 1 commit by an external contributor (`princesajjadhussain`, personal Gmail), bot noreply addresses. | Normal for OSS. Mention to the external contributor if desired. |

## Rotate before going public

Nothing was found leaked, so rotation is precautionary. Do these because the repo and its Actions config become public and fork PRs / workflow runs become an attack surface. Order by risk:

1. `GH_PAT` (repo-admin PAT used by `e2e-auto-fix.yml`): revoke and replace with `GITHUB_TOKEN` or a fine-grained token with minimum scope.
2. `DATABASE_PUBLIC_URL` / production DB password (Railway Postgres): rotate, because the workflow used it and dumps were artifacts. Then delete the secret and the workflow.
3. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (GitHub Actions secrets): rotate once triggers are restricted.
4. Anything configured only in Railway/Vercel/GitHub (Clerk secret key, Stripe live key and webhook secret, Resend key, Recall.ai, Tavily, OpenAI, Google AI, OpenRouter, Sentry DSN, GitHub/GitLab/Bitbucket/Atlassian/Slack OAuth client secrets, `ENCRYPTION_SECRET`, `BYOK_ENCRYPTION_SECRET`, `GITHUB_FEEDBACK_PAT`): none appear in the repo, so these are not exposed by publishing. Rotate any that were ever pasted into issues, PR comments, CI logs or `swarm-notes` outside the repo. Stripe and Clerk are being removed from the product; retire the live keys when those tickets land.
5. `ENCRYPTION_SECRET` / `BYOK_ENCRYPTION_SECRET`: only rotate with a data migration (they encrypt stored OAuth tokens and user keys). Not needed unless the keys themselves were exposed.

## Files to remove or scrub from the OSS tree (HEAD)

Remove:
- `.github/workflows/db-backup.yml`, `.github/workflows/e2e-auto-fix.yml` (or rewrite without `GH_PAT`), `docs/ci/ci.yml` (stale copy of CI with hardcoded settings)
- `railway.toml`, `vercel.json`, deploy-specific parts of `apps/api/Dockerfile` if Railway-specific
- `scripts/rotate-secrets.sh`
- `apps/api/generated-videos/` (3 mp4 files)
- `marketing/ad-campaign-v1.md`, `nyx-conference-itinerary-2026.md`, `nyx-conferences-2026.ics`, `Nyx_ProductBrief.md`, `SyncDocs_ProductBrief.docx`, `Nyx_Landing.jsx`, `Nyx_Lifecycle.jsx`, `preview-validation-dashboard.html`, `RUN_ISSUE.txt`
- Decide on: `swarm-notes/`, `.agentpolicy/`, `.claude/skills/`, `CLAUDE.md` (internal agent process; rewrite to generic contributor guidance)
- SaaS feature code (tracked by the other tickets): Stripe (`stripe.service.ts`, `subscriptions.ts`, `billing.ts`, `Pricing.tsx`, `STRIPE_*` env), in-app agent and chat (`services/agent/*`, `routes/agent*.ts`, `aiChat.store.ts`, `AgentMap*`), Clerk auth wiring, `redirects.ts` (marketing redirects), `sales@nyx.io` mailto in `Settings.tsx:1838`.

Scrub (edit in place):
- Replace hardcoded `nyx-creative.com`, `clerk.*`, `accounts.*`, `api.*`, `nyx-api.up.railway.app`, `nyx-staging.up.railway.app` with env-driven values (files in finding 4, plus `.env.example` and `LOCAL_DEV_KEYS_GUIDE.md`).
- `apps/web/src/lib/analytics.ts` GA fallback ID; Google Ads/GTM/DoubleClick hosts in CSP (`vercel.json`, `index.html`, `app.ts`).
- Personal email and local paths (finding 10).
- `.gitignore`: keep `docs/grants/` entries until grant material is moved out; keep `generated-videos/`.
- `.env.example`: rewrite after Stripe/Clerk/agent removal.

## History rewrite recommendation

**Not recommended for secrets** (none found). Two optional, non-secret reasons to rewrite:

1. The 3 tracked `generated-videos/*.mp4` (introduced in `0db7781`, ~3.6 MB) if their provenance or user-content status is a concern.
2. Business-private documents (`marketing/`, product brief, conference plan, `.docx`) if the owner does not want past versions public.

If a rewrite is chosen: do it once, before the repo is made public, with `git filter-repo --path <p> --invert-paths` on a fresh mirror clone; update the commit-pinned allowlist in `.gitleaks.toml` (`49b0fea`); expect all SHAs to change (open PRs, notes referencing SHAs); force-push only the new public repo. Simpler alternative with the same outcome for most risk: publish as a **fresh repo with squashed history** and keep the current repo private. Otherwise (default recommendation) publish the existing history after the HEAD cleanups and the artifact deletion in finding 1.

## Pre-launch checklist

- [ ] Delete existing `db-backup-*` Actions artifacts and the workflow (finding 1).
- [ ] Rotate `GH_PAT`, DB password, Claude/Anthropic Actions secrets.
- [ ] Remove/scrub the file lists above.
- [ ] Run `gitleaks detect --log-opts="--all"` and `trufflehog git file://. --only-verified` locally; expect only the documented test fixtures.
- [ ] Re-run this grep pass on the final branch; keep `.gitleaks.toml` and a CI secret scan.
- [ ] Enable GitHub secret scanning and push protection after the repo goes public.
