# Developer setup

How to get a working checkout. Contribution rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | stable, MSRV 1.80 | `rust-toolchain.toml` pins the channel and installs `rustfmt` and `clippy` via rustup |
| Node.js | 20 or newer | for the TypeScript apps |
| pnpm | 9.15.4 | pinned in `package.json` (`corepack enable` picks it up) |
| Docker | optional | `docker-compose.yml` provides PostgreSQL for the API |
| Tauri prerequisites | desktop only | on Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` and friends; macOS needs Xcode command line tools; Windows needs WebView2 and MSVC build tools. See the Tauri 2 docs. |

## Clone and worktrees

```sh
git clone https://github.com/NoJuanNobody/nyx.git
cd nyx
# one worktree per branch keeps parallel work isolated
git worktree add ../nyx-my-change -b my-change origin/main
```

Each worktree needs its own `pnpm install`; `node_modules` and `target/` are not shared.

## Rust workspace

```sh
cargo build                          # core, CLI, MCP (default members)
cargo test                           # same set
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace               # includes the Tauri desktop crate
cargo run -p nyx-cli -- --version
```

Desktop app:

```sh
cargo install tauri-cli --version "^2"
cd apps/desktop/src-tauri && cargo tauri dev
```

Crate layout and conventions: [rust-workspace.md](rust-workspace.md).

## TypeScript apps

```sh
pnpm install --frozen-lockfile
pnpm build            # builds workspace packages (turbo)
pnpm typecheck
pnpm lint
pnpm test
pnpm dev              # API and web dev servers
```

If typechecking a package fails on missing types in a fresh checkout, build the shared packages first:

```sh
pnpm --filter @nyx/shared build && pnpm --filter @nyx/harness-core build
```

### Environment and database

```sh
cp .env.example .env     # then edit values locally; never commit .env
docker compose up -d db  # PostgreSQL for the API
pnpm db:migrate
pnpm db:seed
```

`.env.example` documents each variable. Secrets must stay in your local `.env` or your shell; the repository is scanned for leaked secrets (`.gitleaks.toml`).

Seed lifecycle pipelines when testing pipeline work:

```sh
pnpm --filter @nyx/api exec tsx src/db/seed-lifecycles.ts
```

### End-to-end tests

```sh
pnpm exec playwright install
pnpm test:smoke       # quick smoke subset
pnpm test:e2e         # full suite
```

## Trying the MCP server and CLI

- TypeScript MCP server: `packages/mcp-server` (binary `@nyx/mcp-server`); CLI: `packages/cli` (`@nyx/cli`). Build with `pnpm build`.
- Rust CLI: `cargo run -p nyx-cli -- --help`. The Rust MCP server (`crates/nyx-mcp`) is a stub until its transport lands.

## Troubleshooting

- Rust build fails on Linux for `nyx-desktop`: install the webview libraries above, or use plain `cargo build` which skips it.
- `pnpm install --frozen-lockfile` fails: the lockfile is out of date relative to a `package.json`; run `pnpm install` and commit the lockfile with your dependency change.
- Stale build output: delete `dist/` in the affected package and rebuild.
