# CI/CD Pipeline

**Issue:** #19
**Status:** Planned
**Priority:** P2 — Pre-MVP Infrastructure

---

## Overview

SyncDocs needs a CI/CD pipeline that runs automatically on every pull request and push to `main`. The pipeline validates code quality (type checks, linting, tests) and handles automated deployment to Vercel (frontend) and Railway or Render (backend). No AWS deployment is in scope.

## Goals

- Catch regressions before they land on `main`
- Enforce consistent code style and type safety across the full stack
- Automate deployments so merging to `main` is all that's needed to ship
- Keep the pipeline fast enough that developers don't bypass it

## Tech stack context

| Layer | Technology |
|-------|------------|
| **Frontend** | React + TypeScript, deployed to Vercel |
| **Backend** | Node.js + Express or Fastify, deployed to Railway or Render |
| **Database** | PostgreSQL |
| **CI platform** | GitHub Actions |

---

## Pipeline stages

### Stage 1 — Code quality (runs on every PR and push)

These checks run in parallel to keep the pipeline fast. All must pass before any deployment can proceed.

#### 1.1 TypeScript type checking

```yaml
- name: Type check (frontend)
  run: cd frontend && npx tsc --noEmit

- name: Type check (backend)
  run: cd backend && npx tsc --noEmit
```

- Runs `tsc --noEmit` across both the frontend and backend packages
- Any type errors fail the pipeline immediately
- No `any` escape hatches allowed in CI (enforced via `tsconfig` `strict: true`)

#### 1.2 Linting

```yaml
- name: Lint (frontend)
  run: cd frontend && npx eslint . --max-warnings 0

- name: Lint (backend)
  run: cd backend && npx eslint . --max-warnings 0
```

- ESLint with zero-warning tolerance (`--max-warnings 0`) — warnings are treated as errors
- Prettier formatting check (`prettier --check .`) runs alongside ESLint — formatting issues fail the build
- Separate lint configs for frontend (React + JSX rules) and backend (Node.js rules)

#### 1.3 Unit and integration tests

```yaml
- name: Test (frontend)
  run: cd frontend && npx vitest run --coverage

- name: Test (backend)
  run: cd backend && npx vitest run --coverage
  env:
    DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
```

- Vitest for both frontend and backend (fast, native TypeScript support)
- Coverage thresholds enforced in `vitest.config.ts` — pipeline fails if coverage drops below the defined floor
- Integration tests for the backend run against a PostgreSQL test database (provisioned as a GitHub Actions service container)

#### 1.4 End-to-end tests

```yaml
- name: E2E tests
  run: npx playwright test
  env:
    BASE_URL: ${{ env.PREVIEW_URL }}
```

