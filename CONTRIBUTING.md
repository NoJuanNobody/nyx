# Contributing to Nyx

Thanks for helping. Nyx is an open-source, agent-native desktop app: a pure-Rust core crate (`nyx-core`) shared by a Tauri 2 desktop shell, a CLI and an MCP server, alongside the existing TypeScript apps (API and web UI). Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. For security issues, do not open a public issue; see [SECURITY.md](SECURITY.md).

Environment setup lives in [docs/dev-setup.md](docs/dev-setup.md).

## Ground rules

- Open an issue (or comment on an existing one) before starting anything larger than a small fix, so we can agree on direction.
- Keep pull requests focused: one logical change each.
- Credits are agent-native utility tokens. They are never sold, have no fiat value and are not transferable. Contributions that add purchase flows, pricing or payment processing will not be accepted. See [docs/credits/utility-tokens-spec.md](docs/credits/utility-tokens-spec.md).
- The in-app AI agent and chat sidebar were removed on purpose. Nyx is driven by external agents through MCP and the CLI; please do not reintroduce an embedded agent.

## Repository layout

| Path | What it is |
|---|---|
| `crates/nyx-core` | Rust core: model, store, credit ledger, errors. No UI. |
| `crates/nyx-cli` | `nyx` command-line interface (clap). |
| `crates/nyx-mcp` | Rust MCP server (stdio transport still TODO). |
| `apps/desktop` | Tauri 2 shell (`src-tauri`) and placeholder UI. |
| `apps/api`, `apps/web` | TypeScript Fastify API and React UI. |
| `packages/*` | `shared`, `harness-core` (tool definitions), `mcp-server`, `cli`. |
| `docs/` | Specs, ADRs and audit docs. See [docs/rust-workspace.md](docs/rust-workspace.md). |

## Workflow: worktree, branch, pull request

1. Fork the repo (external contributors) or clone it (maintainers).
2. Create a branch from `main`. We recommend one git worktree per branch so parallel work does not collide:

   ```sh
   git fetch origin
   git worktree add ../nyx-my-change -b my-change origin/main
   cd ../nyx-my-change
   ```

   Branch names: `<type>/<short-description>`, e.g. `fix/ledger-rounding`. Maintainers using Linear can use the generated branch name for the ticket.
