# AI JSX Preview Generation (Artifacts-Style)

**TODO item:** #46
**Status:** TODO
**Priority:** P4 — Post-MVP

---

## Overview

Generate self-contained React components from spec descriptions via AI and render them live in the browser inside a sandboxed iframe. This gives stakeholders an interactive, artifacts-style preview of UI mockups, reports, dashboards, and data visualizations — directly from their documentation.

## Proposed Flow

1. User selects a spec section or types a prompt describing a UI
2. Frontend sends prompt + optional context to backend
3. Backend calls Claude API with a system prompt optimized for generating self-contained JSX
4. Claude returns a single-file React component (JSX + inline Tailwind styles)
5. Frontend transpiles the JSX using `@babel/standalone` inside a sandboxed iframe
6. The rendered component is displayed live in the browser
7. User can iteratively refine via chat (e.g., "make the chart blue", "add a sidebar")

## Architecture

### Runtime Transpilation

- **`@babel/standalone`** loaded inside the iframe handles JSX → JS transpilation at runtime
- **React, ReactDOM, and Tailwind CSS** loaded via CDN (`esm.sh` or `unpkg`) inside the iframe
- Component code is injected via **blob URLs** — no server-side file serving needed
- Each preview gets a fresh iframe instance to avoid state leakage

### Sandbox Model

The iframe uses strict sandbox flags:

```html
<iframe
  sandbox="allow-scripts"
  src={blobUrl}
/>
```

- `allow-scripts` — required for React rendering and Babel transpilation
- **No `allow-same-origin`** — prevents the iframe from accessing parent page cookies, localStorage, or APIs
- **No auth tokens** are passed into the iframe
- Blob URL isolation ensures the iframe cannot make authenticated requests to the SyncDocs API

### Backend

Two new functions in `apps/api/src/services/ai.service.ts`:

- **`generateJSXPreview(prompt, context?)`** — sends prompt to Claude API with a system prompt that constrains output to a single self-contained React component using only Tailwind for styling. Returns the JSX string.
- **`refineJSXPreview(currentJSX, refinementPrompt)`** — sends the current component code plus a refinement instruction to Claude. Returns updated JSX.

Two new routes in `apps/api/src/routes/ai.ts`:

- `POST /api/ai/jsx-preview` — accepts `{ prompt, context? }`, returns `{ jsx }`
- `POST /api/ai/jsx-preview/refine` — accepts `{ currentJSX, prompt }`, returns `{ jsx }`

### Frontend

**`JSXPreviewRenderer`** (`apps/web/src/components/JSXPreviewRenderer.tsx`)
- Manages the sandboxed iframe lifecycle
- Constructs the HTML document with CDN imports, Babel standalone, and the generated component
- Creates and revokes blob URLs
- Handles loading states and transpilation errors (caught via `window.onerror` inside the iframe, posted to parent via `postMessage`)

**`JSXPreviewPanel`** (`apps/web/src/components/JSXPreviewPanel.tsx`)
- Three view modes: **Code** (read-only JSX view), **Preview** (iframe render), **Split** (side-by-side)
- Refinement chat input at the bottom for iterative changes
- Chat history showing the prompt chain
- "Generate Preview" button for initial generation from selected spec text
- Copy JSX / Download buttons

**DocDrawer integration**
- New tab in the existing `DocDrawer` sidebar alongside AI Chat, Quality, Timeline, etc.
- Accessible from the document editor when viewing a spec

## Use Cases

- **UI mockups** — "Show me a dashboard layout with a sidebar, header, and 3 metric cards"
- **Reports** — "Create a quarterly report template with charts and summary tables"
- **Dashboards** — "Build a project status dashboard with progress bars and a task list"
- **Data visualizations** — "Show a bar chart comparing Q1 vs Q2 revenue" (using inline SVG or a CDN-loaded chart library)
- **Stakeholder reviews** — non-technical users can preview what a feature might look like before filing tickets

## Relationship to #45 (AI UI Mockup Generation)

| | #45 — Puppeteer Mockups | #46 — JSX Previews |
|---|---|---|
| **Output** | Static screenshot (PNG/JPG) | Live interactive React component |
| **Rendering** | Server-side via Puppeteer | Client-side in sandboxed iframe |
| **Use case** | Attach to tickets (GitHub Issues, Jira) | In-browser exploration and iteration |
| **Interactivity** | None (image) | Full (hover, click, scroll) |
| **Iteration** | Re-generate → new screenshot | Refine via chat, instant re-render |
| **Infrastructure** | Requires Puppeteer/Chromium on server | No server-side rendering needed |

These are complementary: #46 is for live exploration during spec writing, #45 is for attaching static visuals to external tools.

## Security Model

1. **iframe `sandbox="allow-scripts"`** — no same-origin access, no forms, no popups
2. **Blob URL isolation** — iframe content loaded from `blob:` URL, cannot make credentialed requests
3. **No auth tokens in iframe** — the iframe never receives JWT tokens, cookies, or API keys
4. **CSP headers** — parent page Content-Security-Policy can restrict iframe sources to `blob:`
5. **No `postMessage` secrets** — parent ↔ iframe communication limited to error reporting and resize events
6. **Generated code review** — optionally show the JSX code alongside the preview so users can inspect what was generated

## Open Questions

- **Code editing** — should users be able to edit the generated JSX directly? If so, need a lightweight code editor (Monaco/CodeMirror) in the Code view tab.
- **Export to file** — should generated components be downloadable as `.tsx` files or saveable into the project's component library?
- **Component libraries** — beyond Tailwind, should we support CDN-loading additional libraries (e.g., Recharts, Headless UI)?
- **Chart support** — for data visualizations, inline SVG vs. a chart library (Recharts via CDN) vs. Canvas-based rendering?
- **Version history** — should preview iterations be saved as snapshots alongside the document version history?
- **Collaborative previews** — in a future real-time collab world (#43), should previews be shared/visible to other team members?
