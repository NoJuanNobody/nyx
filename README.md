# SyncDocs

**The product versioning platform — unified documentation, code, and team workflow, always in sync.**

SyncDocs keeps technical specs in sync with code as it evolves and lets non-technical stakeholders initiate changes that flow automatically through to the codebase.

---

## What is SyncDocs?

In AI-assisted development, the spec is the starting point — developers write documents and AI tools generate code from them. But as code evolves, the original spec becomes stale almost immediately. There is no feedback loop.

SyncDocs solves this by providing a two-way bridge between intent (documentation) and implementation (code), with a collaboration layer that connects technical and non-technical team members.

---

## Core Features

| Feature | Description |
| --- | --- |
| **AI-Ready Spec Editor** | Structured markdown editor with AI assistance for writing technical specs optimized for code generation. Supports branch-based collaboration and approval flows. |
| **Live Sync Engine** | Monitors your codebase via GitHub integration and surfaces drift between documentation and code. |
| **Non-Dev Change Flow** | Non-technical users edit documentation; AI groups changes into tickets; tickets are pushed to GitHub Issues or Jira with full traceability. |
| **Product Version Control** | Git-like history across docs, tickets, and code — diff view, unified timeline, named snapshots, full rollback, and blame/attribution. |
| **Coding Agent Integrations** | MCP server for Claude Code so specs flow directly into your AI coding workflow. Cursor and Copilot integrations planned. |
| **Onboarding Flow** | Scans an existing codebase to bootstrap documentation for teams already in flight. |
| **Documentation Export** | Export documentation as Markdown or PDF — no vendor lock-in. |

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + TypeScript, Vite, Tailwind CSS |
| Backend | Node.js + Fastify, TypeScript |
| Database | PostgreSQL via Drizzle ORM |
| AI | Anthropic Claude API |
| Auth | Clerk |
| Integrations | GitHub API + Webhooks, Jira REST API, Confluence REST API |
| Agent Integration | MCP server (`@syncdocs/mcp-server`) |
| Monorepo | pnpm workspaces + Turborepo |

---

## Project Structure

```
syncdocs/
├── apps/
│   ├── web/          # React frontend (Vite)
│   └── api/          # Fastify backend
├── packages/
│   ├── shared/       # Shared types and utilities
│   └── mcp-server/   # MCP server for Claude Code integration
└── package.json      # Root workspace config
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v9.15.4+ (`npm install -g pnpm`)
- [PostgreSQL](https://www.postgresql.org/) v15+ running locally (or a connection URL)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/NoJuanNobody/syncdocs.git
cd syncdocs
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

Create a `.env` file in the repository root:

```bash
cp .env.example .env   # if .env.example exists, otherwise create manually
```

Edit `.env` with your values:

```env
# Database (required)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/syncdocs

# Server
PORT=3001
HOST=0.0.0.0
NODE_ENV=development

# Anthropic (required for AI features)
ANTHROPIC_API_KEY=sk-ant-...

# Clerk Auth (required for authentication)
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...

# GitHub Integration (optional for local dev)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_WEBHOOK_SECRET=

# Webhook base URL (optional — used to register GitHub webhooks)
WEBHOOK_BASE_URL=https://your-tunnel-url.ngrok.io
```

> **Note:** `DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5432/syncdocs` in development if not set.

### 4. Set up the database

```bash
# Run migrations
pnpm db:migrate

# (Optional) Seed with sample data
pnpm db:seed
```

### 5. Start the development servers

```bash
pnpm dev
```

This starts both the frontend and backend concurrently via Turborepo:

| Service | URL |
| --- | --- |
| Frontend (Vite) | http://localhost:5173 |
| Backend (Fastify) | http://localhost:3001 |

To run only one app:

```bash
# Frontend only
pnpm --filter web dev

# Backend only
pnpm --filter api dev
```

---

## Running Tests

### All tests (unit + integration)

```bash
pnpm test
```

### Per app

```bash
# Frontend tests
pnpm --filter web test

# Backend tests
pnpm --filter api test
```

### End-to-end tests (Playwright)

```bash
pnpm test:e2e
```

### With coverage

```bash
pnpm --filter api test -- --coverage
pnpm --filter web test -- --coverage
```

---

## Database Management

```bash
# Generate a new migration after schema changes
pnpm db:generate

# Apply pending migrations
pnpm db:migrate

# Open Drizzle Studio (database UI)
pnpm db:studio

# Seed the database with sample data
pnpm db:seed
```

---

## Other Commands

```bash
# Type-check all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Check formatting
pnpm format:check

# Build for production
pnpm build
```

---

## MCP Server (Claude Code Integration)

SyncDocs ships an MCP server that exposes your documents and AI features directly into Claude Code.

```bash
# Build the MCP server
pnpm --filter @syncdocs/mcp-server build
```

Add it to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "syncdocs": {
      "command": "node",
      "args": ["/path/to/syncdocs/packages/mcp-server/dist/index.js"]
    }
  }
}
```

---

## Deployment

| Service | Platform |
| --- | --- |
| Frontend | [Vercel](https://vercel.com) — deploy `apps/web` |
| Backend | [Railway](https://railway.app) or [Render](https://render.com) — deploy `apps/api` |
| Database | Managed PostgreSQL (Railway, Render, Supabase, Neon) |

Set the same environment variables from the [setup section](#3-configure-environment-variables) in your deployment platform.

---

## Contributing

This project is in active development. See the [product brief](./SyncDocs_ProductBrief.md) for the full vision and roadmap.

---

*Built by [Alejandro Londono](https://github.com/NoJuanNobody)*
