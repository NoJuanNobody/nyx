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

---

## E2E Tests

**Test file:** `tests/e2e/unified-ai-panel.spec.ts`

### Panel rendering & tab consolidation

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Single "AI" tab in DocDrawer | Open a document → open DocDrawer | Only one "AI" tab visible; no separate "Agent" tab |
| 2 | Panel shows workflow selector | Click AI tab in DocDrawer | Workflow selector dropdown visible with "Quick edit" option and workflows from `/agent/workflows` |
| 3 | Suggestion prompts shown when empty | Open AI tab with no prior messages | Context-aware suggestion pills displayed (carried from AIChatPanel behavior) |
| 4 | Input area with send button | Open AI tab | Auto-resizing textarea visible with Send button |

### Quick edit (fast path)

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 5 | Quick edit via workflow selector | Select "Quick edit" from workflow dropdown → type "Make the intro shorter" → Send | Request sent to `POST /ai/edit-document` (not `/api/agent`); proposed edit shown as diff block with Accept/Reject buttons |
| 6 | Accept proposed edit | Trigger quick edit → click Accept on diff block | Document content updates with proposed changes; diff block replaced with success message |
| 7 | Reject proposed edit | Trigger quick edit → click Reject | Diff block dismissed; document unchanged; user can type a new prompt |
| 8 | Auto-detection routes simple edits to fast path | Leave workflow on "Freeform" → type "fix the typos in paragraph 2" → Send | Request sent to `/ai/edit-document` (auto-detected as simple edit); result shown as diff |

### Agent workflow (SSE path)

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 9 | Freeform prompt uses agent SSE | Type "Analyze this spec and suggest improvements" → Send | Request sent to `POST /api/agent` via SSE; assistant text streams in real-time in chat area |
| 10 | Selected workflow uses agent SSE | Select a predefined workflow → type prompt → Send | SSE stream starts; workflow-specific tool calls appear |
| 11 | Tool calls shown as collapsible cards | Agent makes tool calls during workflow | Each tool call rendered as collapsible card showing: tool name, input, output, duration |
| 12 | SSE streaming cancellation | Start a workflow → click Cancel button during streaming | SSE stream aborted (AbortController); partial response preserved in chat; status shows "Cancelled" |
| 13 | Status bar shows during streaming | Start agent workflow | Status badge shows "Running" with token usage counter; hidden when idle |

### `update_document` tool interception

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 14 | Agent update_document shows diff | Start workflow that triggers `update_document` tool call | Diff view rendered inline in chat (current content vs proposed); Accept/Reject buttons shown |
| 15 | Accept agent-proposed edit | Agent proposes edit via `update_document` → click Accept | Document content updated; success returned to agent; agent continues workflow |
| 16 | Reject agent-proposed edit | Agent proposes edit → click Reject | Rejection message returned to agent; agent adjusts and may propose alternative |

### Chat history & messages

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 17 | User messages rendered as bubbles | Send multiple prompts | Each user message appears as a styled bubble |
| 18 | Assistant messages stream in | Agent responds with text | Text appears incrementally (streaming), rendered as markdown |
| 19 | Chat history preserved in session | Send prompt → get response → send another prompt | Previous messages still visible above; full conversation thread maintained |
| 20 | New document shows generation flow | Open AI tab on a brand new (empty) document | "Generate document" option or suggestion prompt visible; generation result populates document |

### Error handling

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 21 | API error shows inline message | Mock AI endpoint to return 500 → send prompt | Error message displayed in chat area; user can retry |
| 22 | Network timeout handling | Mock slow response exceeding timeout → send prompt | Timeout error shown; cancel button works; user can retry |
