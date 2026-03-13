# Implementation Plan: Drag-and-Drop File Explorer

> **Issue:** [#69 — File explorer: cannot drag and drop files into folders](https://github.com/NoJuanNobody/syncdocs/issues/69)
> **Status:** Ready for implementation
> **Scope:** `apps/web` only — no backend changes required

---

## Overview

This document describes the concrete implementation steps for adding drag-and-drop reordering to the `FileTree` component. Documents can be dragged from any location in the tree and dropped into a folder, updating the document's `path` field via the existing `PUT /api/documents/:id` API endpoint.

---

## Library Choice

Use **`@dnd-kit/core`** + **`@dnd-kit/sortable`**.

| Concern | Why dnd-kit |
|---|---|
| React 19 compatibility | Yes — hooks-based, no legacy context |
| Accessibility | Keyboard drag-and-drop, ARIA announcements built-in |
| Bundle size | ~10 kB gzipped (vs react-beautiful-dnd at ~30 kB) |
| Headless | No imposed styles; works with Tailwind |
| Touch support | Yes — pointer events |
| Already a peer dep? | No — needs to be added |

Install:

```bash
pnpm --filter web add @dnd-kit/core @dnd-kit/utilities
```

`@dnd-kit/sortable` is **not** needed — we're doing free-form drag-to-folder, not list reordering.

---

## Affected Files

| File | Change |
|---|---|
| `apps/web/src/components/FileTree.tsx` | Primary — add drag/drop wiring |
| `apps/web/src/lib/api.ts` | No change — `updateDocument(id, { path })` already exists |
| `apps/web/package.json` | Add `@dnd-kit/core` + `@dnd-kit/utilities` |
| `e2e/file-tree.spec.ts` | New — E2E test for drag-and-drop |
| `apps/web/src/components/FileTree.test.tsx` | New (optional) — unit test for `moveDoc` logic |

---

## Implementation Steps

### Step 1 — Install dependencies

```bash
pnpm --filter web add @dnd-kit/core @dnd-kit/utilities
```

Verify in `apps/web/package.json`:
```json
"@dnd-kit/core": "^6.x",
"@dnd-kit/utilities": "^3.x"
```

---

### Step 2 — Add drag-and-drop state to `FileTree`

In `FileTree` component (`apps/web/src/components/FileTree.tsx:565`), add:

```tsx
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';

// Inside FileTree():
const [draggingDoc, setDraggingDoc] = useState<Document | null>(null);

const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: { distance: 8 }, // prevent accidental drags on click
  }),
  useSensor(KeyboardSensor),
);
```

The `distance: 8` activation constraint is important — without it, single-clicks on `DocItem` would accidentally start drags.

---

### Step 3 — Add `moveDocMutation`

Below the existing mutations in `FileTree` (`apps/web/src/components/FileTree.tsx:626`), add:

```tsx
const moveDocMutation = useMutation({
  mutationFn: ({ id, path }: { id: string; path: string }) =>
    updateDocument(id, { path }),
  // Optimistic update: update the cache immediately before the API call
  onMutate: async ({ id, path }) => {
    await queryClient.cancelQueries({ queryKey: ['documents', teamId] });
    const previous = queryClient.getQueryData<Document[]>(['documents', teamId]);
    queryClient.setQueryData<Document[]>(['documents', teamId], (old) =>
      old?.map((d) => (d.id === id ? { ...d, path } : d)) ?? [],
    );
    return { previous };
  },
  onError: (_err, _vars, context) => {
    // Roll back on failure
    if (context?.previous) {
      queryClient.setQueryData(['documents', teamId], context.previous);
    }
  },
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
  },
});
```

---

### Step 4 — Add drag event handlers

```tsx
const handleDragStart = (event: DragStartEvent) => {
  const doc = documents?.find((d) => d.id === event.active.id);
  if (doc) setDraggingDoc(doc);
};

const handleDragEnd = (event: DragEndEvent) => {
  const { active, over } = event;
  setDraggingDoc(null);

  if (!over || active.id === over.id) return;

  // `over.id` is the folder path (string), `active.id` is the doc id (string)
  const targetFolderPath = over.id as string;
  const docId = active.id as string;
  const doc = documents?.find((d) => d.id === docId);

  // Don't move if already in that folder
  if (!doc || doc.path === targetFolderPath) return;

  // Auto-expand the target folder so user sees the moved doc
  setExpandedFolders((prev) => new Set(prev).add(targetFolderPath));

  moveDocMutation.mutate({ id: docId, path: targetFolderPath });
};
```

---

### Step 5 — Wrap the tree with `DndContext`

Wrap the tree `<div>` (`apps/web/src/components/FileTree.tsx:1002`) with `DndContext`:

```tsx
<DndContext
  sensors={sensors}
  onDragStart={handleDragStart}
  onDragEnd={handleDragEnd}
>
  <div
    className="flex-1 overflow-y-auto px-1 pb-4"
    onContextMenu={...}
  >
    {/* ...existing tree content... */}
  </div>

  {/* Ghost element that follows the cursor during drag */}
  <DragOverlay dropAnimation={null}>
    {draggingDoc ? (
      <div className="flex items-center gap-2 rounded-md bg-white px-3 py-1.5 text-xs text-slate-700 shadow-lg border border-slate-200 opacity-90">
        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
        {draggingDoc.title || 'Untitled'}
      </div>
    ) : null}
  </DragOverlay>
</DndContext>
```

---

### Step 6 — Make `DocItem` draggable

Import `useDraggable` and update `DocItem` (`apps/web/src/components/FileTree.tsx:403`):

```tsx
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

function DocItem({ doc, depth, ... }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: doc.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : undefined, // dim the original while dragging
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="relative"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <NavLink ...>
        {/* existing content unchanged */}
      </NavLink>
      {/* hover actions unchanged */}
    </div>
  );
}
```

> **Note:** Spread `{...listeners}` on the outer `<div>`, not on `<NavLink>`. This lets dnd-kit intercept pointer events for dragging while still allowing clicks through to navigation.

---

### Step 7 — Make `Folder` a drop target

Import `useDroppable` and update `Folder` (`apps/web/src/components/FileTree.tsx:187`):

```tsx
import { useDroppable } from '@dnd-kit/core';

function Folder({ node, depth, ... }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: node.path });

  // isOver: true when a draggable is hovering above this folder
  const dropHighlight = isOver
    ? 'bg-blue-50 ring-1 ring-blue-300'
    : '';

  return (
    <div>
      <div
        ref={setDropRef}        // ← attach drop target ref here
        className={`group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-slate-100/60 rounded-md transition-colors ${dropHighlight}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => !isRenaming && toggleFolder(node.path)}
        ...
      >
        {/* existing folder header content unchanged */}
      </div>

      {/* children rendered when open - unchanged */}
    </div>
  );
}
```

The `isOver` flag drives a visual ring highlight on the folder row, signalling to the user that it is a valid drop target.

---

### Step 8 — Handle drop onto root

The root-level tree area should also accept drops (to move a doc out of a folder to the root `/`). Add a `useDroppable` to the root scroll container:

```tsx
// In FileTree(), alongside other hooks:
const { setNodeRef: setRootDropRef, isOver: isOverRoot } = useDroppable({ id: '/' });

