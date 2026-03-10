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

## Implementation

### Backend

- **`apps/api/src/services/ai.service.ts`** — `generateJSXPreview(prompt, context?)` and `refineJSXPreview(currentJSX, refinementPrompt)` methods added to `aiService`
- **`apps/api/src/routes/ai.ts`** — `POST /api/ai/jsx-preview` and `POST /api/ai/jsx-preview/refine` routes

### Frontend

- **`apps/web/src/lib/api.ts`** — `generateJSXPreview()` and `refineJSXPreview()` client functions
- **`apps/web/src/components/JSXPreviewRenderer.tsx`** — sandboxed iframe component; constructs HTML with CDN React/Tailwind/Babel, injects JSX via blob URL, listens for `postMessage` errors
- **`apps/web/src/components/JSXPreviewPanel.tsx`** — Code/Preview/Split view modes, refinement chat, copy/download actions
- **`apps/web/src/components/DocDrawer.tsx`** — "Preview" tab added alongside AI Edit, Agent, History, etc.

## E2E Tests

Test file: `tests/e2e/ai-jsx-previews.spec.ts` — **22 scenarios**

### Preview generation (4 tests)
1. Generate from typed prompt → Claude API call → JSX → iframe render
2. Generate from selected spec text (context passed with prompt)
3. iframe has `sandbox="allow-scripts"` attribute and no `allow-same-origin`; `src` uses `blob:` URL
4. Fresh iframe per generation — each new generation mounts a new iframe (no state leakage)

### View modes (4 tests)
5. Code view: read-only JSX displayed with syntax-style formatting
6. Preview view: only the sandboxed iframe is shown
7. Split view: code panel and iframe rendered side by side
8. Default view on first generation is Preview

### Iterative refinement (3 tests)
9. Refine via chat sends `POST /api/ai/jsx-preview/refine` with `currentJSX` + `prompt`
10. Multiple refinement rounds: each round sends updated JSX from previous response
11. Refinement preserves prior context — component structure not regressed

### Copy & download (2 tests)
12. Copy JSX to clipboard shows confirmation ("Copied!") toast
13. Download triggers file download as `.jsx`

### Error handling (3 tests)
14. Invalid JSX transpilation error caught via `postMessage` from iframe; error shown in panel
15. API 500 error displayed in panel's error banner
16. Empty prompt: submit button disabled; no API call made

### Security (3 tests)
17. iframe cannot read `window.parent.localStorage`
18. iframe cannot make credentialed fetch requests to the SyncDocs API (no `allow-same-origin`)
19. Blob URL isolation: iframe `src` starts with `blob:` not a network URL

### DocDrawer integration (2 tests)
20. "Preview" tab visible in DocDrawer toggle alongside History, Timeline, AI Edit, Agent, etc.
21. Switching away from Preview tab and back preserves generated JSX state

### Performance (1 test)
22. Preview renders (iframe `onload` fires) within 5 seconds of API response

## Open Questions

- **Code editing** — should users be able to edit the generated JSX directly? If so, need a lightweight code editor (Monaco/CodeMirror) in the Code view tab.
- **Export to file** — should generated components be downloadable as `.tsx` files or saveable into the project's component library?
- **Component libraries** — beyond Tailwind, should we support CDN-loading additional libraries (e.g., Recharts, Headless UI)?
- **Chart support** — for data visualizations, inline SVG vs. a chart library (Recharts via CDN) vs. Canvas-based rendering?
- **Version history** — should preview iterations be saved as snapshots alongside the document version history?
- **Collaborative previews** — in a future real-time collab world (#43), should previews be shared/visible to other team members?

---

## E2E Tests

**Test file:** `tests/e2e/ai-jsx-previews.spec.ts`

### Preview generation

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Generate preview from prompt | Open document → open JSXPreviewPanel tab in DocDrawer → type "Show me a dashboard with 3 metric cards" → click "Generate Preview" | Loading state → `POST /api/ai/jsx-preview` called → JSX code returned → iframe renders live React component showing 3 metric cards |
| 2 | Generate from selected spec text | Select a paragraph in the editor describing a UI → click "Generate Preview" button | Selected text sent as prompt context; preview generated matching the description |
| 3 | Preview renders in sandboxed iframe | Generate a preview → inspect the iframe element | iframe has `sandbox="allow-scripts"` attribute; no `allow-same-origin`; `src` is a `blob:` URL |
| 4 | Fresh iframe per generation | Generate preview A → generate preview B | Previous iframe destroyed; new iframe created; no state leakage between previews |

### View modes

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 5 | Code view shows JSX | Generate preview → switch to "Code" view mode | Read-only JSX code displayed with syntax highlighting |
| 6 | Preview view shows rendered component | Generate preview → switch to "Preview" view mode | Only the rendered iframe visible; no code |
| 7 | Split view shows both | Generate preview → switch to "Split" view mode | Code on left, rendered preview on right, side by side |
| 8 | Default view is Preview | Generate a new preview | Preview (iframe) view shown by default |

### Iterative refinement

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 9 | Refine via chat | Generate preview → type "Make the cards blue" in refinement input → Send | `POST /api/ai/jsx-preview/refine` called with current JSX + refinement prompt; iframe re-renders with blue cards |
| 10 | Multiple refinement rounds | Generate preview → refine once → refine again ("add a sidebar") | Each refinement builds on previous; preview updates incrementally; chat history shows full prompt chain |
| 11 | Refinement preserves prior context | Generate dashboard → refine "add a header" → refine "make header sticky" | All three elements present (dashboard + header + sticky behavior); no regression |

### Copy & download

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 12 | Copy JSX to clipboard | Generate preview → click "Copy JSX" | JSX code copied to clipboard; toast confirmation shown |
| 13 | Download button | Generate preview → click "Download" | `.jsx` file downloaded with generated component code |

### Error handling

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 14 | Transpilation error displayed | Mock AI to return invalid JSX (e.g., unclosed tag) → generate | Error message shown in preview area (caught via `window.onerror` inside iframe → `postMessage` to parent); code view shows the faulty JSX |
| 15 | API error shown | Mock `/api/ai/jsx-preview` to return 500 → generate | Error message displayed in panel; user can retry |
| 16 | Empty prompt rejected | Click "Generate Preview" with empty input | Button disabled or validation error; no API call made |

### Security

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 17 | iframe cannot access parent localStorage | Generate preview with JSX that tries `window.localStorage.getItem('token')` | Access blocked by sandbox; no data returned to generated component |
| 18 | iframe cannot make credentialed API calls | Generate preview with JSX that tries `fetch('/api/documents')` | Request blocked or returns unauthorized; no SyncDocs data exposed |
| 19 | Blob URL isolation | Inspect iframe src attribute | URL is `blob:` scheme; not same-origin with parent |

### DocDrawer integration

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 20 | Preview tab visible in DocDrawer | Open document → open DocDrawer | "Preview" tab available alongside AI Chat, Timeline, Versions, Audit |
| 21 | Panel state preserved on tab switch | Generate preview → switch to Timeline tab → switch back to Preview tab | Previous preview still rendered; chat history preserved |

### Performance

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 22 | Preview renders within 5 seconds | Generate preview → measure time from API response to iframe render complete | Iframe renders in under 5 seconds (CDN loading + Babel transpilation + React mount) |
