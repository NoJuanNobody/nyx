# Impact Map

A visual graph showing how a document change propagates through the system: from a stakeholder edit to a ticket, to code commits, to drift detection, and back. This is the post-MVP "node intent graph" referenced in the [AI Agent Map feature doc](../features/ai-agent-map.md) and tracked in issue #25.

## Overview

The Impact Map answers the question: *"What actually happened because of this document change?"* It turns the existing linear audit trace chain into an interactive node graph that reveals the full causal tree — who initiated a change, what tickets it spawned, what commits followed, and whether drift was detected or resolved.

It complements, but does not replace, the existing Timeline and Audit Trail panels.

## Data Model

### Existing infrastructure (no schema changes needed for MVP)

The `audit_trail` table already supports causal chaining via `parentEventId`. The `fetchAuditTrace` API (`GET /api/audit-trail/:eventId/trace`) returns a linear chain for a given event. The Impact Map simply needs to extend this into a full DAG traversal.

### New API endpoint

```
GET /api/documents/:documentId/impact-graph
```

Returns a graph-shaped structure (nodes + edges) derived from the document's audit trail:

```typescript
interface ImpactGraph {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

interface ImpactNode {
  id: string;
  eventType: string;     // matches audit_event_type enum
  actorId: string | null;
  actorName: string | null;
  commitSha: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  // AI-inferred fields (optional, populated by background job or on-demand)
  intent: string | null;       // "Stakeholder updated scope — triggered ticket"
  driftFlag: boolean;          // true if this node has no downstream commit within X days
}

interface ImpactEdge {
  id: string;
  source: string;   // node id
  target: string;   // node id
  label?: string;   // "created", "triggered", "resolved", etc.
}
```

**Implementation:** The service walks the `auditTrail` rows for the document, groups them by their `parentEventId` relationships, and builds the graph. Nodes with no parent are roots (typically `doc_edit` events). Edges are inferred from `parentEventId` links.

## UI Architecture

### Primary entry point: DocDrawer "Trace" tab (MVP)

Add a new `trace` panel to `DocDrawer` alongside the existing History, Timeline, Proposals, Audit, AI, and Preview tabs.

```typescript
// apps/web/src/components/DocDrawer.tsx
export type DrawerPanel = 'history' | 'timeline' | 'proposals' | 'audit' | 'ai' | 'jsx-preview' | 'trace';
```

The Trace tab renders `<ImpactMap documentId={documentId} />`.

### Secondary entry point: Standalone `/impact/:documentId` page (post-MVP)

Full-screen graph view with additional filters and AI narrative panel.

### Component structure

```
apps/web/src/
  components/
    ImpactMap.tsx           # Root component — fetches graph, renders mode toggle
    ImpactMapGraph.tsx      # React Flow canvas (opt-in view)
    ImpactMapCards.tsx      # Linear card chain (default view)
    ImpactMapNode.tsx       # Custom React Flow node renderer
  pages/
    ImpactMapPage.tsx       # Standalone full-screen route (post-MVP)
```

### Two rendering modes

**1. Card chain (default — no extra dependencies)**

A vertical list of `ImpactNode` cards connected by arrow lines. Each card shows:
- Event type chip (color-coded, matching existing `EVENT_CONFIG` in `AuditTrail.tsx`)
- Actor name and timestamp
- Key metadata preview (ticket title, commit SHA, drift score, etc.)
- AI-inferred intent (italic, below metadata, only if populated)
- Drift warning badge (amber) if `driftFlag` is true

Parallel branches (nodes with the same parent) are shown side-by-side in a two-column split.

**2. React Flow graph (opt-in toggle)**

