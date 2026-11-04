# Folder / document tree (`nyx_core::tree`)

Backs the Explorer file tree (AI-65). Documents already carried a folder-like `path`; empty folders
and folder order only existed in the browser (`localStorage["nyx:folders"]`). This module moves
that into the store.

## Schema (migration 165, `0165_folders.sql`)

- `folders(id, team_id, path, sort_order, created_at, updated_at)`, unique per `(team_id, path)`.
- `documents.sort_order` (default 0) for manual order among siblings.

A folder exists if it has a row **or** something lives beneath it (a document path or a deeper
folder). Implicit folders are materialised on demand (create, rename, move, reorder).

## API

| Module | Contents |
| --- | --- |
| `tree::path` | `normalize`, `validate_name`, `parent`, `name`, `join`, `chain`, `is_ancestor_or_self` (segment aware: `/A` is not an ancestor of `/Apple`), `rebase` |
| `tree::build` | `build_tree(folders, docs) -> TreeNode`; folders first, then `(sort_order, case-insensitive name)`; `find_folder`, `document_ids`, `folder_paths` |
| `tree::store::SqliteTree` | `tree`, `subtree`, `subtree_document_ids`, `folder_exists`, `resolve`, `create_folder`, `ensure_folder_path`, `rename_folder`, `move_folder`, `delete_folder(DeletePolicy)`, `move_document`, `reorder` |

Guarantees: moving a folder into itself or a descendant is `Error::Invalid`; name clashes are
`Error::Conflict`; renames/moves rewrite descendant folder rows and document paths (including
soft-deleted documents, so a later restore lands in the moved folder); each multi-row operation
runs in a SAVEPOINT, so it is atomic and nests inside `Db::transaction`.

## Web mapping

`apps/web/src/lib/explorerTree.ts` mirrors the pure rules (cycle check, rebase, ordering) so the
UI and core agree. The web still persists folders in `localStorage` and moves documents through the
existing API; swapping that transport for these core calls is the wiring wave (AI-74): expose
`SqliteTree` through MCP/CLI/Tauri commands.

## Gaps vs the TypeScript app

- No Tauri/MCP/CLI exposure yet (hot-file rule); the web is not yet reading `folders` from core.
- Document title uniqueness within a folder is not enforced (TS never did); `resolve` reports
  ambiguity as `Conflict`.
- Folder delete cascades by soft-deleting documents; there is no undelete of folders.
