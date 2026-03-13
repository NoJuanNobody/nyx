# Feature: Drag-and-Drop File Explorer

**Issue:** [#69 – File explorer: cannot drag and drop files into folders](https://github.com/NoJuanNobody/syncdocs/issues/69)
**Status:** Proposed
**Last Updated:** 2026-03-13

---

## Overview

Users should be able to reorganize documents in the file explorer sidebar by dragging files and dropping them into folders. This removes friction from structuring a documentation project and aligns SyncDocs with familiar file-manager UX patterns (VS Code sidebar, Notion, Linear).

---

## User Stories

| As a… | I want to… | So that… |
|---|---|---|
| Technical writer | Drag a document from one folder into another | I can reorganize my spec structure without editing paths manually |
| Product manager | Drop a loose document into a folder | I can keep documentation grouped by feature or team |
| Developer | Move multiple related specs into a subfolder | I can mirror the way my codebase is organized |

---

## Scope

### In Scope

- Drag a single document and drop it into any folder in the file tree
- Drop target folder highlights on drag-over to indicate a valid drop zone
- After a successful drop, the document's `path` is updated in the database
- File tree re-renders immediately to reflect the new structure (optimistic update)
- Dragging a document to the root (`/`) moves it out of any folder
- Visual drag preview (ghost element) following the cursor

### Out of Scope (Future Iterations)

- Dragging folders into other folders (folder reordering)
- Multi-select drag (moving several documents at once)
- Custom sort ordering within a folder (currently alphabetical)
- Drag-and-drop across different teams

---

## Acceptance Criteria

- [ ] Files in the file explorer can be dragged (draggable visual handle or entire row)
- [ ] Folders highlight as valid drop targets on hover during a drag
- [ ] Dropping a file into a folder updates its `path` in the database via `PUT /api/documents/:id`
- [ ] File tree re-renders to reflect the new structure after a drop
- [ ] Dropping a file onto its current folder has no effect (no unnecessary API call)
- [ ] Drag operation is cancellable (Escape key or drag-out)
- [ ] Works correctly on touch devices (mobile/tablet) — optional stretch goal

---

## Technical Design

### Current Architecture

The file explorer is built in `apps/web/src/components/FileTree.tsx`. Key points:

- Documents are fetched from `GET /api/documents?teamId=X` and stored via React Query
- Documents have a `path` field (e.g., `/api/reference`) that determines their folder placement
- Folder nodes are derived from document paths — there is no separate `folders` table
- Empty folders are persisted in `localStorage` under `syncdocs:folders`
- Moving a document is already supported by `PUT /api/documents/:id` with a new `path` value

### Proposed Implementation

#### 1. DnD Library

Use [`@dnd-kit/core`](https://dndkit.com/) with `@dnd-kit/sortable`. It is:
- Headless and accessible (ARIA live regions for screen readers)
- Compatible with React 19
- Actively maintained with no required DOM mutations

```bash
pnpm --filter web add @dnd-kit/core @dnd-kit/utilities
```

#### 2. Draggable Document Rows

Wrap `DocItem` in a `useDraggable` hook from dnd-kit:

```tsx
// Pseudocode
const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
  id: doc.id,
  data: { type: 'doc', docId: doc.id, currentPath: doc.path },
});
```

Apply a CSS transform during drag and reduce opacity on the source item.

#### 3. Droppable Folder Targets

Wrap each `Folder` component in `useDroppable`:

```tsx
const { setNodeRef, isOver } = useDroppable({
  id: `folder:${folder.path}`,
  data: { type: 'folder', folderPath: folder.path },
});
```

Apply a highlight style (e.g., border or background tint) when `isOver` is `true`.

Also make the root-level area droppable (`folder:/`) so documents can be moved to the top level.

#### 4. DragEnd Handler

In the `DndContext` `onDragEnd` callback:

1. Extract source doc ID and target folder path from event data
2. Skip if target path equals current path
3. Call `updateDocument(docId, { path: targetFolderPath })` mutation
4. Invalidate React Query cache to refresh the tree

```tsx
function handleDragEnd(event: DragEndEvent) {
  const { active, over } = event;
  if (!over) return;

  const docId = active.data.current?.docId as string;
  const newPath = over.data.current?.folderPath as string;
  const currentPath = active.data.current?.currentPath as string;

  if (!docId || !newPath || newPath === currentPath) return;

  moveMutation.mutate({ id: docId, path: newPath });
}
```

#### 5. Optimistic Update

To avoid a flicker after drop, update the React Query cache optimistically before the API call resolves:

```tsx
// In onMutate of the mutation
queryClient.setQueryData(['documents', teamId], (old) =>
  old?.map((doc) => (doc.id === id ? { ...doc, path: newPath } : doc))
);
```

Roll back on error via `onError` with the snapshot from `onMutate`.

#### 6. API Layer

No new endpoints are required. The existing `PUT /api/documents/:id` endpoint in `apps/api/src/routes/documents.ts` already accepts a `path` field.

---

## Data Flow Diagram

```
User drags DocItem
       │
       ▼
DndContext onDragEnd fires
       │
       ├─► Optimistic update → React Query cache patched immediately
       │
       └─► PUT /api/documents/:id  { path: "/new-folder" }
                  │
                  ├─► Success → cache invalidated → tree refreshes
                  │
                  └─► Error → cache rolled back → toast error shown
```

---

## UI / Visual Design

| State | Visual Treatment |
|---|---|
| Idle | Normal document row |
| Dragging (source) | Row becomes semi-transparent (opacity: 0.4), ghost element follows cursor |
| Folder: drag-over | Folder row gets a blue-tinted background and border |
| Folder: valid drop | Cursor changes to `grabbing` / `copy` |
| Drop success | Tree animates to new position |
| Drop error | Toast notification: "Failed to move document" |

---

## File Changes Summary

| File | Change |
|---|---|
| `apps/web/src/components/FileTree.tsx` | Add `DndContext`, `useDraggable` on `DocItem`, `useDroppable` on `Folder`, `handleDragEnd` handler |
| `apps/web/src/components/FileTree.tsx` | Add `moveMutation` using `updateDocument` |
| `apps/web/package.json` | Add `@dnd-kit/core`, `@dnd-kit/utilities` |
| `e2e/file-tree.spec.ts` | Add E2E tests for drag-and-drop scenarios |

No database schema changes are needed.

---

## Testing Plan

### Unit Tests (Vitest)

- Tree building correctly reflects path change after move
- `handleDragEnd` skips API call when source and target paths are identical

### E2E Tests (Playwright)

- Drag document from root into a folder → document appears inside folder
- Drag document from folder back to root → document appears at root
- Drag document onto its current folder → no visual change, no API call
- Drop fails gracefully → document returns to original position, error toast shown

---

## Dependencies & Risks

| Dependency | Notes |
|---|---|
| `@dnd-kit/core` | New dependency; small bundle (~10 KB gzipped) |
| `PUT /api/documents/:id` | Already supports `path` updates — no backend changes needed |
| React Query optimistic updates | Existing pattern used elsewhere in the app |

| Risk | Mitigation |
|---|---|
| Flickering on slow networks | Optimistic UI update prevents visible flicker |
| Touch support gaps | dnd-kit has a `TouchSensor` — include in initial implementation |
| Accessibility | dnd-kit provides ARIA announcements out of the box; verify with screen reader |
| Folder rename breaks paths | Already handled by existing folder-rename logic that updates all descendant paths |