3. Install dependencies and make your change (see below). A fresh worktree has no `node_modules`; run `pnpm install --frozen-lockfile` in it.
4. Run the checks below locally. CI runs the same gates.
5. Commit with sign-off (see [Commit style](#commit-style) and [Sign-off](#sign-off-dco-or-cla)), push your branch and open a pull request using the template. Link the issue it closes.
6. Respond to review. Prefer new commits during review; maintainers squash or rebase on merge.
7. Remove the worktree when merged: `git worktree remove ../nyx-my-change`.

## Checks to run before opening a PR

### Rust workspace

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

- `unsafe` code is forbidden and `unwrap` is denied outside tests (workspace lints in the root `Cargo.toml`).
- Plain `cargo test` skips the desktop crate (it needs system webview libraries on Linux); `--workspace` includes it.
- Run `cargo fmt` to fix formatting. Do not commit `target/`.

### TypeScript apps and packages

Use **pnpm** (version pinned in `package.json`); never npm or yarn.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Useful variations:

```sh
pnpm --filter @nyx/api test          # one workspace
pnpm --filter @nyx/shared build      # build shared deps before typechecking others
pnpm test:e2e                        # Playwright E2E (see playwright.config.ts)
pnpm format:check                    # Prettier
```

- Do not hand-edit `pnpm-lock.yaml`. If you change dependencies, commit the lockfile update that `pnpm install` produces and mention it in the PR.
- Database changes need a Drizzle migration with the next number **and** a matching entry in `apps/api/drizzle/meta/_journal.json`. See `apps/api/MIGRATIONS.md`.
- Add or update tests for behavior you change. Do not weaken or skip existing tests to make a build pass.

## Commit style

Conventional-style subject, imperative mood, 72 characters or fewer:

```
<type>: <summary> (#issue)
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`. Optional scope: `fix(e2e): ...`. Use the body for the why, in short bullets. Keep commits reviewable; avoid mixing refactors with behavior changes.

## Sign-off: DCO or CLA

**Status: pending the license decision.** The project license has not been chosen yet; the proposal and open questions are in [docs/oss/license-decision.md](docs/oss/license-decision.md). The memo recommends the Developer Certificate of Origin (DCO), with a CLA only if the owner wants the right to relicense.

Until that is settled:

- Add a `Signed-off-by` line to every commit (`git commit -s`). This certifies the [DCO 1.1](https://developercertificate.org/) and costs nothing.
- Contributions may be asked to be re-affirmed under a CLA if that path is chosen. This section will be updated, and a DCO check added to CI, once the decision is recorded.
- No `LICENSE` file exists yet. Do not add one in a PR.

## How to add a lifecycle pipeline

A lifecycle pipeline is an ordered set of document stages (for example Conception, Definition, Architecture). Pipelines are plain data in this repo, not logic.

1. Read [docs/lifecycle-stages.md](docs/lifecycle-stages.md) for the model.
2. Add an entry to `LIFECYCLE_SEEDS` in `apps/api/src/db/seed-lifecycles.ts`. Each entry has `slug`, `label`, `description`, `icon`, `isDefault` (only the software development pipeline is default), `sortOrder` and a `stages` array. Each stage needs `slug`, `sortOrder`, `label`, `abbreviation`, `subtitle`, the color fields, `who`, `description`, `icon`, `output` and `docs` (the `ai` field describes quality criteria; keep it factual and do not add features that depend on a removed in-app agent).
3. Optionally add starter templates for each stage slug in `apps/api/src/db/lifecycle-templates.ts` (`stage`, `name`, `description`, `content`, `sortOrder`).
4. Slugs are lowercase `snake_case` and unique; stage slugs are unique within their pipeline.
5. Seed locally to check it loads (the script is idempotent; needs `DATABASE_URL`):

   ```sh
   pnpm --filter @nyx/api exec tsx src/db/seed-lifecycles.ts
   ```

6. Add or extend a test and run `pnpm --filter @nyx/api test`.

## How to write an MCP tool

Tool definitions are protocol-agnostic and shared by MCP, CLI and other agent integrations.

1. Add a `ToolDefinition` to `TOOL_DEFINITIONS` in `packages/harness-core/src/tools.ts`: a `nyx_`-prefixed snake_case `name`, a clear `description` an agent can act on, and a JSON-Schema `inputSchema` with `required` set accurately.
2. Add the matching `case` to `executeTool` in the same file. Validate inputs, return JSON-serializable data and throw errors with actionable messages. API-backed tools go through `NyxClient`.
3. Tools that need the local machine (filesystem, web search) are handled in `packages/mcp-server/src/tools.ts` before delegating to harness-core.
4. If the tool does compute-heavy work, meter it through the credit ledger and declare its cost in the cost table (config, not code). Spec: [docs/credits/utility-tokens-spec.md](docs/credits/utility-tokens-spec.md). Tools must work for an agent with a zero budget by failing clearly, never by bypassing the ledger.
5. Add tests in `packages/harness-core/src/__tests__/tools.test.ts` and `packages/mcp-server/src/__tests__/tools.test.ts`.
6. The Rust MCP server (`crates/nyx-mcp`) is a stub; new Rust-side tools should call `nyx-core` and follow the same names and schemas so both servers stay compatible.

## Credits, MCP and CLI contributions

- Credit logic has a reference TypeScript implementation (`apps/api/src/services/credit-ledger.service.ts`) and a Rust port target in `nyx-core` (`ledger.rs`). Section 9 of the spec is the contract. Both must keep the same semantics: integer credits, idempotency keys, append-only entries, no minting outside an owner grant.
- CLI commands live in `crates/nyx-cli` (Rust) and `packages/cli` (TypeScript). Prefer adding new behavior to `nyx-core` and exposing it thinly from the CLI and MCP.
- Anything that spends credits must accept an agent identity and an idempotency key.

## Reporting bugs and requesting features

Use the issue forms: [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) or [feature request](.github/ISSUE_TEMPLATE/feature_request.yml). Never paste secrets, API keys or tokens into an issue.