- Playwright tests run against the Vercel preview deployment (deployed in a prior step)
- Smoke tests cover: auth flow, document creation, GitHub integration webhook receipt, and ticket creation
- E2E tests run on PRs only, not on every push to `main` (they're slower and have external dependencies)

---

### Stage 2 — Security and dependency checks

#### 2.1 Dependency audit

```yaml
- name: Dependency audit
  run: npm audit --audit-level=high
```

- `npm audit` run across all workspaces — fails the pipeline on `high` or `critical` severity vulnerabilities
- Developers must either patch the vulnerability or explicitly add it to an `.nsprc` ignore list with a documented rationale

#### 2.2 Secret scanning

- GitHub's native secret scanning is enabled on the repository
- Additionally, `gitleaks` or `trufflehog` runs as a CI step to scan commits for accidentally committed secrets (API keys, tokens, database credentials)

```yaml
- name: Secret scan
  uses: gitleaks/gitleaks-action@v2
```

#### 2.3 License compliance check

```yaml
- name: License check
  run: npx license-checker --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC"
```

- Blocks dependencies with incompatible licenses (GPL, AGPL, etc.) from entering the codebase
- Relevant because SyncDocs is a commercial SaaS product

---

### Stage 3 — Build verification

#### 3.1 Frontend build

```yaml
- name: Build frontend
  run: cd frontend && npm run build
```

- Runs `vite build` to ensure the production bundle compiles successfully
- Bundle size report generated and attached to the PR as a comment (using `bundlesize` or `vite-bundle-visualizer`)
- Fails if the total bundle size exceeds a defined threshold

#### 3.2 Backend build

```yaml
- name: Build backend
  run: cd backend && npm run build
```

- Compiles TypeScript to JavaScript for production
- Verifies there are no build-time errors separate from `tsc --noEmit`

---

### Stage 4 — Deployment

#### 4.1 Preview deployments (PRs)

- **Frontend:** Vercel automatically creates a preview deployment for every PR via the Vercel GitHub integration. No custom CI step needed — Vercel handles this natively.
- **Backend:** Railway or Render creates a preview environment per PR branch (if the platform supports it) or a shared staging environment is used.
- Preview URLs are posted to the PR as comments automatically by the platform integrations.

#### 4.2 Production deployment (`main` branch only)

- **Frontend:** Vercel automatically deploys to production when `main` is updated. No custom step needed.
- **Backend:** Railway or Render triggers a production deploy via a deploy hook or GitHub integration on push to `main`.
- Database migrations run automatically as part of the backend startup sequence (using a migration tool such as `node-pg-migrate` or `drizzle-kit`).

```yaml
- name: Run database migrations
  run: cd backend && npm run db:migrate
  env:
    DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}
  if: github.ref == 'refs/heads/main'
```

---

## Full pipeline overview

```
Pull Request opened / updated
          │
          ▼
┌─────────────────────────────────────────────┐
│  Stage 1: Code Quality (parallel)           │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ TS check │  │  Lint +  │  │   Tests   │  │
│  │ (fe+be)  │  │ Prettier │  │ (fe+be)   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
└──────────────────────┬──────────────────────┘
                       │ all pass
                       ▼
┌─────────────────────────────────────────────┐
│  Stage 2: Security Checks (parallel)        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │   npm    │  │  Secret  │  │  License  │  │
│  │  audit   │  │  scan    │  │   check   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
└──────────────────────┬──────────────────────┘
                       │ all pass
                       ▼
┌─────────────────────────────────────────────┐
│  Stage 3: Build Verification (parallel)     │
│  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Frontend build  │  │  Backend build   │  │
│  └──────────────────┘  └──────────────────┘  │
└──────────────────────┬──────────────────────┘
                       │ all pass
                       ▼
┌─────────────────────────────────────────────┐
│  Stage 4: Preview Deploy                    │
│  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Vercel preview  │  │  Railway/Render  │  │
│  │  (auto via GH    │  │  staging env     │  │
│  │   integration)   │  └──────────────────┘  │
│  └──────────────────┘                        │
└──────────────────────┬──────────────────────┘
                       │ preview deployed
                       ▼
              ┌─────────────────┐
              │  E2E tests on   │
              │  preview URL    │
              └────────┬────────┘
                       │
                       ▼
              PR is mergeable ✓

Merge to main
     │
     ▼
Vercel + Railway/Render auto-deploy to production
DB migrations run on backend startup
```

---

## GitHub Actions workflow files

### `.github/workflows/ci.yml` — runs on every PR and push

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  quality:
    name: Code Quality
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: [frontend, backend]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci --workspace=${{ matrix.package }}

      - name: Type check
        run: npm run typecheck --workspace=${{ matrix.package }}

      - name: Lint
        run: npm run lint --workspace=${{ matrix.package }}

      - name: Format check
        run: npm run format:check --workspace=${{ matrix.package }}

  test:
    name: Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpassword
          POSTGRES_DB: syncdocs_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test --workspaces
        env:
          DATABASE_URL: postgres://postgres:testpassword@localhost:5432/syncdocs_test

  security:
    name: Security
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # required for gitleaks

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Dependency audit
        run: npm audit --audit-level=high --workspaces

      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: License check
        run: npx license-checker --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC"

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [quality, test, security]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build frontend
        run: npm run build --workspace=frontend

      - name: Build backend
        run: npm run build --workspace=backend

  e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    needs: build
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run E2E tests
        run: npx playwright test
        env:
          BASE_URL: ${{ env.VERCEL_PREVIEW_URL }}
```

---

## Branch protection rules

To enforce the pipeline, the following branch protection rules should be set on `main`:

- **Require status checks to pass before merging:** `quality`, `test`, `security`, `build`
- **Require branches to be up to date before merging** — prevents stale PRs from slipping through
- **Dismiss stale reviews when new commits are pushed**
- **Require at least 1 approving review** (for team collaboration, can be waived for solo dev phase)
- **Do not allow bypassing the above settings** (applies to admins too)

---

## Additional checks — full list

| Check | Tool | Failure condition |
|-------|------|-------------------|
| TypeScript type errors | `tsc --noEmit` | Any type error |
| ESLint violations | `eslint --max-warnings 0` | Any warning or error |
| Prettier formatting | `prettier --check` | Any unformatted file |
| Unit test failures | Vitest | Any failing test |
| Code coverage drop | Vitest coverage thresholds | Below configured floor |
| High/critical vulnerabilities | `npm audit` | `high` or `critical` severity |
| Leaked secrets | Gitleaks | Any detected secret pattern |
| Incompatible licenses | `license-checker` | Non-allowlisted license |
| Build failure (frontend) | `vite build` | Any build error |
| Build failure (backend) | `tsc` + bundler | Any build error |
| Bundle size regression | `bundlesize` or similar | Exceeds defined threshold |
| E2E smoke tests | Playwright | Any failing test on preview URL |
| Stale PR branch | GitHub branch protection | Branch more than N commits behind `main` |

---

## Open questions

- **Coverage thresholds** — what floor do we set for unit test coverage? Typical starting point is 70–80%. Too high a threshold too early can slow development; too low provides false confidence.
- **E2E scope** — how many E2E tests are acceptable before the pipeline becomes too slow? A time budget (e.g., 5 minutes max) should be set and tests pruned if it's exceeded.
- **Staging environment** — does Railway or Render support per-PR preview environments, or will there be one shared staging environment? Per-PR is ideal for isolation but adds cost.
- **Database migration safety** — how do we handle migrations that could be destructive (column drops, table renames)? A pre-migration dry run or human approval step may be needed before running on production.
- **Monorepo structure** — the workflow above assumes an npm workspaces monorepo (`frontend/` and `backend/` packages). If the repo is structured differently, the workflow paths will need to be updated.
