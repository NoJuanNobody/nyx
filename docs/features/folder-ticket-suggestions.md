# Folder-Level Ticket Suggestion Generation

## Overview

Users can right-click any folder in the file explorer to generate AI-powered ticket suggestions for all documents contained within that folder (including nested subfolders). This lets product and engineering teams quickly convert a batch of related specs — for example, an entire feature area or sprint scope — into actionable GitHub Issues or Jira tickets in one step.

---

## 1. User Story

> **As a** product manager or tech lead,
> **I want to** right-click a folder in the explorer and generate ticket suggestions for all documents it contains,
> **so that** I can batch-convert a set of related specs into tracked work items without opening each document individually.

---

## 2. Feature Behaviour

### 2.1 Triggering the Flow

1. User right-clicks any folder node in the file explorer sidebar.
2. The context menu shows a new item: **"Generate ticket suggestions"** (placed after the template section, before Rename/Delete).
3. Clicking the item collects all document IDs within the selected folder (recursively, including sub-folders).
4. A loading state is shown inline while the AI generates suggestions.
5. A **Folder Ticket Review** panel opens over the current view, listing all suggestions grouped by source document.

### 2.2 Folder Ticket Review Panel

The panel is a modal/drawer that mirrors the existing `BulkTicketReview` component but operates across multiple documents.

| Area | Behaviour |
|---|---|
| **Header** | Shows folder name, total suggestion count, and document count |
| **Grouping** | Suggestions grouped by document (collapsible), showing document title as section header |
| **Suggestion card** | Title, description, labels, source document link; inline edit (pencil icon) |
| **Selection** | Per-suggestion checkbox; "Select all" / "Deselect all" controls |
| **Provider picker** | GitHub Issues / Jira radio (same as existing `BulkTicketReview`) |
| **Push button** | "Push X selected tickets" — calls bulk-approve with selected suggestion IDs |
| **Dismiss** | Per-card dismiss removes the suggestion from view |
| **Results** | Success/failure per ticket displayed inline after push |

### 2.3 Empty & Error States

- **No documents in folder:** toast "This folder contains no documents."
- **AI generation fails:** per-document error row shown in the panel with a "Retry" button.
- **No suggestions produced:** empty state per document with "No suggestions" label.

---

## 3. Scope Boundaries

| In Scope | Out of Scope |
|---|---|
| Recursive collection of all docs in a folder tree | Generating suggestions for the root `/` level (per-document flow already covers this) |
| Grouping suggestions by source document | Merging or deduplicating suggestions across documents |
| Re-using existing `BulkTicketReview` UI patterns | Redesigning the existing per-document suggestion flow |
| GitHub Issues and Jira as push targets | New third-party integrations |

---

## 4. Implementation Plan

### 4.1 Backend — New API Endpoint

**File:** `apps/api/src/routes/tickets.ts`

Add one new route:

```
POST /api/folders/bulk-suggest-tickets
Body: { documentIds: string[] }
Returns: FolderSuggestionResult[]
```

```ts
interface FolderSuggestionResult {
  documentId: string;
  documentTitle: string;
  suggestions: TicketSuggestion[];
  error?: string;           // present if generation failed for this doc
}
```

Implementation strategy:
- Validate that all `documentIds` belong to the caller's team (re-use existing permission check pattern from `ticketService`).
- Call `aiService.generateTicketSuggestions(doc)` for each document — fan out with `Promise.allSettled` so a failure on one doc doesn't abort the rest.
- Persist suggestions to the `ticket_suggestions` table (same as the single-document flow).
- Return the `FolderSuggestionResult[]` array.

**File:** `apps/api/src/services/ticket.service.ts`

Add method `generateForFolder(documentIds: string[], userId: string): Promise<FolderSuggestionResult[]>`.

### 4.2 Frontend — API Client

**File:** `apps/web/src/lib/api.ts`

Add:

