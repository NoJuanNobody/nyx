# Feature: JSX Preview Split View & State-Aware Mockup Generation

**Issue:** [#85 — Move JSX preview to split view and enhance mockup generation with state awareness](https://github.com/NoJuanNobody/syncdocs/issues/85)
**Status:** Proposed
**Category:** Feature Request
**Submitted by:** Alejandro Londono

---

## Overview

This feature covers two closely related improvements to the JSX preview and mockup workflow in SyncDocs:

1. **Relocate the JSX preview** from the file explorer sidebar item into a first-class split-view panel inside the `DocumentEditor`.
2. **Make mockup generation state-aware** so Claude automatically captures all relevant component states (loading, empty, error, populated, etc.) and attaches them to tickets as comprehensive visual references.

---

## Current Behavior

### JSX Preview Location

The JSX preview is accessible in two ways today:

| Entry point | Component | Behaviour |
|---|---|---|
| File tree row (`FileTree.tsx:569`) | `JSXPreviewItem` | Navigates to `/documents/:id/preview` (full-page `JSXPreviewPage`) |
| Doc Drawer panel (`DocDrawer.tsx:154`) | `JSXPreviewPanel` in `jsx-preview` drawer | Opens as a side drawer overlay on the editor |

Neither surface puts the preview **side-by-side with the live spec** in the same viewport. The DocDrawer covers the editor, and the `JSXPreviewPage` is a completely separate route.

### Mockup Generation

`generateJSXPreview(prompt, specContext)` in `JSXPreviewPanel` passes the raw spec content as `specContext`. The AI generates a single JSX component for the described UI but has no explicit signal to render multiple states (e.g., loading skeleton, empty state, error banner, populated view).

The `CreateTicketModal` (`CreateTicketModal.tsx`) accepts `documentContent` but no mockup data, so tickets never carry visual references from the preview panel.

---

## Proposed Changes

### 1. JSX Preview in DocumentEditor Split View

Extend the existing `editorLayout` state in `DocumentEditor.tsx` (currently `'split' | 'editor' | 'preview'`) to include a `'preview-jsx'` layout option.

When active, the editor viewport renders:

```
┌─────────────────────────┬────────────────────────────┐
│  Markdown Editor        │  JSX Preview Panel         │
│  (left pane, resizable) │  (right pane, resizable)   │
└─────────────────────────┴────────────────────────────┘
```

The `JSXPreviewPanel` already supports its own internal `'preview' | 'code' | 'split'` toolbar (showing JSX source vs. rendered iframe). In the new layout, that inner toolbar remains in the right pane so users can switch between rendered output and raw JSX without leaving the editor.

**Affected files:**
- `apps/web/src/pages/DocumentEditor.tsx` — add `'preview-jsx'` layout mode and wire `splitContainerRef` / `splitPercent` drag logic to the new layout
- `apps/web/src/components/MarkdownToolbar.tsx` — add a "JSX Preview" layout toggle button alongside the existing Editor/Split/Preview buttons
- `apps/web/src/components/DocDrawer.tsx` — optionally retain `jsx-preview` as a drawer option for smaller viewports; not removed
- `apps/web/src/components/FileTree.tsx` — keep `JSXPreviewItem` as a shortcut that switches the editor into `'preview-jsx'` layout rather than navigating away

### 2. State-Aware Mockup Generation

#### System Prompt Enhancement

Update the backend prompt for `generateJSXPreview` (`apps/api/src/...`) to instruct Claude to render **all meaningful UI states** in a single scrollable JSX component when `specContext` is present.

States to cover (inferred from the spec):

| State | Description |
|---|---|
| **Loading** | Skeleton / spinner while data fetches |
| **Empty** | Zero-data state with call-to-action |
| **Error** | Error banner / retry UI |
| **Populated** | Representative data filled in |
| **Disabled / read-only** | For role-gated views (non-dev users) |

The returned JSX wraps each state in a labeled section:

```jsx
export default function PreviewAllStates() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <Section label="Loading">...</Section>
      <Section label="Empty">...</Section>
      <Section label="Error">...</Section>
      <Section label="Populated">...</Section>
    </div>
  );
}
```

#### UI: "Generate All States" Toggle

Add a **"All states"** checkbox / toggle to the `JSXPreviewPanel` prompt area. When checked, the request payload includes `allStates: true`, instructing the API to use the state-aware prompt.

#### Refinement History as State Context

Pass `chatHistory` as part of the refinement payload so that earlier state selections influence subsequent iterations.

### 3. Mockup Attachment in Ticket Creation

Extend `CreateTicketModal` to accept an optional `mockupJsx?: string` prop. When provided:

- The ticket body gains a `## Visual Mockup` section containing a fenced JSX code block.
- A human-readable note is prepended: _"A UI mockup was generated from the spec and is included below."_

**Data flow:**

```
DocumentEditor
  └── JSXPreviewPanel  ──(onMockupReady callback)──►  DocumentEditor state (currentMockupJsx)
  └── CreateTicketModal receives currentMockupJsx as prop
```

`DocumentEditor` lifts `currentMockupJsx` state and passes it down to `CreateTicketModal` via a new prop.

**Affected files:**
- `apps/web/src/pages/DocumentEditor.tsx` — add `currentMockupJsx` state; pass to `CreateTicketModal`
- `apps/web/src/components/JSXPreviewPanel.tsx` — add `onMockupReady?: (jsx: string) => void` prop; call when JSX is generated/refined
- `apps/web/src/components/CreateTicketModal.tsx` — add `mockupJsx?: string` prop; append to ticket body

---

## API Changes

### `POST /api/documents/:id/jsx-preview`

Add optional `allStates` boolean to the request body:

```ts
interface GenerateJSXPreviewRequest {
  prompt: string;
  specContext?: string;
  allStates?: boolean;      // NEW
}
```

When `allStates: true`, the system prompt is expanded to enumerate all inferred component states.

---

## UX Considerations

- **Discoverability:** The "JSX Preview" split layout button in `MarkdownToolbar` should only appear when the document has previously generated JSX or the toolbar is in doc-editor context (not in version history read-only mode).
- **Performance:** State-aware generation produces larger JSX; the iframe sandbox in `JSXPreviewRenderer` already handles this, but a loading indicator should remain visible until the full render is complete.
- **Responsive / narrow viewports:** On small screens (`< 768px`), the `'preview-jsx'` layout falls back to the DocDrawer overlay behavior.
- **Backward compatibility:** Existing `JSXPreviewPage` route remains; it's still useful as a focused full-screen preview.

---

## Acceptance Criteria

- [ ] `DocumentEditor` has a "JSX Preview" split layout mode accessible from `MarkdownToolbar`
- [ ] The `JSXPreviewPanel` renders in the right pane alongside the markdown editor with a draggable divider
- [ ] `JSXPreviewPanel` has an "All states" toggle that, when enabled, generates a single component showcasing loading / empty / error / populated states
- [ ] A generated or refined mockup is automatically surfaced in `CreateTicketModal` and appended to the ticket body as a JSX code block
- [ ] `JSXPreviewItem` in `FileTree` switches to the new split layout instead of navigating away from the editor
- [ ] E2E tests cover the split layout toggle and ticket body mockup inclusion
- [ ] Narrow-viewport fallback verified on `< 768px`

---

## Out of Scope

- Image / PNG export of the rendered preview (separate feature)
- Storing generated mockup JSX in the database as a document artifact (deferred)
- Figma or Storybook export

---

## Open Questions

1. Should `allStates` be the default when `specContext` is present, or remain opt-in?
2. Should the `currentMockupJsx` in `DocumentEditor` persist across navigations (e.g., via `sessionStorage`) so it isn't lost when the user briefly leaves the editor?
3. Is the ticket body character limit for GitHub Issues a concern for large multi-state JSX blobs? Consider truncating or linking to a Gist.