A directed acyclic graph rendered with [React Flow](https://reactflow.dev/) + [dagre](https://github.com/dagrejs/dagre) for automatic layout. Nodes use custom renderers matching the card design. Edges are labeled with the relationship type.

Toggle is a small pill button in the panel header: `◻ Cards | ◼ Graph`.

```bash
pnpm --filter @syncdocs/web add reactflow @dagrejs/dagre
```

## AI Assistance

### Intent extraction (on-demand, not blocking)

When a node has no human-authored metadata comment, Claude infers intent from the diff and context:

```
POST /api/documents/:documentId/impact-graph/intents
Body: { nodeIds: string[] }
Response: { intents: Record<string, string> }
```

The frontend fetches this after the graph loads, then merges the intents into the rendered nodes. Intents are cached in the response for 24 hours.

**Prompt:**
> Given this audit event — type: `{{eventType}}`, metadata: `{{metadata}}` — in the context of document "{{documentTitle}}", write one sentence explaining why this event likely occurred. Be specific. Do not speculate beyond what the data implies.

### Drift flagging

An event node is flagged as drifted if its event type is `doc_edit` or `ticket_created` and no downstream `code_commit` node exists within 14 days (configurable). The API computes this server-side and includes `driftFlag: true` in the node.

### AI narrative panel (post-MVP)

A collapsible panel above the graph that renders a Claude-generated prose summary of the entire impact trace: "On March 10, Alejandro edited the spec to add the Impact Map feature. This triggered a ticket in GitHub, which was picked up and committed two days later. No drift was detected."

## Filtering

The panel header includes a filter bar:
- **Time range:** last 7d / 30d / 90d / all
- **Event type:** multi-select chips (matching existing chip design in `Timeline.tsx`)
- **Actor:** dropdown of unique actors in the graph
- **Show drifted only:** toggle

Filters are applied client-side after the graph is fetched.

## Performance

- The graph is paginated at the API level: default `limit=100` nodes, with a `cursor` for deeper traces.
- For graphs with >50 nodes, the card chain renders only the root and direct children by default, with a "Show full trace" expansion button.
- React Flow graph is lazy-loaded via `React.lazy` (not bundled by default).
- Node intents are fetched in a single batch request after the graph renders — not per-node.

## Implementation Plan

### Phase 1 — Backend (API)

1. **`impact-graph.service.ts`** — walks `auditTrail` rows for a document, builds nodes/edges, computes `driftFlag`
2. **`GET /api/documents/:documentId/impact-graph`** — registers the route, applies `requireRole({ minimumRole: 'viewer' })`
3. **`POST /api/documents/:documentId/impact-graph/intents`** — calls Claude to batch-infer intents for requested node IDs
4. **Unit tests** — `__tests__/routes/impact-graph.test.ts`, `__tests__/services/impact-graph.service.test.ts`

### Phase 2 — Frontend (card chain)

5. **`apps/web/src/lib/api.ts`** — add `fetchImpactGraph()` and `fetchImpactIntents()` client functions
6. **`ImpactMapCards.tsx`** — card chain renderer, two-column split for parallel branches
7. **`ImpactMap.tsx`** — container: fetches graph, fetches intents asynchronously, renders card chain + mode toggle stub
8. **Integrate into `DocDrawer`** — add `'trace'` to `DrawerPanel`, add tab icon + label, render `<ImpactMap />`

### Phase 3 — Frontend (React Flow graph)

9. **`pnpm --filter @syncdocs/web add reactflow @dagrejs/dagre`**
10. **`ImpactMapNode.tsx`** — custom React Flow node matching card design
11. **`ImpactMapGraph.tsx`** — dagre layout + React Flow canvas, lazy-loaded
12. **Mode toggle** — wire up pill toggle in `ImpactMap.tsx` to switch between card chain and graph

### Phase 4 — E2E tests

```
e2e/impact-map.spec.ts
```

**Scenarios:**

| # | Given | When | Then |
|---|-------|------|------|
| 1 | A document with a 3-event audit trail | User opens the Trace tab | All 3 nodes render as cards in chronological order |
| 2 | A node has `driftFlag: true` | Trace tab is open | The node card shows an amber drift warning badge |
| 3 | User clicks "Graph" toggle | React Flow canvas is not yet mounted | Canvas mounts and nodes appear at correct positions |
| 4 | User applies an event-type filter | Graph has both `doc_edit` and `code_commit` nodes | Only filtered nodes are visible |
| 5 | A node has AI intent available | Trace tab is open | Intent text renders in italic below the metadata |
| 6 | Graph has >50 nodes | Card chain renders | Only root + direct children are shown; "Show full trace" button is visible |

**Fixture data:** `e2e/fixtures/impact-graph-fixture.ts` — seeds a document with 10 chained audit events across 3 parallel branches.

**Mocking:** Claude intent API is mocked in CI via the `mockAI` fixture. React Flow is NOT mocked — it renders fully.

## File Map

| File | Purpose |
|------|---------|
| `apps/api/src/services/impact-graph.service.ts` | Graph traversal, drift detection |
| `apps/api/src/routes/impact-graph.ts` | Route handlers |
| `apps/api/src/__tests__/routes/impact-graph.test.ts` | Route unit tests |
| `apps/api/src/__tests__/services/impact-graph.service.test.ts` | Service unit tests |
| `apps/web/src/components/ImpactMap.tsx` | Container component |
| `apps/web/src/components/ImpactMapCards.tsx` | Card chain renderer |
| `apps/web/src/components/ImpactMapGraph.tsx` | React Flow graph renderer |
| `apps/web/src/components/ImpactMapNode.tsx` | Custom React Flow node |
| `apps/web/src/components/DocDrawer.tsx` | Add `'trace'` panel |
| `e2e/impact-map.spec.ts` | E2E tests |
| `e2e/fixtures/impact-graph-fixture.ts` | Test fixture data |

## Out of Scope (Post-MVP)

- Standalone `/impact/:documentId` full-screen page
- Cross-document impact maps (tracing changes across related docs)
- Real-time live updates as new audit events arrive
- AI narrative panel (prose summary of the full trace)
- Export: PNG/SVG of the graph
- Collaborative annotations on nodes