```ts
export interface FolderSuggestionResult {
  documentId: string;
  documentTitle: string;
  suggestions: TicketSuggestion[];
  error?: string;
}

export function generateFolderTicketSuggestions(
  documentIds: string[],
): Promise<FolderSuggestionResult[]> {
  return request<FolderSuggestionResult[]>('/folders/bulk-suggest-tickets', {
    method: 'POST',
    body: JSON.stringify({ documentIds }),
  });
}
```

### 4.3 Frontend — Context Menu Hook-up

**File:** `apps/web/src/components/FileTree.tsx`

1. **Collect document IDs for a folder path** — add a helper `getDocIdsInFolder(path: string, tree: TreeNode[]): string[]` that recursively traverses `FolderNode.children` and collects all `DocNode.doc.id` values.

2. **State for the new panel** — add:
   ```ts
   const [folderTicketFolder, setFolderTicketFolder] = useState<{ path: string; docIds: string[] } | null>(null);
   ```

3. **Menu item** — in `buildFolderMenuItems()`, after the `'Browse all templates…'` item and before the Rename/Delete block, insert:
   ```ts
   { type: 'separator' },
   {
     label: 'Generate ticket suggestions',
     action: () => {
       const docIds = getDocIdsInFolder(path, tree);
       if (docIds.length === 0) {
         // show toast: "This folder contains no documents."
         return;
       }
       setFolderTicketFolder({ path, docIds });
     },
   },
   ```

4. **Render the new panel** — below the existing `{contextMenu && <ContextMenu … />}` render:
   ```tsx
   {folderTicketFolder && (
     <FolderTicketReview
       folderPath={folderTicketFolder.path}
       documentIds={folderTicketFolder.docIds}
       open={true}
       onClose={() => setFolderTicketFolder(null)}
     />
   )}
   ```

### 4.4 Frontend — New Component

**File:** `apps/web/src/components/FolderTicketReview.tsx`

Props:
```ts
interface FolderTicketReviewProps {
  folderPath: string;
  documentIds: string[];
  open: boolean;
  onClose: () => void;
}
```

Key implementation notes:
- On mount (when `open === true`), call `generateFolderTicketSuggestions(documentIds)` via `useMutation`.
- Show a loading skeleton while generation is in flight.
- Store results as `FolderSuggestionResult[]` in local state.
- Render a collapsible section per document using the document title as the header.
- Reuse the existing suggestion card pattern from `BulkTicketReview` (edit, dismiss, checkbox selection).
- Provider picker and "Push selected" button call the existing `bulkApproveSuggestions(selectedIds, provider)` endpoint — no new push logic needed.
- Show per-document error rows with a per-document "Retry" button that re-calls the endpoint for just that `documentId`.

### 4.5 Tests

| Layer | Test | File |
|---|---|---|
| Unit | `getDocIdsInFolder` helper — nested folders, empty folder, mixed docs+folders | `apps/web/src/__tests__/components/FileTree.test.tsx` |
| Unit | `FolderTicketReview` — renders loading, renders grouped suggestions, handles error row | `apps/web/src/__tests__/components/FolderTicketReview.test.tsx` |
| API | `POST /folders/bulk-suggest-tickets` — success, partial failure, auth guard | `apps/api/src/__tests__/routes/tickets.test.ts` |
| E2E | Right-click folder → menu item visible → panel opens with suggestions | `e2e/folder-ticket-suggestions.spec.ts` |

---

## 5. Data Model Impact

No new database tables required. The existing `ticket_suggestions` table stores suggestions keyed by `document_id`, which covers the per-document rows generated by the folder flow. The folder concept is client-side only (derived from `document.path`).

---

## 6. Permissions & Feature Gating

- Requires the user to have `write` access to the team (same guard as `POST /documents/:id/bulk-suggest-tickets`).
- No new feature flag needed — the menu item follows the same availability as the existing bulk-suggest feature.

---

## 7. UX Considerations

- The menu item should be **disabled** (greyed out) if the folder contains no documents, with a tooltip "No documents in this folder".
- A spinner/progress indicator should appear in the panel header while generation is in flight — generation can take several seconds per document.
- Users should be able to close the panel during generation; in-flight requests are abandoned.
- The panel should be scrollable if the folder contains many documents.
