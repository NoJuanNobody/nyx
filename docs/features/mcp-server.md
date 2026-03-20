# Nyx MCP Server

The Nyx MCP (Model Context Protocol) server wraps the Nyx REST API so that Claude — and any other MCP-compatible coding agent (Cursor, Copilot, etc.) — can read, write, and analyze Nyx documents directly inside the IDE without leaving the coding context.

---

## 1. Current State

`packages/mcp-server` already ships a working scaffold built on `@modelcontextprotocol/sdk`. It supports:

### 1.1 Implemented Tools

| Tool | API endpoint | What it does |
|---|---|---|
| `nyx_search_docs` | `GET /api/documents?teamId=…` | List all documents for a team |
| `nyx_read_doc` | `GET /api/documents/:id` | Fetch full document content and metadata |
| `nyx_create_doc` | `POST /api/documents` | Create a new document |
| `nyx_update_doc` | `PUT /api/documents/:id` | Update document title or content |
| `nyx_check_quality` | `POST /api/ai/analyze` | AI quality score and suggestions (1–10) |
| `nyx_detect_drift` | `POST /api/ai/detect-drift` | Detect spec-vs-code drift |
| `nyx_create_ticket` | `POST /api/documents/:id/tickets` | Push a GitHub Issue or Jira ticket |
| `nyx_get_timeline` | `GET /api/documents/:id/timeline` | Full event timeline for a document |
| `nyx_web_search` | (external) | Web search scoped to docs/APIs/changelogs |
| `nyx_join_meeting` | `POST /api/voice/join` | Join a Zoom / Meet / Teams call with the voice agent |
| `nyx_leave_meeting` | `POST /api/voice/leave` | Remove voice agent from a session |
| `nyx_meeting_status` | `GET /api/voice/status/:id` | Poll session state |
| `nyx_generate_meeting_doc` | `POST /api/voice/documents/from-meeting` | Generate a doc from a meeting transcript |

### 1.2 Implemented Resources

| URI template | Content |
|---|---|
| `nyx://docs` | JSON list of all documents |
| `nyx://docs/{id}` | Markdown content of a specific document |
| `nyx://docs/{id}/versions` | JSON version history |

### 1.3 Authentication

The server reads two env vars at startup:

- `NYX_API_KEY` — a `Bearer` token (created in Nyx → Settings → API Keys)
- `NYX_API_URL` — defaults to `http://localhost:3001`

---

## 2. Gaps & Planned Additions

### 2.1 Missing Tools

The following API routes exist but are not yet exposed as MCP tools.

#### Document branches

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_list_branches` | `GET /api/documents/:id/branches` | List branches for a document |
| `nyx_create_branch` | `POST /api/documents/:id/branches` | Create a branch from a base version |
| `nyx_update_branch` | `PUT /api/documents/:id/branches/:branchId` | Push edits to a branch |
| `nyx_merge_branch` | `POST /api/documents/:id/branches/:branchId/merge` | Merge a branch back to trunk |

Branches are how non-technical stakeholders propose changes without touching the main document. Exposing them via MCP lets Claude draft a branch, edit it, and submit it for review — all from the IDE.

#### Document versions & diffs

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_list_versions` | `GET /api/documents/:id/versions` | List version history |
| `nyx_get_version` | `GET /api/documents/:id/versions/:versionId` | Read a specific version snapshot |
| `nyx_diff_versions` | `GET /api/documents/:id/versions/:a/diff/:b` | Get a structured diff between two versions |

#### Change proposals

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_generate_change_proposal` | `POST /api/documents/:id/change-proposals/generate` | AI-generate a change proposal from the current doc state |
| `nyx_list_change_proposals` | `GET /api/documents/:id/change-proposals` | List open proposals |
| `nyx_approve_change_proposal` | `POST /api/change-proposals/:id/approve` | Approve a proposal |
| `nyx_reject_change_proposal` | `POST /api/change-proposals/:id/reject` | Reject a proposal |

#### Snapshots

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_create_snapshot` | `POST /api/documents/:id/snapshots` | Capture a named snapshot of the current doc state |
| `nyx_list_snapshots` | `GET /api/documents/:id/snapshots` | List all snapshots |

#### Full-text search

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_full_search` | `GET /api/search?q=…&teamId=…` | Full-text search across all team documents |

This is distinct from `nyx_search_docs` (which just lists documents) — it runs a keyword search across document content.

#### Export

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_export_doc` | `GET /api/documents/:id/export?format=markdown\|pdf` | Export a document to markdown or PDF |

Useful for Claude to hand the user a downloadable artefact at the end of a session.

#### Agent sessions

| Tool | API endpoint | Description |
|---|---|---|
| `nyx_run_agent` | `POST /api/agent` (SSE) | Start a Nyx agent workflow and stream events back |

This lets Claude invoke a Nyx orchestration workflow (e.g. "Spec Audit" or "Drift Review") and surface the streamed results as tool output.

### 2.2 Missing Resources

| URI template | Description |
|---|---|
| `nyx://teams` | List teams the authenticated user belongs to |
| `nyx://docs/{id}/branches` | List branches for a document |
| `nyx://docs/{id}/snapshots` | List snapshots for a document |

