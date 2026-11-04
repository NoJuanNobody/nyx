/**
 * Pure model for the Explorer tree: folder/stage trees, flattening for keyboard navigation and
 * virtualization, and folder-move path math. No React, no I/O, so it is trivially unit-testable.
 *
 * The folder rules mirror `crates/nyx-core/src/tree` (segment-aware ancestry, cycle prevention,
 * folders first then case-insensitive name order).
 */

export interface ExplorerDoc {
  id: string;
  title: string;
  path?: string | null;
  stage?: string | null;
}

export type ExplorerNodeKind = 'folder' | 'doc' | 'group';

export interface ExplorerNode<T = unknown> {
  /** Unique, stable id (`folder:/a`, `doc:<id>`, `stage:<id>`). */
  id: string;
  kind: ExplorerNodeKind;
  label: string;
  /** Folder path for folders; containing folder for docs. */
  path: string;
  children: ExplorerNode<T>[];
  /** Payload (the document, stage info, ...). */
  data?: T;
}

export interface FlatRow<T = unknown> {
  node: ExplorerNode<T>;
  /** 1-based depth (aria-level). */
  level: number;
  /** 1-based index among siblings (aria-posinset). */
  posInSet: number;
  /** Sibling count (aria-setsize). */
  setSize: number;
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
}

export const folderId = (path: string) => `folder:${path}`;
export const docId = (id: string) => `doc:${id}`;
export const stageId = (id: string) => `stage:${id}`;
export const isDocId = (id: string) => id.startsWith('doc:');
export const NO_STAGE = '__none__';

// ── Path math (shared with FileTree and its tests) ───────────────

/** Rewrite `oldPrefix` (and descendants) to `newPrefix`; segment aware. */
export function rewriteDescendantPaths(
  items: string[],
  oldPrefix: string,
  newPrefix: string,
): string[] {
  return items.map((p) => {
    if (p === oldPrefix) return newPrefix;
    if (p.startsWith(`${oldPrefix}/`)) return newPrefix + p.substring(oldPrefix.length);
    return p;
  });
}

/** True if moving `sourcePath` into `targetParentPath` would put a folder inside itself. */
export function wouldCreateCycle(sourcePath: string, targetParentPath: string): boolean {
  if (targetParentPath === sourcePath) return true;
  return targetParentPath.startsWith(`${sourcePath}/`);
}

/** New path of `sourcePath` after re-parenting under `targetParentPath` (`/` for root). */
export function computeMovedFolderPath(sourcePath: string, targetParentPath: string): string {
  const leaf = sourcePath.substring(sourcePath.lastIndexOf('/') + 1);
  return targetParentPath === '/' ? `/${leaf}` : `${targetParentPath}/${leaf}`;
}

/** Folder paths equal to or under `parentPath`. */
export function getDescendantFolders(folders: string[], parentPath: string): string[] {
  const prefix = parentPath === '/' ? '/' : `${parentPath}/`;
  return folders.filter((f) => f === parentPath || f.startsWith(prefix));
}

/** Parent folder path of a folder or doc path (`/` for top level). */
export function parentPath(path: string): string {
  return path.substring(0, path.lastIndexOf('/')) || '/';
}

// ── Tree construction ────────────────────────────────────────────

const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function sortNodes<T>(nodes: ExplorerNode<T>[]): ExplorerNode<T>[] {
  const rank = (n: ExplorerNode<T>) => (n.kind === 'doc' ? 1 : 0);
  nodes.sort((a, b) => rank(a) - rank(b) || byLabel(a.label, b.label));
  for (const n of nodes) if (n.kind === 'folder') sortNodes(n.children);
  return nodes;
}

