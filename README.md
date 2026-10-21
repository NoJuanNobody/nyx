# Nyx

**Nyx is a web app for product teams that turns a rough idea into staged spec documents, pushes approved spec changes out as GitHub or Jira tickets, and flags when pushed code drifts from those docs.**

[![Nyx explainer video: one idea from spec to drift check](docs/explainer/poster.png)](https://nojuannobody.github.io/nyx/explainer/explainer.mp4)

[▶ Watch the 60-second explainer](https://nojuannobody.github.io/nyx/explainer/explainer.mp4) · [Read the one-page explainer](https://nojuannobody.github.io/nyx/explainer/)

### How it works for you

1. **Describe the idea.** Type it in plain words on the Intake page; AI returns a spec with a user story, acceptance criteria, edge cases and open questions.
2. **Save it as a staged document.** Give it one of five optional stages (Conception, Definition, Architecture, Implementation, Execution) and edit it in the AI-assisted editor.
3. **Seed the next stage.** One click drafts, for example, the Architecture doc from the Definition doc.
4. **Turn changes into tickets.** New versions of a doc become a change proposal of suggested tickets; untick what you don't want, approve, and push them as GitHub issues (or create single tickets in Jira).
5. **Catch drift.** Connect a GitHub repo; each push triggers an AI drift check that logs a 0–10 drift score on the affected docs' timelines.
6. **Use it from your tools.** The same docs and actions are available in Claude Code or Cursor through the MCP server, and in the terminal through the `nyx` CLI.

---

**The product versioning platform — unified documentation, code, and team workflow, always in sync.**

Nyx keeps technical specs in sync with code as it evolves and lets non-technical stakeholders initiate changes that flow automatically through to the codebase.

---

## What is Nyx?

In AI-assisted development, the spec is the starting point — developers write documents and AI tools generate code from them. But as code evolves, the original spec becomes stale almost immediately. There is no feedback loop.

Nyx solves this by providing a two-way bridge between intent (documentation) and implementation (code), with a collaboration layer that connects technical and non-technical team members.

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
| Agent Integration | MCP server (`@nyx/mcp-server`) |
| Monorepo | pnpm workspaces + Turborepo |

---

## Project Structure

```
nyx/
├── apps/
│   ├── web/          # React frontend (Vite)
│   └── api/          # Fastify backend
├── packages/
│   ├── shared/       # Shared types and utilities
│   ├── mcp-server/   # MCP server for Claude Code integration
│   ├── cli/          # `nyx` command-line client for the API
│   └── harness-core/ # Model-agnostic Nyx tool definitions and API client
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
git clone https://github.com/NoJuanNobody/nyx.git
cd nyx
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
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nyx

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

> **Note:** `DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5432/nyx` in development if not set.

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

Nyx exposes your documents and AI features directly into Claude Code, Cursor, and Claude Desktop via the **Model Context Protocol (MCP)**.

### Connect via URL (recommended)

The hosted MCP endpoint uses a browser login — no API key to copy, no local build, no path configuration. Tool usage draws on your account credits.

1. Copy your MCP endpoint URL (**Settings → API Keys**): `https://<your-api-host>/api/mcp`
2. Connect in one command:

```bash
claude mcp add --transport http nyx https://<your-api-host>/api/mcp
```

3. Run `/mcp` in Claude Code and complete the browser login when prompted.

The same URL works in Cursor (Settings → MCP → Add server URL) and Claude Desktop.

> **OAuth login:** The endpoint authenticates via Clerk (OAuth 2.1). Your MCP client discovers the flow from `GET /.well-known/oauth-protected-resource` and signs you in through the browser — no token to paste. AI/generation tools consume account credits per call.

### Local development (stdio)

For offline use or local dev, run the MCP server as a local process.

```bash
# Build the local MCP server
pnpm --filter @nyx/mcp-server build
```

Then add it to your client config:

```json
{
  "mcpServers": {
    "nyx": {
      "command": "node",
      "args": ["/absolute/path/to/nyx/packages/mcp-server/dist/index.js"],
      "env": {
        "NYX_API_KEY": "sd_...",
        "NYX_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

Config files: Claude Code → `.mcp.json`; Claude Desktop → `claude_desktop_config.json`; Cursor → Settings → MCP.

---

## Deployment

| Service | Platform |
| --- | --- |
| Frontend | [Vercel](https://vercel.com) — deploy `apps/web` |
| Backend | [Railway](https://railway.app) or [Render](https://render.com) — deploy `apps/api` |
| Database | Managed PostgreSQL (Railway, Render, Supabase, Neon) |

Set the same environment variables from the [setup section](#3-configure-environment-variables) in your deployment platform.

---

## Feature Guides

- [In-App Feedback](./docs/feedback-feature.md) — setup and usage for the user feedback submission feature

---

## Contributing

This project is in active development. See the [product brief](./Nyx_ProductBrief.md) for the full vision and roadmap.

---

*Built by [Alejandro Londono](https://github.com/NoJuanNobody)*
