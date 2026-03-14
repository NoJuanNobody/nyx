# Agent Tool Selection: Edit vs. Create Ticket

## Overview

The SyncDocs AI agent has two distinct classes of action tools:

- **Document editing** (`update_document`) — improves the content of a spec in place
- **Ticket creation** (`create_ticket`) — creates a GitHub issue or Jira ticket linked to a document

These tools serve different user intents and should never be substituted for one another. This document describes how the agent decides which tool to use, how the boundary is enforced, and what each workflow is expected to produce.

---

## The Problem (Issue #74)

The agent was observed editing document content in situations where the intended outcome was ticket creation. The root causes were:

1. **Ambiguous workflow prompts** — `full_spec_review` and `change_impact_analysis` used language like "recommend tickets" and "suggest tickets", which the LLM interpreted as _write suggestions in the report text_ rather than _call `create_ticket`_.
2. **All tools exposed in ad-hoc mode** — when no `workflowId` is provided, every tool (including `update_document`) is passed to the model with a generic system prompt that doesn't distinguish editing intent from ticketing intent.
3. **Underspecified tool descriptions** — neither `update_document` nor `create_ticket` told the model _when_ to prefer one over the other.

---

## How Tool Selection Works

### Workflow-scoped sessions (`workflowId` provided)

Each workflow in `apps/api/src/services/agent/workflows.ts` declares an explicit `tools` allowlist. The agent can only call tools in that list — others are never sent to the model.

| Workflow | Can edit doc? | Can create tickets? |
|---|---|---|
| `full_spec_review` | No | Yes |
| `change_impact_analysis` | No | Yes |
| `codebase_sync_check` | No | No |
| `doc_generation` | Yes | No |

This means a `full_spec_review` session is structurally prevented from calling `update_document` — the LLM never sees it.

### Ad-hoc sessions (no `workflowId`)

When the agent is invoked without a workflow, all tools are available. The system prompt (`apps/api/src/routes/agent.ts:47-48`) must guide the model. Without explicit guidance, the LLM will use whichever tool seems most natural for the user's free-text prompt.

---

## Prompt Guidelines for Each Intent

### "Improve this document"

Use the `doc_generation` workflow, or an ad-hoc prompt that includes explicit direction:

> Use `update_document` to improve the content of this spec. Do not create tickets — focus on making the document clearer and more complete.

### "Find issues and create tickets for them"

Use `full_spec_review` or `change_impact_analysis` with a `workflowId`. The system prompts for these workflows must instruct the agent to **call `create_ticket`** for each actionable item found — not to describe them in narrative text.

Correct prompt phrasing:
```
Call `create_ticket` for each actionable item found during the review.
Do not use `update_document` in this workflow.
```

Incorrect (ambiguous) phrasing:
```
Recommend tickets to create for any issues found.   ← agent writes text, doesn't call tool
Suggest specific tickets for implementing changes.  ← same problem
```

---

## Tool Descriptions

### `update_document`

```
Update a document's title or content.
Use this only to improve documentation. Do not use this when the goal
is to track action items — use create_ticket instead.
```

### `create_ticket`

```
Create a ticket (GitHub issue or Jira) linked to a document.
Call this for each discrete actionable item found during a review or
impact analysis. Do not summarise tickets in text — call this tool.
```

---

## Workflow Prompt Reference

### `full_spec_review`

Step 5 of the system prompt must read:

```
5. For each actionable issue found:
   - Call `create_ticket` with a clear title and description.
   - Do not use `update_document` — ticket creation is the only write action in this workflow.
   Finish with a summary report listing the tickets you created.
```

### `change_impact_analysis`

Step 5 of the system prompt must read:

```
5. For each code area that needs to change:
   - Call `create_ticket` with the specific change required, affected files, and risk level.
   - Do not modify document content.
```

---

## Verifying Correct Behavior

When running a `full_spec_review` or `change_impact_analysis` session, inspect the persisted tool call records (available via `GET /api/agent/:sessionId`). You should see:

- One or more `create_ticket` entries in `toolCalls`
- **No** `update_document` entries

If `update_document` appears in a ticket-creation workflow, the system prompt has regressed or the tool allowlist has been incorrectly expanded.

---

## Related Files

| File | Role |
|---|---|
| `apps/api/src/services/agent/workflows.ts` | Defines workflow system prompts and tool allowlists |
| `apps/api/src/services/agent/tools.ts` | Tool schemas and `getToolDefinitions()` |
| `apps/api/src/routes/agent.ts` | Wires workflow → system prompt → tool list |
| `apps/api/src/services/agent/loop.ts` | Core agentic loop; passes tools to Claude API |