/** Folder tree (folders first, then documents, each alphabetical). Empty folders are kept. */
export function buildFolderTree<D extends ExplorerDoc>(
  docs: D[],
  folders: string[],
): ExplorerNode<D>[] {
  const root: ExplorerNode<D> = { id: 'root', kind: 'folder', label: '', path: '/', children: [] };
  const index = new Map<string, ExplorerNode<D>>([['/', root]]);

  const ensure = (path: string): ExplorerNode<D> => {
    const existing = index.get(path);
    if (existing) return existing;
    const parent = ensure(parentPath(path));
    const node: ExplorerNode<D> = {
      id: folderId(path),
      kind: 'folder',
      label: path.substring(path.lastIndexOf('/') + 1),
      path,
      children: [],
    };
    parent.children.push(node);
    index.set(path, node);
    return node;
  };

  for (const f of folders) if (f && f !== '/') ensure(f.replace(/\/+$/, '') || '/');
  for (const d of docs) {
    const p = (d.path || '/').replace(/\/+$/, '') || '/';
    ensure(p).children.push({
      id: docId(d.id),
      kind: 'doc',
      label: d.title || 'Untitled',
      path: p,
      children: [],
      data: d,
    });
  }
  return sortNodes(root.children);
}

export interface StageLike {
  id: string;
  label: string;
}

/**
 * Group documents by lifecycle stage for the active pipeline. Stages keep pipeline order, a
 * trailing "No stage" group collects unstaged docs and docs whose stage is not in this pipeline.
 * Empty stages are kept so they remain valid drop targets.
 */
export function buildStageTree<D extends ExplorerDoc, S extends StageLike>(
  docs: D[],
  stages: S[],
): ExplorerNode<D | S>[] {
  const known = new Set(stages.map((s) => s.id));
  const groups = new Map<string, ExplorerNode<D | S>>();
  for (const s of stages) {
    groups.set(s.id, {
      id: stageId(s.id),
      kind: 'group',
      label: s.label,
      path: '/',
      children: [],
      data: s,
    });
  }
  const none: ExplorerNode<D | S> = {
    id: stageId(NO_STAGE),
    kind: 'group',
    label: 'No stage',
    path: '/',
    children: [],
  };
  for (const d of docs) {
    const g = d.stage && known.has(d.stage) ? groups.get(d.stage)! : none;
    g.children.push({
      id: docId(d.id),
      kind: 'doc',
      label: d.title || 'Untitled',
      path: d.path || '/',
      children: [],
      data: d,
    });
  }
  for (const g of [...groups.values(), none]) {
    g.children.sort((a, b) => byLabel(a.label, b.label));
  }
  return [...groups.values(), ...(none.children.length > 0 ? [none] : [])];
}

// ── Flattening / navigation ──────────────────────────────────────

/** Depth-first list of the rows currently visible given the expanded set. */
export function flattenVisible<T>(nodes: ExplorerNode<T>[], expanded: ReadonlySet<string>): FlatRow<T>[] {
  const out: FlatRow<T>[] = [];
  const walk = (list: ExplorerNode<T>[], level: number, parentId: string | null) => {
    list.forEach((node, i) => {
      const expandable = node.kind !== 'doc';
      const isOpen = expandable && expanded.has(node.id);
      out.push({
        node,
        level,
        posInSet: i + 1,
        setSize: list.length,
        parentId,
        expandable,
        expanded: isOpen,
      });
      if (isOpen) walk(node.children, level + 1, node.id);
    });
  };
  walk(nodes, 1, null);
  return out;
}

/** Index range `[start, end)` of rows to render for a scroll window. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 8,
): { start: number; end: number } {
  // A stale scrollTop (list shrank) must never push the window past the end.
  const first = Math.min(Math.floor(Math.max(0, scrollTop) / rowHeight), Math.max(0, total - 1));
  const count = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + count + overscan),
  };
}

/** Next row (after `from`, wrapping) whose label starts with `prefix`; -1 when none. */
export function findTypeahead<T>(rows: FlatRow<T>[], from: number, prefix: string): number {
  const p = prefix.toLowerCase();
  if (!p || rows.length === 0) return -1;
  // Repeating a single letter cycles through matches; a longer prefix may match the current row.
  const startOffset = p.length === 1 || new Set(p).size === 1 ? 1 : 0;
  const needle = new Set(p).size === 1 ? p[0] : p;
  for (let k = 0; k < rows.length; k++) {
    const i = (from + startOffset + k + rows.length) % rows.length;
    if (rows[i].node.label.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/** Ids of every expandable node in the tree (used for "expand all"). */
export function allExpandableIds<T>(nodes: ExplorerNode<T>[]): string[] {
  const out: string[] = [];
  const walk = (list: ExplorerNode<T>[]) => {
    for (const n of list) {
      if (n.kind !== 'doc') {
        out.push(n.id);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}
