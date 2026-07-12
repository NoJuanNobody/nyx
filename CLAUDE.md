# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nyx is a product versioning platform that unifies technical documentation, code, and team workflow. It keeps specs in sync with code as it evolves and lets non-technical stakeholders initiate changes that flow through to the codebase.

The product brief is at `Nyx_ProductBrief.md` — read it for full context on features, target users, competitive landscape, and business model.

## Project Status

Pre-MVP / scaffolding phase. The next step is to scaffold the project using the product brief as the starting spec.

## Tech Stack

- **Frontend:** React 18 + TypeScript, hosted on Vercel
- **Backend:** Node.js + Fastify, hosted on Railway or Render
- **Database:** PostgreSQL (document storage, version history) via Drizzle ORM
- **AI:** Anthropic Claude API (spec quality analysis, drift detection, ticket generation)
- **Auth:** Clerk
- **E2E Testing:** Playwright
- **Unit Testing:** Vitest
- **Package Manager:** pnpm (monorepo with Turborepo)
- **Integrations:** GitHub API + Webhooks, Jira REST API, Confluence REST API
- **Agent Integrations:** Cursor extension, GitHub Copilot extension, Claude Code MCP/CLI

## Package Manager

This project uses **pnpm 9.15.4** (pinned via `packageManager` in `package.json`). Always use `pnpm` — never `npm` or `yarn`.

- **Run a script in a workspace:** `pnpm --filter <package> <script>`
- **Run an arbitrary binary in a workspace:** `pnpm --filter <package> exec <command>`
- **Add a dependency:** `pnpm --filter <package> add <dep>`
- **Install all deps:** `pnpm install`
- CI uses `pnpm install --frozen-lockfile` — keep `pnpm-lock.yaml` up to date.

## Key Commands

```bash
# Install dependencies
pnpm install

# Run E2E tests
pnpm exec playwright test

# Run unit tests
pnpm test

# Build all packages
pnpm build

# Start dev server
pnpm dev
```

## MVP Core Features

1. Structured document editor with markdown support and AI-assisted spec writing
2. GitHub integration that detects doc-code drift
3. Ticket creation via GitHub Issues or Jira integration (not internal ticketing)
4. Document version history with diff view
5. Role-based team access (dev vs. non-dev)
6. Onboarding flow that scans existing codebases to bootstrap documentation
7. Documentation export (Markdown, PDF)

## Architecture Principles

- Nyx integrates with external tools (GitHub Issues, Jira, Confluence) rather than replacing them
- Coding agent integrations (Cursor, Copilot, Claude Code) are first-class — specs should flow directly into AI coding workflows
- Non-technical users initiate changes through documentation; those changes are pushed as tickets to developer tools
- No vendor lock-in — full documentation export is always available

## File Structure

```
.
├── apps/
│   ├── web/           # React frontend (Vite)
│   └── api/           # Fastify API server
├── packages/
│   └── mcp-server/    # MCP server for agent integrations
├── e2e/               # Playwright E2E tests
├── drizzle/           # Database migrations
├── .github/
│   └── workflows/
│       └── ci.yml     # CI pipeline
└── CLAUDE.md          # This file
```

## E2E Test Details

- Tests: `e2e/` directory
- Config: `playwright.config.ts`
- Fixtures: `e2e/fixtures/test-base.ts` (authenticated page, mock AI)
- Selectors: `e2e/fixtures/selectors.ts` (centralized `data-testid` selectors)

## Common Failure Patterns

- Timing: use `waitFor({ state: 'visible', timeout: ... })` for elements that load asynchronously
- Auth: tests use a seeded test user via the `authenticatedPage` fixture
- Platform: keyboard shortcuts must use `Control` on Linux CI, `Meta` on macOS (`process.platform` check)
- Database: CI uses `drizzle-kit push --force` to set up the test schema (fast, ephemeral test DB). Production uses `drizzle-kit migrate` (versioned, journal-based). See `apps/api/MIGRATIONS.md` for the full migration guide.

## Fix Guidelines

1. **Be surgical** — change only what is necessary to fix the failing test(s).
2. **Do not** change test assertions to force them to pass unless the assertion is clearly wrong.
3. **Do not** skip or comment out failing tests.
4. **Do not** modify unrelated code, styles, or configs.
5. If the fix requires an environment variable or external service that isn't available in CI, output `CANNOT_FIX: <reason>` instead of guessing.
6. Commit with format: `fix(e2e): <concise description>`.

## Parallel Agents / Worktrees

- When running parallel agent swarms or worktree-based implementations, always ensure branches are pushed/updated BEFORE cleaning up worktrees. Verify merge results by running the full test suite after combining parallel branches.

## CI / Debugging

- Before diagnosing CI failures, first check if the failure is an infrastructure/billing issue (e.g., GitHub Actions runner problems) rather than a code problem. Ask the user or check the raw logs before attempting code fixes.

## Git Workflow

- When fixing bugs, apply changes on the correct branch before editing files. Always verify the current branch with `git branch --show-current` before starting edits.

## Testing

- This project uses TypeScript. Always run the full test suite (`pnpm test`) after multi-file changes, especially after merging parallel agent work. Expect and fix TypeScript errors, mock hoisting issues, and duplicate exports from merges.

## Debugging Guidelines

- When the user reports something isn't working (e.g., 'server not running', 'changes not visible'), verify the actual state before insisting otherwise. Check if the user might be viewing staging vs localhost, or if a service actually crashed.

## Tooling

- Default to the CLI wherever possible instead of asking the user to click through a UI. This is especially true for Railway — use `railway environment <env>`, `railway service <name>`, `railway variables --kv`, `railway variables --set KEY=VALUE`, `railway redeploy --yes`, and `railway logs` rather than directing the user to the Railway dashboard. Same principle for `gh`, `vercel`, and similar tools.
