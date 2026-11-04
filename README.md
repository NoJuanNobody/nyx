# Nyx

**Open-source, agent-native knowledge workspace: specs, code and tickets kept in sync, driven by your own coding agents.**

Nyx keeps technical documentation aligned with the code it describes. Instead of embedding its own AI assistant, Nyx exposes its operations to the agents you already use (Claude Code, Cursor, scripts) through the Model Context Protocol (MCP) and a CLI. Heavy operations are metered with local utility-token credits that you grant and budget per agent.

> **Status: pre-release, in transition.** Nyx started as a hosted SaaS (React + Fastify + Postgres). It is being rebuilt as a local-first desktop app with a pure-Rust core (Tauri 2). The Rust workspace is a compiling skeleton (core types, ledger, store, CLI and MCP stubs, desktop shell). The TypeScript apps are the legacy implementation and remain runnable while features are ported. The in-app agent, the AI chat sidebar and Stripe billing have been removed and will not be ported. Expect breaking changes.

---

## What changed

| Before (SaaS) | Now (open source) |
| --- | --- |
| Paid hosted service, Stripe plans | Self-hosted / local-first, no billing code |
| In-app agent and AI chat sidebar | Removed. Bring your own agent over MCP or CLI |
| Credits sold in packs and plans | Credits are agent-native utility tokens, never sold (see below) |
| Node/Fastify backend | Rust core crate shared by desktop app, CLI and MCP server |

## Architecture

```
nyx/
├── Cargo.toml              # Rust workspace root
├── crates/
│   ├── nyx-core/           # Pure-Rust core: model, store, credit ledger, errors. No UI.
│   ├── nyx-cli/            # `nyx` command-line interface (clap)
│   └── nyx-mcp/            # MCP server (stub; transport not implemented yet)
├── apps/
│   ├── desktop/            # Tauri 2 desktop shell (src-tauri) + placeholder UI
│   ├── web/                # Legacy React 19 frontend (Vite), source for the UI port
│   └── api/                # Legacy Fastify + Drizzle + PostgreSQL backend
├── packages/
│   ├── shared/             # Legacy shared TS types
│   ├── harness-core/       # Legacy TS harness
│   ├── mcp-server/         # Legacy TS MCP server (talks to the legacy API)
│   └── cli/                # Legacy TS CLI (`@nyx/cli`)
└── docs/                   # ADRs, credit spec, Rust workspace notes, OSS audit
```

The design goal is one core crate (`nyx-core`) that the desktop app, the CLI and the MCP server all call, so behaviour is identical across the three surfaces. Decision record: [ADR 0001](./docs/adr/0001-tauri-2-rust-core.md). Workspace details: [docs/rust-workspace.md](./docs/rust-workspace.md).

## Quick start: Rust workspace

Requirements: Rust (the pinned toolchain in `rust-toolchain.toml` is picked up automatically).

```bash
git clone https://github.com/NoJuanNobody/nyx.git
cd nyx

cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
cargo run -p nyx-cli -- --version
```

Plain `cargo build` / `cargo test` cover `nyx-core`, `nyx-cli` and `nyx-mcp` only. The desktop crate needs system webview libraries on Linux (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, ...); include it with `--workspace` or `-p nyx-desktop`. To run the desktop shell:

```bash
cargo install tauri-cli --version "^2"
cd apps/desktop/src-tauri && cargo tauri dev
```

## Quick start: legacy TypeScript apps

Requirements: Node.js 20+, pnpm 9.15+, PostgreSQL 15+ (or `docker compose up` using the bundled `docker-compose.yml`).

```bash
pnpm install
cp .env.example .env     # then edit; see the notes below
pnpm db:migrate
pnpm dev                 # web on http://localhost:5173, API on http://localhost:3001
```

Notes:

- `DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5432/nyx` in development.
- `.env.example` still lists variables for integrations that are being cleaned up (auth provider, LLM providers, third-party OAuth). Only `DATABASE_URL` and the server settings are needed for most local work; the rest is optional and slated for removal or env-driven config.
- Useful commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test:e2e`, `pnpm --filter web dev`, `pnpm --filter api dev`, `pnpm db:generate`, `pnpm db:studio`.

## Agent-native usage (MCP and CLI)

Nyx is meant to be operated by external agents, not by an assistant embedded in the app.

**CLI.** The Rust `nyx` binary (`crates/nyx-cli`) is the target surface and currently only prints a version/hello line. The legacy TypeScript CLI (`packages/cli`, `@nyx/cli`) wraps the legacy API.

**MCP.** The Rust MCP server (`crates/nyx-mcp`) is a stub: the stdio transport and tools backed by `nyx-core` are not implemented yet. Until then you can run the legacy TypeScript MCP server against a local API:

```bash
pnpm --filter @nyx/mcp-server build
```

```json
{
  "mcpServers": {
    "nyx": {
      "command": "node",
      "args": ["/absolute/path/to/nyx/packages/mcp-server/dist/index.js"],
      "env": { "NYX_API_KEY": "<your key>", "NYX_API_URL": "http://localhost:3001" }
    }
  }
}
```

Config files: Claude Code `.mcp.json`; Claude Desktop `claude_desktop_config.json`; Cursor Settings, MCP. The hosted `nyx-creative.com` endpoint is not part of the open-source project; point clients at your own instance.

## Credits are utility tokens

Credits are a local metering and budgeting unit for agents:

- Never sold. No checkout, packs, prices or plans, and no fiat value.
- Non-transferable and non-expiring; they only come from an explicit grant by the workspace owner.
- The owner allocates a budget to each agent identity (`claude-code`, `cursor`, ...). Agents `reserve` credits before a compute-heavy operation (scan, generation, drift check, ticket generation) and `commit` or `release` afterwards. Exhausted budgets return a structured `insufficient_credits` error.
- The ledger is append-only, idempotent and hash-chained for auditability.

Full specification: [docs/credits/utility-tokens-spec.md](./docs/credits/utility-tokens-spec.md). The Rust implementation lives in `crates/nyx-core` (`ledger.rs`); a reference TypeScript implementation is in `apps/api/src/services/credit-ledger.service.ts`.

## Documentation

- [Rust workspace](./docs/rust-workspace.md)
- [ADR 0001: Tauri 2 and a Rust core](./docs/adr/0001-tauri-2-rust-core.md)
- [Credits as utility tokens](./docs/credits/utility-tokens-spec.md)
- [Repository audit before open-sourcing](./docs/oss/repo-audit.md)
- [Dependency license inventory](./docs/oss/dependency-license-inventory.md)
- [License decision memo](./docs/oss/license-decision.md)
- [License apply checklist](./docs/oss/license-apply-checklist.md)
- [Feature notes](./docs/features) and [in-app feedback](./docs/feedback-feature.md) (legacy)

## Contributing

The project is pre-release and the architecture is still moving. Open an issue before large changes. Run the gates before sending a patch: `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, and for TypeScript `pnpm typecheck && pnpm test`. A DCO sign-off (`git commit -s`) is the proposed contribution mechanism, pending the license decision.

## License

**Pending.** The license has not been chosen yet; see [docs/oss/license-decision.md](./docs/oss/license-decision.md). Until a `LICENSE` file is added to this repository, no license is granted and all rights are reserved.

<!-- LICENSE-PLACEHOLDER: once Alejandro decides, replace this section with
     "Licensed under <SPDX-ID>. See LICENSE." and follow docs/oss/license-apply-checklist.md. -->

---

*Created by [Alejandro Londono](https://github.com/NoJuanNobody)*
