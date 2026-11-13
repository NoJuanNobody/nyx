# Nyx / SyncDocs

**One platform for the whole product lifecycle — concept, PRD, architecture, specs, and code — kept in sync forever.**

> **Status:** Private beta. Staging lives at [syncdocs-staging.vercel.app](https://syncdocs-staging.vercel.app).

---

## What is Nyx?

Nyx (formerly SyncDocs) unifies every stage of building a product in one place. Ideas become PRDs, PRDs become architecture and specs, and specs become code. Nyx tracks the links between all of them, so a change at any stage is visible at every other stage.

See [Lifecycle Stages](./lifecycle-stages.md) for how documents move from conception to code, and [System Architecture](./system-architecture.md) for how the platform is built.

---

## The Problem: Spec Drift

Product docs are written once and the codebase keeps moving. Within weeks the PRD, the architecture doc, and the specs describe a product that no longer exists. In AI-assisted development this is worse: the spec is the input to code generation, so a stale spec produces wrong code.

Teams end up with two sources of truth that silently disagree:

| Source | Who trusts it | What goes wrong |
| --- | --- | --- |
| Product docs | PMs, designers, stakeholders | Describe intent that the code has moved past |
| Codebase | Engineers, coding agents | Holds decisions that never made it back into the docs |

---

## The Core Concept: A Living Codebase

Nyx treats docs and code as one versioned system instead of two:

- **Docs to code:** an approved spec change becomes tickets and flows into the codebase (GitHub Issues, Jira, or a coding agent via MCP).
- **Code to docs:** the Live Sync Engine watches the repo and flags drift when code changes without its spec.
- **One history:** docs, tickets, and code share a timeline with diffs, snapshots, rollback, and attribution.

The result is a codebase that stays explainable at every stage, by anyone on the team.

---

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | Vite + React (`apps/web`) |
| Backend | Fastify (`apps/api`) |
| Monorepo | Turborepo + pnpm workspaces |
| Database | PostgreSQL via Drizzle ORM |

Full details are in the [README](../README.md#tech-stack).

---

## Local Development

```bash
pnpm install

# Set up the database
pnpm db:migrate
pnpm db:seed      # optional sample data

# Start frontend + backend
pnpm dev
```

| Service | URL |
| --- | --- |
| Frontend (Vite) | http://localhost:5173 |
| Backend (Fastify) | http://localhost:3001 |

Environment setup is covered in the [README](../README.md#3-configure-environment-variables).

---

## Running Tests

```bash
# Unit + integration tests, all packages (via Turborepo)
pnpm test

# Per app
pnpm --filter web test
pnpm --filter api test

# End-to-end (Playwright)
pnpm test:e2e
```

---

*Built by [Alejandro Londono](https://github.com/NoJuanNobody)*
