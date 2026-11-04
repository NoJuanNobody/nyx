import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  findTypeahead,
  flattenVisible,
  visibleRange,
  wouldCreateCycle,
  type ExplorerNode,
  type FlatRow,
} from '../lib/explorerTree';

/** MIME types for drag and drop payloads (kept stable: other components and tests rely on them). */
export const DRAG_MIME_DOC = 'application/nyx-doc-id';
export const DRAG_MIME_FOLDER = 'application/nyx-folder-path';

export type DragPayload = { kind: 'doc'; id: string } | { kind: 'folder'; path: string };

/** Synthetic row id for the inline "new folder" input. */
export const CREATING_ID = '__creating__';

// The HTML5 DnD API hides payloads during dragover, so the in-flight source is stashed here to
// support live cycle detection.
let activeDrag: DragPayload | null = null;

export interface CreatingRow {
  /** Node id of the parent to create inside; `null` for the root. */
  parentId: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export interface ExplorerTreeProps<T> {
  nodes: ExplorerNode<T>[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  ariaLabel: string;
  selectedId?: string | null;
  onActivate?: (node: ExplorerNode<T>) => void;
  onRename?: (node: ExplorerNode<T>) => void;
  onDelete?: (node: ExplorerNode<T>) => void;
  /** `node` is `null` for the empty area (root). */
  onContextMenu?: (pos: { x: number; y: number }, node: ExplorerNode<T> | null) => void;
  /** Drop (or keyboard paste) of `source` onto `target`; `null` target is the root. */
  onMove?: (source: DragPayload, target: ExplorerNode<T> | null) => void;
  /** Extra veto for drops; cycle checks are built in. */
  canDrop?: (source: DragPayload, target: ExplorerNode<T> | null) => boolean;
  renamingId?: string | null;
  onRenameSubmit?: (node: ExplorerNode<T>, value: string) => void;
  onRenameCancel?: () => void;
  creating?: CreatingRow | null;
  renderBadge?: (node: ExplorerNode<T>) => ReactNode;
  renderActions?: (node: ExplorerNode<T>) => ReactNode;
  emptyState?: ReactNode;
  rowHeight?: number;
  /** Viewport height assumed until the element can be measured (jsdom, first paint). */
  fallbackHeight?: number;
  className?: string;
}

function payloadOf<T>(node: ExplorerNode<T>): DragPayload | null {
  if (node.kind === 'doc') return { kind: 'doc', id: node.id.replace(/^doc:/, '') };
  if (node.kind === 'folder') return { kind: 'folder', path: node.path };
  return null;
}

/** Whether `source` may land on `target` (groups accept documents only). */
export function isDropAllowed<T>(source: DragPayload, target: ExplorerNode<T> | null): boolean {
  if (target === null) return true;
  if (target.kind === 'doc') return false;
  if (source.kind === 'folder') {
    return target.kind === 'folder' && !wouldCreateCycle(source.path, target.path);
  }
  return true;
}

function InlineInput({
  initial,
  label,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && value.trim()) onSubmit(value.trim());
    else onCancel();
  };
  return (
    <input
      ref={ref}
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className="w-full bg-transparent text-xs text-slate-800 outline-none border-b border-blue-400 py-0.5"
      spellCheck={false}
    />
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    aria-hidden="true"
    className={`h-3 w-3 flex-shrink-0 text-slate-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2}
    stroke="currentColor"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
  </svg>
);

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg
    aria-hidden="true"
    className={`h-4 w-4 flex-shrink-0 ${open ? 'text-blue-500' : 'text-slate-400'}`}
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
    />
  </svg>
);

const DocIcon = () => (
  <svg
    aria-hidden="true"
    className="h-3.5 w-3.5 flex-shrink-0 opacity-50"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
    />
  </svg>
);

/**
 * Accessible, virtualized, keyboard-driven tree (WAI-ARIA tree pattern with a flat DOM:
 * `aria-level`, `aria-posinset` and `aria-setsize` carry the structure so only visible rows exist).
 *
 * Keys: Up/Down move, Right expands or enters, Left collapses or goes to the parent,
 * Home/End, Enter/Space activate, F2 rename, Delete remove, Shift+F10 / ContextMenu opens the menu,
 * Ctrl/Cmd+X then Ctrl/Cmd+V moves (keyboard alternative to drag and drop), type to jump.
 */
export function ExplorerTree<T>({
  nodes,
  expanded,
  onToggle,
  ariaLabel,
  selectedId = null,
  onActivate,
  onRename,
  onDelete,
  onContextMenu,
  onMove,
  canDrop,
  renamingId = null,
  onRenameSubmit,
  onRenameCancel,
  creating = null,
  renderBadge,
  renderActions,
  emptyState,
  rowHeight = 28,
  fallbackHeight = 480,
  className = '',
}: ExplorerTreeProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const wantFocus = useRef(false);
  const typed = useRef({ text: '', at: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(fallbackHeight);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [cutId, setCutId] = useState<string | null>(null);

  const rows = useMemo<FlatRow<T>[]>(() => {
    const flat = flattenVisible(nodes, expanded);
    if (!creating) return flat;
    const parentIdx = creating.parentId ? flat.findIndex((r) => r.node.id === creating.parentId) : -1;
    if (creating.parentId && parentIdx < 0) return flat;
    const level = creating.parentId ? flat[parentIdx].level + 1 : 1;
    let at = flat.length;
    if (creating.parentId) {
      at = parentIdx + 1;
      while (at < flat.length && flat[at].level > flat[parentIdx].level) at++;
    }
    const synthetic: FlatRow<T> = {
      node: { id: CREATING_ID, kind: 'folder', label: '', path: '', children: [] },
      level,
      posInSet: 1,
      setSize: 1,
      parentId: creating.parentId,
      expandable: false,
      expanded: false,
    };
    return [...flat.slice(0, at), synthetic, ...flat.slice(at)];
  }, [nodes, expanded, creating]);

  // Keep the roving tabindex on a row that exists.
  const activeIndex = useMemo(() => {
    const i = rows.findIndex((r) => r.node.id === activeId);
    if (i >= 0) return i;
    const sel = rows.findIndex((r) => r.node.id === selectedId);
    return sel >= 0 ? sel : rows.length > 0 ? 0 : -1;
  }, [rows, activeId, selectedId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setViewport(el.clientHeight || fallbackHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallbackHeight]);

  const { start, end } = visibleRange(scrollTop, viewport, rowHeight, rows.length);
  const activeRendered = activeIndex >= start && activeIndex < end;

  const moveActive = useCallback(
    (index: number) => {
      if (index < 0 || index >= rows.length) return;
      const el = scrollRef.current;
      if (el) {
        const top = index * rowHeight;
        const vh = el.clientHeight || viewport;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + rowHeight > el.scrollTop + vh) el.scrollTop = top + rowHeight - vh;
        setScrollTop(el.scrollTop);
      }
      wantFocus.current = true;
      setActiveId(rows[index].node.id);
    },
    [rows, rowHeight, viewport],
  );

  // Move DOM focus once the target row is rendered.
  useEffect(() => {
    if (!wantFocus.current) return;
    const id = rows[activeIndex]?.node.id;
    const el = id ? rowRefs.current.get(id) : undefined;
    if (el) {
      wantFocus.current = false;
      el.focus({ preventScroll: true });
    }
  });

  const menuAt = (row: HTMLElement | null, node: ExplorerNode<T>) => {
    const r = row?.getBoundingClientRect();
    onContextMenu?.({ x: r ? r.left + 24 : 0, y: r ? r.bottom : 0 }, node);
  };

  const allowed = (source: DragPayload, target: ExplorerNode<T> | null) =>
    isDropAllowed(source, target) && (canDrop ? canDrop(source, target) : true);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!rowEl || e.target !== rowEl) return; // typing in the rename input etc.
    const index = rows.findIndex((r) => r.node.id === rowEl.dataset.nodeId);
    if (index < 0) return;
    const row = rows[index];
    const node = row.node;
    const mod = e.ctrlKey || e.metaKey;

    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    switch (e.key) {
      case 'ArrowDown':
        handled();
        moveActive(Math.min(rows.length - 1, index + 1));
        return;
      case 'ArrowUp':
        handled();
        moveActive(Math.max(0, index - 1));
        return;
      case 'Home':
        handled();
        moveActive(0);
        return;
      case 'End':
        handled();
        moveActive(rows.length - 1);
        return;
      case 'ArrowRight':
        handled();
        if (row.expandable && !row.expanded) onToggle(node.id);
        else if (row.expanded && rows[index + 1]?.parentId === node.id) moveActive(index + 1);
        return;
      case 'ArrowLeft':
        handled();
        if (row.expanded) onToggle(node.id);
        else if (row.parentId) moveActive(rows.findIndex((r) => r.node.id === row.parentId));
        return;
      case 'Enter':
      case ' ':
        handled();
        if (node.kind === 'doc') onActivate?.(node);
        else onToggle(node.id);
        return;
      case 'F2':
        if (onRename && node.kind !== 'group') {
          handled();
          onRename(node);
        }
        return;
      case 'Delete':
        if (onDelete && node.kind !== 'group') {
          handled();
          onDelete(node);
        }
        return;
      case 'Backspace':
        if (e.metaKey && onDelete && node.kind !== 'group') {
          handled();
          onDelete(node);
        }
        return;
      case 'ContextMenu':
        handled();
        menuAt(rowEl, node);
        return;
      case 'F10':
        if (e.shiftKey) {
          handled();
          menuAt(rowEl, node);
        }
        return;
      default:
    }

    if (mod && (e.key === 'x' || e.key === 'X') && payloadOf(node)) {
      handled();
      setCutId(node.id);
      return;
    }
    if (mod && (e.key === 'v' || e.key === 'V') && cutId) {
      handled();
      const src = rows.find((r) => r.node.id === cutId)?.node ?? null;
      const source = src ? payloadOf(src) : null;
      // Paste into the focused folder/group, or next to the focused document.
      const target =
        node.kind === 'doc' ? (rows.find((r) => r.node.id === row.parentId)?.node ?? null) : node;
      if (source && allowed(source, target)) onMove?.(source, target);
      setCutId(null);
      return;
    }

    // Type-ahead
    if (e.key.length === 1 && !mod && !e.altKey) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > 600 ? e.key : t.text + e.key;
      t.at = now;
      const hit = findTypeahead(rows, index, t.text);
      if (hit >= 0) {
        handled();
        moveActive(hit);
      }
    }
  };

  const onRowDragStart = (e: React.DragEvent, node: ExplorerNode<T>) => {
    const p = payloadOf(node);
    if (!p || renamingId === node.id) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    e.dataTransfer.setData(p.kind === 'doc' ? DRAG_MIME_DOC : DRAG_MIME_FOLDER, p.kind === 'doc' ? p.id : p.path);
    e.dataTransfer.effectAllowed = 'move';
    activeDrag = p;
  };

  const readPayload = (e: React.DragEvent): DragPayload | null => {
    const doc = e.dataTransfer.getData(DRAG_MIME_DOC);
    if (doc) return { kind: 'doc', id: doc };
    const folder = e.dataTransfer.getData(DRAG_MIME_FOLDER);
    if (folder) return { kind: 'folder', path: folder };
    return null;
  };

  const hasDragType = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(DRAG_MIME_DOC) || e.dataTransfer.types.includes(DRAG_MIME_FOLDER);

  const onRowDragOver = (e: React.DragEvent, node: ExplorerNode<T>) => {
    if (!hasDragType(e)) return;
    const src = activeDrag;
    if (src ? !allowed(src, node) : node.kind === 'doc') {
      e.dataTransfer.dropEffect = 'none';
      setDragOverId(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(node.id);
  };

  const onRowDrop = (e: React.DragEvent, node: ExplorerNode<T>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
    const source = readPayload(e) ?? activeDrag;
    activeDrag = null;
    if (source && allowed(source, node)) onMove?.(source, node);
  };

  const renderRow = (row: FlatRow<T>, index: number) => {
    const { node } = row;
    if (node.id === CREATING_ID) {
      return (
        <div
          key={CREATING_ID}
          role="treeitem"
          aria-level={row.level}
          aria-posinset={1}
          aria-setsize={1}
          aria-selected={false}
          data-node-id={CREATING_ID}
          style={{ height: rowHeight, paddingLeft: `${(row.level - 1) * 12 + 8}px` }}
          className="flex items-center gap-1 px-2"
        >
          <span className="h-3 w-3 flex-shrink-0" />
          <FolderIcon open />
          {creating && (
            <InlineInput
              initial=""
              label="New folder name"
              onSubmit={creating.onSubmit}
              onCancel={creating.onCancel}
            />
          )}
        </div>
      );
    }
    const isRenaming = renamingId === node.id;
    const isSelected = selectedId === node.id;
    const isActive = index === activeIndex;
    const isDrop = dragOverId === node.id;
    const color = isDrop
      ? 'bg-blue-100 ring-1 ring-blue-300'
      : isSelected
        ? 'bg-blue-50 text-blue-700'
        : node.kind === 'doc'
          ? 'text-slate-600 hover:bg-slate-100/60 hover:text-slate-900'
          : 'hover:bg-slate-100/60';
    return (
      <div
        key={node.id}
        ref={(el) => {
          if (el) rowRefs.current.set(node.id, el);
          else rowRefs.current.delete(node.id);
        }}
        role="treeitem"
        aria-level={row.level}
        aria-posinset={row.posInSet}
        aria-setsize={row.setSize}
        aria-expanded={row.expandable ? row.expanded : undefined}
        aria-selected={isSelected}
        data-cut={cutId === node.id ? 'true' : undefined}
        data-node-id={node.id}
        data-kind={node.kind}
        tabIndex={isActive ? 0 : -1}
        draggable={!isRenaming && node.kind !== 'group'}
        style={{ height: rowHeight, paddingLeft: `${(row.level - 1) * 12 + 8}px` }}
        className={`group flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 ${color} ${cutId === node.id ? 'opacity-50' : ''}`}
        onClick={() => {
          if (isRenaming) return;
          setActiveId(node.id);
          if (node.kind === 'doc') onActivate?.(node);
          else onToggle(node.id);
        }}
        onDoubleClick={() => {
          if (node.kind === 'doc' && !isRenaming) onRename?.(node);
        }}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setActiveId(node.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setActiveId(node.id);
          onContextMenu?.({ x: e.clientX, y: e.clientY }, node);
        }}
        onDragStart={(e) => onRowDragStart(e, node)}
        onDragEnd={() => {
          activeDrag = null;
          setDragOverId(null);
        }}
        onDragOver={(e) => onRowDragOver(e, node)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null);
        }}
        onDrop={(e) => onRowDrop(e, node)}
      >
        {node.kind === 'doc' ? (
          <>
            <span className="h-3 w-3 flex-shrink-0" />
            <DocIcon />
          </>
        ) : (
          <>
            <Chevron open={row.expanded} />
            {node.kind === 'folder' && <FolderIcon open={row.expanded} />}
          </>
        )}
        {isRenaming ? (
          <InlineInput
            initial={node.label}
            label={`Rename ${node.label}`}
            onSubmit={(v) => onRenameSubmit?.(node, v)}
            onCancel={() => onRenameCancel?.()}
          />
        ) : (
          <span
            className={`flex-1 truncate text-xs ${node.kind === 'doc' ? '' : 'font-medium text-slate-700'}`}
          >
            {node.label}
          </span>
        )}
        {!isRenaming && node.kind === 'group' && (
          <span className="text-[10px] text-slate-400" aria-label={`${node.children.length} documents`}>
            {node.children.length}
          </span>
        )}
        {!isRenaming && renderBadge?.(node)}
        {!isRenaming && renderActions && (
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {renderActions(node)}
          </span>
        )}
      </div>
    );
  };

  const isEmpty = nodes.length === 0 && !creating;

  return (
    <div
      ref={scrollRef}
      className={`min-h-0 flex-1 overflow-y-auto px-1 pb-4 ${className}`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.explorerSpacer) {
          e.preventDefault();
          onContextMenu?.({ x: e.clientX, y: e.clientY }, null);
        }
      }}
      onDragOver={(e) => {
        if (!hasDragType(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const source = readPayload(e) ?? activeDrag;
        activeDrag = null;
        setDragOverId(null);
        if (source && allowed(source, null)) onMove?.(source, null);
      }}
    >
      {isEmpty ? (
        emptyState
      ) : (
        <div
          role="tree"
          aria-label={ariaLabel}
          aria-multiselectable={false}
          tabIndex={activeRendered ? -1 : 0}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // The active row is scrolled out of the window: bring it back and focus it.
            if (e.target === e.currentTarget && activeIndex >= 0) moveActive(activeIndex);
          }}
          className="outline-none"
        >
          <div aria-hidden="true" data-explorer-spacer="top" style={{ height: start * rowHeight }} />
          {rows.slice(start, end).map((row, i) => renderRow(row, start + i))}
          <div
            aria-hidden="true"
            data-explorer-spacer="bottom"
            style={{ height: Math.max(0, rows.length - end) * rowHeight }}
          />
        </div>
      )}
    </div>
  );
}
