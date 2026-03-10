# Unified AI Panel (#47)

Merge the two separate AI drawer tabs — **AIChatPanel** (simple edits) and **AgentPanel** (agentic workflows + tool use) — into a single **"AI"** tab in the DocDrawer.

## Why merge?

- Two AI tabs is confusing — users must decide upfront whether their task is "simple" or "agentic" before they've even started.
- Both are chat-style interfaces talking to Claude. The distinction is an implementation detail, not a user concern.
- A single panel can auto-route to the right backend based on what the user asks for (or let them pick a workflow).

## Current state

| Aspect | AIChatPanel | AgentPanel |
|--------|-------------|------------|
| **Purpose** | AI-assisted document editing | General-purpose agent execution |
| **API endpoints** | `/ai/generate-document`, `/ai/edit-document` | `/api/agent`, `/agent/workflows` |
| **Streaming** | No (request/response) | Yes (SSE via `startAgentStream`) |
| **Tool use** | None | Full — collapsible tool call log with I/O |
| **Output** | Chat bubbles with proposed content | Streamed Markdown + tool execution log |
| **Cancellation** | Not supported | Supported (AbortController) |
| **Props** | `content`, `onProposedEdit`, `isNewDocument`, `onGenerate`, `isReviewMode` | `documentId`, `teamId` |
| **State lifecycle** | Simple (loading/ready) | Complex (idle/running/completed/failed/cancelled) |
| **Suggestion prompts** | Yes (context-aware pills) | No (workflow selector instead) |

## Proposed unified UI

### Layout (top to bottom)

1. **Workflow selector** (optional) — dropdown with predefined workflows from `/agent/workflows`, plus a "Quick edit" option that routes to the fast path. Defaults to freeform.
2. **Chat messages area** — scrollable list of user/assistant messages:
   - User messages rendered as bubbles (carried from AIChatPanel)
   - Assistant text streamed in real-time via SSE (carried from AgentPanel)
   - Tool calls shown inline as collapsible cards (name, input, output, duration)
   - Proposed edits shown as an accept/reject diff block (carried from AIChatPanel's `onProposedEdit`)
3. **Suggestion prompts** — context-aware pills shown when chat is empty (carried from AIChatPanel)
4. **Input area** — auto-resizing textarea + send button, with cancel button during streaming
5. **Status bar** — status badge + token usage (from AgentPanel), hidden when idle

### Interaction flow

```
User types prompt
  → If workflow === "Quick edit" (or auto-detected as simple edit):
      POST /ai/edit-document  →  show result as proposed edit diff
  → Else (freeform or selected workflow):
      POST /api/agent (SSE)  →  stream text + tool calls into chat
        → If agent calls `update_document` tool:
            Intercept → show as proposed edit diff (accept/reject)
            User accepts → apply edit via onProposedEdit callback
```

### `update_document` tool interception

When the agent calls `update_document`, instead of applying the change silently:
1. Extract the proposed content from the tool input
2. Render a diff view (current content vs proposed) inline in the chat
3. Show **Accept** / **Reject** buttons
4. On accept: call `onProposedEdit(newContent)` and return success to the agent
5. On reject: return rejection message to the agent so it can adjust

This gives users the same review experience as AIChatPanel's proposed edits, but within the agent workflow.

## Dual backend strategy

No backend changes are needed. The unified panel routes to the appropriate existing endpoint:

| Mode | Endpoint | When to use |
|------|----------|-------------|
| **Fast** | `POST /ai/edit-document` | "Quick edit" workflow or auto-detected simple edits (no tool use needed) |
| **Agent** | `POST /api/agent` (SSE) | Freeform prompts, selected workflows, or any task requiring tool use |

Auto-detection heuristic (optional): if the prompt looks like a direct edit instruction ("make the intro shorter", "fix the typos") and no workflow is selected, route to the fast path. Otherwise default to agent.

## Props interface

Merged from both panels:

```typescript
interface UnifiedAIPanelProps {
  // From AIChatPanel
  content: string;
  onProposedEdit: (newContent: string) => void;
  isNewDocument: boolean;
  onGenerate: (result: { title: string; content: string }) => void;
  isReviewMode: boolean;

  // From AgentPanel
  documentId?: string;
  teamId: string;
}
```

## DocDrawer changes

- Remove `'agent'` from the tab list — the drawer tabs become: `'versions'`, `'timeline'`, `'ai'`, `'audit'`, etc.
- The `'ai'` tab renders `<UnifiedAIPanel>` instead of `<AIChatPanel>`
- Remove the conditional rendering for `activePanel === 'agent'`

## Files to modify

| File | Action |
|------|--------|
| `apps/web/src/components/AIChatPanel.tsx` | Refactor into `UnifiedAIPanel.tsx` (or rename in place) |
| `apps/web/src/components/AgentPanel.tsx` | Merge functionality into UnifiedAIPanel, then **delete** |
| `apps/web/src/components/DocDrawer.tsx` | Remove `'agent'` tab, update `'ai'` tab to use `UnifiedAIPanel` |

## Backend

No backend changes needed. Both `/ai/edit-document` and `/api/agent` endpoints remain as-is. The routing decision is entirely client-side.