// Apply to the tree container div:
<div
  ref={setRootDropRef}
  className={`flex-1 overflow-y-auto px-1 pb-4 ${isOverRoot ? 'bg-blue-50/30' : ''}`}
  onContextMenu={...}
>
```

---

## Data Flow

```
User drags DocItem
    │
    ▼
DndContext.onDragStart
    → setDraggingDoc(doc)          (shows DragOverlay ghost)

User hovers Folder
    → Folder.isOver = true         (blue ring highlight)

User drops on Folder
    │
    ▼
DndContext.onDragEnd
    → setDraggingDoc(null)
    → setExpandedFolders.add(targetPath)
    → moveDocMutation.mutate({ id, path: targetFolderPath })
         │
         ├── onMutate:   optimistic cache update (instant UI)
         ├── mutationFn: PUT /api/documents/:id { path }
         └── onError:    rollback cache to previous state
         └── onSettled:  invalidateQueries(['documents', teamId])
```

---

## Visual States Reference

| State | Appearance |
|---|---|
| Idle | Normal tree, no visual change |
| Dragging started | Doc row dims to 40% opacity; ghost card follows cursor |
| Hovering a folder | Folder row gets `bg-blue-50 ring-1 ring-blue-300` |
| Hovering root area | Scroll container gets `bg-blue-50/30` tint |
| Drop success | Ghost disappears; doc appears in target folder (optimistic) |
| Drop failure / API error | Rollback: doc returns to original folder |

---

## Edge Cases & Constraints

| Case | Handling |
|---|---|
| Drop on same folder | Skipped — `doc.path === targetFolderPath` guard in `handleDragEnd` |
| Drop on a doc (not a folder) | Not a drop target — `DocItem` has no `useDroppable` |
| Dragging a folder | Out of scope for v1 — only `DocItem` has `useDraggable` |
| Stage filter active | `filteredDocs` is used for the tree; all documents (unfiltered) are available for path updates |
| Empty folder (localStorage only) | Target folder path exists; move works — `documents` path update is all that matters |
| Folder auto-expand on hover | Not implemented in v1; folder expands on successful drop instead |
| Keyboard drag | `KeyboardSensor` included; accessible via Tab + Space/Enter/Arrow keys |
| Touch / mobile | `PointerSensor` handles touch events natively |

---

## Testing Plan

### Unit Tests (`apps/web/src/components/FileTree.test.tsx`)

```ts
describe('moveDoc path logic', () => {
  it('updates doc path to target folder', () => {
    const doc = { id: '1', path: '/', title: 'My Doc', ... };
    // Simulate handleDragEnd with over.id = '/engineering'
    expect(moveDocMutation.mutate).toHaveBeenCalledWith({
      id: '1',
      path: '/engineering',
    });
  });

  it('does not mutate when dropping on same folder', () => {
    const doc = { id: '1', path: '/engineering', ... };
    // over.id = '/engineering'
    expect(moveDocMutation.mutate).not.toHaveBeenCalled();
  });

  it('rolls back on API error', async () => {
    // mutationFn rejects → onError should restore previous cache
  });
});
```

### E2E Tests (`e2e/file-tree.spec.ts`)

```ts
test('drag doc into folder', async ({ authenticatedPage: page }) => {
  // Create a folder and a root-level doc
  // Drag the doc onto the folder
  // Assert doc now appears nested under the folder
  // Assert API call: PUT /api/documents/:id with path = folder path
});

test('folder highlights on hover during drag', async ({ authenticatedPage: page }) => {
  // Start dragging a doc
  // Hover over a folder
  // Assert folder row has blue ring class
});

test('drop on same folder is a no-op', async ({ authenticatedPage: page }) => {
  // Drag doc and drop it back onto its current folder
  // Assert no API call was made
});

test('keyboard drag-and-drop', async ({ authenticatedPage: page }) => {
  // Focus a DocItem with Tab
  // Press Space to start drag (dnd-kit keyboard sensor)
  // Navigate to folder with arrow keys
  // Press Enter/Space to drop
  // Assert doc moved
});
```

---

## Rollout Notes

- No backend migration needed — `path` field and `PUT /api/documents/:id` already support this.
- No schema changes.
- Empty folders persist in `localStorage`; moving the last doc out of a folder leaves an empty folder (existing behaviour, acceptable for v1).
- The `DragOverlay` is portalled to `document.body` by dnd-kit, so it will render above the sidebar z-index without any CSS changes.
- If `@dnd-kit/core` version conflicts arise with React 19, check the dnd-kit [React 19 compat issue tracker](https://github.com/clauderic/dnd-kit/issues) — as of early 2026, `@dnd-kit/core@6.x` is compatible.