### 2.3 Prompts (not yet implemented)

MCP supports [Prompts](https://modelcontextprotocol.io/docs/concepts/prompts) — named, parameterized prompt templates that the host surfaces to users. Useful ones:

| Prompt name | Parameters | Purpose |
|---|---|---|
| `spec_audit` | `document_id` | "Analyse this spec and flag gaps, ambiguities, and drift risk" |
| `draft_ticket` | `document_id`, `area` | "Draft a GitHub Issue for the most urgent gap in this spec" |
| `onboard_codebase` | `repo_url`, `team_id` | "Scan this repo and bootstrap Nyx documentation from the code" |

---

## 3. Implementation Plan

### Phase 1 — Tool coverage (all existing API routes)

**Goal:** Every stable Nyx API endpoint has a corresponding MCP tool.

1. Add branch tools (`nyx_list_branches`, `nyx_create_branch`, `nyx_update_branch`, `nyx_merge_branch`) to `tools.ts` and `executeTool`.
2. Add version tools (`nyx_list_versions`, `nyx_get_version`, `nyx_diff_versions`).
3. Add change-proposal tools.
4. Add snapshot tools.
5. Add `nyx_full_search`.
6. Add `nyx_export_doc`.
7. Add `nyx_run_agent` — stream SSE events and return a consolidated summary as text (MCP tools are request/response; buffer the stream server-side).
8. Update `RESOURCE_TEMPLATES` and `resolveResource` with the new resource URIs.
9. Write unit tests for each new handler in `src/__tests__/`.

**Files touched:** `packages/mcp-server/src/tools.ts`, `packages/mcp-server/src/resources.ts`, new test files.

### Phase 2 — Prompts

1. Add `prompts` capability to the `Server` constructor options.
2. Register `ListPromptsRequestSchema` and `GetPromptRequestSchema` handlers in `server.ts`.
3. Define `PROMPT_DEFINITIONS` in a new `prompts.ts` file with the templates from §2.3.

**Files touched:** `packages/mcp-server/src/server.ts`, new `packages/mcp-server/src/prompts.ts`.

### Phase 3 — HTTP transport (optional, for remote use)

The current server uses stdio, which requires the binary to run on the same machine as the agent. For teams using Claude.ai or remote Cursor, an HTTP+SSE transport is more convenient.

1. Add `@modelcontextprotocol/sdk/server/sse.js` transport support alongside stdio.
2. Accept an `--http` flag or `NYX_MCP_PORT` env var to switch transports.
3. Add `/mcp` route mounting to `apps/api/src/app.ts` so the MCP server can run in-process alongside the Fastify API (simplifies deployment on Railway/Render).
4. Add auth middleware to the SSE endpoint (validate `Authorization: Bearer <NYX_API_KEY>`).

**Files touched:** `packages/mcp-server/src/index.ts`, `apps/api/src/app.ts`.

### Phase 4 — Publishing & distribution

1. Bump `packages/mcp-server/package.json` version to `1.0.0`.
2. Add a `prepare` script to run `tsc` pre-publish.
3. Publish `@nyx/mcp-server` to npm so users can install via:
   ```bash
   npx @nyx/mcp-server
   ```
4. Ship a `claude_mcp_config.json` example in `packages/mcp-server/` for one-click Claude Code setup.

---

## 4. Configuration Guide

### Claude Code (current)

Add to `~/.claude/mcp_servers.json` or `claude_mcp_config.json` at the project root:

```json
{
  "mcpServers": {
    "nyx": {
      "command": "npx",
      "args": ["@nyx/mcp-server"],
      "env": {
        "NYX_API_KEY": "sd_your_api_key_here",
        "NYX_API_URL": "https://api.nyx.app"
      }
    }
  }
}
```

### Cursor

Open **Settings → Features → MCP** and add the same server block.

### Local development

```bash
NYX_API_KEY=sd_dev NYX_API_URL=http://localhost:3001 pnpm --filter @nyx/mcp-server exec tsx src/index.ts
```

---

## 5. Testing Strategy

- **Unit tests** (`vitest`): each `executeTool` case mocks `apiRequest` and asserts the correct endpoint and payload — follow the pattern in `src/__tests__/web-search.tool.test.ts`.
- **Integration test**: spin up the Fastify API against the test database (as in `apps/api/src/__tests__/`), then run the MCP server in a subprocess and call tools via the MCP client SDK to verify end-to-end.
- **CI**: `pnpm --filter @nyx/mcp-server test` is already wired into the Turborepo build graph.

---

## 6. Open Questions

| Question | Decision needed by |
|---|---|
| Should `nyx_run_agent` buffer the full SSE stream or return a streaming response? MCP 1.x tools are request/response; streaming requires MCP 2.x or a workaround. | Before Phase 1 |
| HTTP transport: run MCP in-process with Fastify, or as a separate service? In-process is simpler but couples deployments. | Before Phase 3 |
| Should `nyx_export_doc` (PDF) return base64-encoded content in the tool response, or a signed URL? | Before Phase 1 |
| Scope of `nyx://docs` resource listing — currently requires no teamId, but the API does. Should the resource require a query param or pick up the user's default team? | Before Phase 2 |
