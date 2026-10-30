import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document, DocumentTemplate } from '@nyx/shared';
import {
  fetchDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  fetchTeams,
  fetchTemplates,
} from '../lib/api';
import { STAGE_MAP, type DocumentStage } from '../lib/stages';
import { getLifecycle, getStageInfo } from '../lib/lifecycles';
import { useUIStore } from '../stores/ui.store';
import { TemplatePicker } from './TemplatePicker';
import {
  ContextMenu,
  type ContextMenuState,
  type ContextMenuItem,
  type ContextMenuLeafItem,
  type ContextMenuSeparator,
} from './ContextMenu';
import { BulkTicketReview } from './BulkTicketReview';
import { ExplorerTree, type DragPayload } from './ExplorerTree';
import {
  NO_STAGE,
  buildFolderTree,
  buildStageTree,
  computeMovedFolderPath,
  docId as docNodeId,
  folderId,
  getDescendantFolders,
  rewriteDescendantPaths,
  stageId as stageNodeId,
  wouldCreateCycle,
  type ExplorerNode,
} from '../lib/explorerTree';

// ── Folder persistence (localStorage) ─────────────────

const FOLDERS_KEY = 'nyx:folders';

function loadFolders(): string[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveFolders(folders: string[]) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

const VIEW_KEY = 'nyx:explorer-view';

function loadViewMode(): 'folders' | 'stages' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'stages' ? 'stages' : 'folders';
  } catch {
    return 'folders';
  }
}

// ── Tree helpers (pure; shared with tests via lib/explorerTree) ──────

export {
  rewriteDescendantPaths,
  wouldCreateCycle,
  computeMovedFolderPath,
} from '../lib/explorerTree';

// ── Main FileTree component ───────────────────────────

export function FileTree() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['/']));
  const [creatingFolderAt, setCreatingFolderAt] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>(loadFolders);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'folders' | 'stages'>(loadViewMode);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [bulkTicketFolderPath, setBulkTicketFolderPath] = useState<string | null>(null);
  const seeding = useUIStore((s) => s.seeding);
  const activeLifecycleSlug = useUIStore((s) => s.activeLifecycleSlug);
  const activeLifecycle = getLifecycle(activeLifecycleSlug);
  const activeStages = activeLifecycle.stages;

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const teamId = teams?.[0]?.id;
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: documents, isLoading } = useQuery<Document[]>({
    queryKey: ['documents', teamId],
    queryFn: () => fetchDocuments(teamId!),
    enabled: !!teamId,
  });

  // Pre-fetch templates so context menu opens instantly
  const { data: templates } = useQuery<DocumentTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
    staleTime: 5 * 60 * 1000, // 5 min
  });

  // Sync folders from document paths — ensures folders appear even if localStorage is empty
  useEffect(() => {
    if (!documents) return;
    const docPaths = new Set<string>();
    for (const doc of documents) {
      const p = doc.path || '/';
      if (p !== '/') {
        docPaths.add(p);
        // Also add parent folders (e.g. "/a/b" → add "/a")
        const parts = p.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          docPaths.add('/' + parts.slice(0, i).join('/'));
        }
      }
    }
    if (docPaths.size === 0) return;
    setFolders((prev) => {
      const merged = new Set(prev);
      let changed = false;
      for (const p of docPaths) {
        if (!merged.has(p)) {
          merged.add(p);
          changed = true;
        }
      }
      if (!changed) return prev;
      const next = [...merged];
      saveFolders(next);
      return next;
    });
  }, [documents]);

  // Group templates by stage for fast lookup (dynamic based on active lifecycle)
  const templatesByStage = useMemo(() => {
    const map: Record<string, DocumentTemplate[]> = {};
    for (const stage of activeStages) {
      map[stage.id] = [];
    }
    for (const t of templates ?? []) {
      const stageKey = t.stage as string | undefined;
      if (stageKey && stageKey in map) {
        // Deduplicate by name within each stage (safety net for duplicate DB rows)
        if (!map[stageKey].some((existing) => existing.name === t.name)) {
          map[stageKey].push(t);
        }
      }
    }
    return map;
  }, [templates, activeStages]);

  const createMutation = useMutation({
    mutationFn: (data: { title: string; content: string; teamId: string; path: string; stage?: DocumentStage | null; templateId?: string }) =>
      createDocument(data),
    onSuccess: (doc) => {
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      navigate(`/app/documents/${doc.id}`);
    },
    onError: (err: unknown) => {
      setCreateError(err instanceof Error ? err.message : 'Failed to create document.');
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      updateDocument(id, { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      setRenamingDocId(null);
    },
  });

  const softDeleteMutation = useMutation({
    mutationFn: (id: string) => deleteDocument(id),
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      // Navigate away if the deleted doc is currently open
      if (location.pathname === `/app/documents/${deletedId}`) {
        navigate('/app/dashboard');
      }
    },
  });

  const updateStageMutation = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: DocumentStage | null }) =>
      updateDocument(id, { stage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
    },
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) =>
      updateDocument(id, { path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
    },
  });

  const handleDropDoc = useCallback(
    (docId: string, targetPath: string) => {
      // Don't move if already in target folder
      const doc = documents?.find((d) => d.id === docId);
      if (!doc || (doc.path || '/') === targetPath) return;
      moveMutation.mutate({ id: docId, path: targetPath });
    },
    [documents, moveMutation],
  );

  const duplicateMutation = useMutation({
    mutationFn: (doc: Document) => {
      const docWithStage = doc as Document & { stage?: DocumentStage | null };
      return createDocument({
        title: `${doc.title || 'Untitled'} (copy)`,
        content: doc.content || '',
        teamId: teamId!,
        path: doc.path || '/',
        stage: docWithStage.stage ?? null,
      });
    },
    onSuccess: (newDoc) => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      navigate(`/app/documents/${newDoc.id}`);
    },
  });

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleCreateDoc = (path: string) => {
    if (!teamId) {
      setCreateError('No team available yet — refresh or check your team membership.');
      return;
    }
    createMutation.mutate({ title: 'Untitled Document', content: '', teamId, path });
  };

  const handleCreateFolder = (parentPath: string) => {
    setExpandedFolders((prev) => new Set(prev).add(parentPath));
    setCreatingFolderAt(parentPath);
  };

  const handleFolderNameSubmit = (parentPath: string, name: string) => {
    const newPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
    const updated = [...folders, newPath];
    setFolders(updated);
    saveFolders(updated);
    setExpandedFolders((prev) => new Set(prev).add(newPath));
    setCreatingFolderAt(null);
  };

  const handleFolderNameCancel = () => {
    setCreatingFolderAt(null);
  };

  const handleDocRenameSubmit = (docId: string, newTitle: string) => {
    if (newTitle === '__DELETE__') {
      softDeleteMutation.mutate(docId);
      setRenamingDocId(null);
      return;
    }
    renameMutation.mutate({ id: docId, title: newTitle });
  };

  const handleFolderRenameSubmit = (oldPath: string, newName: string) => {
    // If newName is empty, start renaming mode
    if (!newName) {
      setRenamingFolderPath(oldPath);
      return;
    }

    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
    const newPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;

    applyFolderMove(oldPath, newPath);
    setRenamingFolderPath(null);
  };

  /**
   * Shared core for both folder-rename and folder-move (drag-and-drop).
   * Rewrites folders list, expandedFolders set, and persists updated doc paths
   * for every descendant of `oldPath`.
   */
  const applyFolderMove = useCallback(
    (oldPath: string, newPath: string) => {
      if (oldPath === newPath) return;

      // Rewrite the folders list
      const updatedFolders = rewriteDescendantPaths(folders, oldPath, newPath);
      setFolders(updatedFolders);
      saveFolders(updatedFolders);

      // Rewrite expandedFolders so anything that was expanded under the old
      // path stays expanded under the new path.
      setExpandedFolders((prev) => {
        const rewritten = rewriteDescendantPaths([...prev], oldPath, newPath);
        return new Set(rewritten);
      });

      // Persist new paths for every descendant document
      if (documents) {
        for (const doc of documents) {
          const docPath = doc.path || '/';
          if (docPath === oldPath) {
            updateDocument(doc.id, { path: newPath });
          } else if (docPath.startsWith(`${oldPath}/`)) {
            updateDocument(doc.id, {
              path: newPath + docPath.substring(oldPath.length),
            });
          }
        }
        queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      }
    },
    [folders, documents, queryClient, teamId],
  );

  const handleDropFolder = useCallback(
    (sourcePath: string, targetParentPath: string) => {
      // Cycle / self guards
      if (wouldCreateCycle(sourcePath, targetParentPath)) return;

      const newPath = computeMovedFolderPath(sourcePath, targetParentPath);

      // No-op when already living at the target location
      if (newPath === sourcePath) return;

      applyFolderMove(sourcePath, newPath);
    },
    [applyFolderMove],
  );

  const handleDeleteFolder = (folderPath: string) => {
    // Remove the folder and all its descendant folders
    const descendants = getDescendantFolders(folders, folderPath);
    const updated = folders.filter((f) => !descendants.includes(f));
    setFolders(updated);
    saveFolders(updated);

    // Soft-delete all documents in the folder and subfolders
    if (documents) {
      for (const doc of documents) {
        const docPath = doc.path || '/';
        if (docPath === folderPath || docPath.startsWith(`${folderPath}/`)) {
          softDeleteMutation.mutate(doc.id);
        }
      }
    }
  };

  const handleOpenFolderSuggestions = (folderPath: string) => {
    if (!teamId) return;
    setBulkTicketFolderPath(folderPath);
  };

  // ── Menu item builders ────────────────────────────────

  function buildFolderMenuItems(
    path: string,
    isFolder: boolean,
  ): ContextMenuItem[] {
    const stageItems: ContextMenuItem[] = activeStages.map((stage) => {
      const stageTemplates = templatesByStage[stage.id] ?? [];
      const submenu: (ContextMenuLeafItem | ContextMenuSeparator)[] = [
        ...stageTemplates.map(
          (template): ContextMenuLeafItem => ({
            label: template.name,
            action: () => {
              if (!teamId) return;
              createMutation.mutate({
                title: template.name,
                content: template.content,
                teamId,
                path,
                stage: stage.id,
                templateId: template.id,
              });
            },
          }),
        ),
        ...(stageTemplates.length > 0
          ? ([{ type: 'separator' }] as ContextMenuSeparator[])
          : []),
        {
          label: `Blank ${stage.label} doc`,
          action: () => {
            if (!teamId) return;
            createMutation.mutate({
              title: `Untitled ${stage.label}`,
              content: '',
              teamId,
              path,
              stage: stage.id,
            });
          },
        },
      ];

      return {
        label: stage.label,
        abbr: stage.abbreviation,
        sublabel: stage.subtitle,
        tooltip: stage.description,
        dotColorClass: stage.dotColor,
        submenu,
      };
    });

    const items: ContextMenuItem[] = [
      {
        label: 'New blank document',
        action: () => handleCreateDoc(path),
      },
      {
        label: 'New subfolder',
        action: () => handleCreateFolder(path),
      },
      { type: 'separator' },
      ...stageItems,
      { type: 'separator' },
      {
        label: 'Browse all templates…',
        action: () => setShowTemplatePicker(true),
      },
    ];

    if (isFolder) {
      // Build "Move to..." submenu listing valid destination folders. Exclude
      // the source folder itself and any of its descendants (cycle prevention),
      // and also exclude the folder's current parent (no-op move).
      const currentParent = path.substring(0, path.lastIndexOf('/')) || '/';
      const destinations: (ContextMenuLeafItem | ContextMenuSeparator)[] = [];

      // Always allow moving back to root, unless already there
      if (currentParent !== '/') {
        destinations.push({
          label: '/  (root)',
          action: () => handleDropFolder(path, '/'),
        });
      }

      const validTargets = folders
        .filter((f) => !wouldCreateCycle(path, f) && f !== currentParent)
        .sort((a, b) => a.localeCompare(b));

      if (validTargets.length > 0 && destinations.length > 0) {
        destinations.push({ type: 'separator' });
      }
      for (const target of validTargets) {
        destinations.push({
          label: target,
          action: () => handleDropFolder(path, target),
        });
      }

      items.push(
        { type: 'separator' },
        {
          label: 'Generate ticket suggestions',
          action: () => handleOpenFolderSuggestions(path),
        },
        { type: 'separator' },
        { label: 'Rename folder', action: () => setRenamingFolderPath(path) },
        destinations.length > 0
          ? {
              label: 'Move to…',
              submenu: destinations,
            }
          : ({
              label: 'Move to…',
              disabled: true,
              action: () => {},
            } as ContextMenuLeafItem),
        { label: 'Delete folder', danger: true, action: () => handleDeleteFolder(path) },
      );
    }

    return items;
  }

  function buildDocMenuItems(doc: Document): ContextMenuItem[] {
    const docStage =
      (doc as Document & { stage?: DocumentStage | null }).stage ?? null;

    const setStageSubmenu: (ContextMenuLeafItem | ContextMenuSeparator)[] = [
      ...activeStages.map(
        (stage): ContextMenuLeafItem => ({
          label: stage.label,
          dotColorClass: stage.dotColor,
          checked: docStage === stage.id,
          action: () => {
            updateStageMutation.mutate({ id: doc.id, stage: stage.id });
          },
        }),
      ),
      { type: 'separator' },
      {
        label: 'Remove stage',
        checked: docStage === null,
        action: () => {
          updateStageMutation.mutate({ id: doc.id, stage: null });
        },
      },
    ];

    return [
      { label: 'Rename', action: () => setRenamingDocId(doc.id) },
      {
        label: 'Duplicate',
        action: () => {
          if (!teamId) return;
          duplicateMutation.mutate(doc);
        },
      },
      { type: 'separator' },
      {
        label: 'Set stage',
        submenu: setStageSubmenu,
      },
      { type: 'separator' },
      { label: 'Delete', danger: true, action: () => softDeleteMutation.mutate(doc.id) },
    ];
  }

  const handleContextMenu = (
    e: React.MouseEvent,
    targetPath: string,
    targetType: 'folder' | 'doc' | 'root',
    doc?: Document,
  ) => {
    let items: ContextMenuItem[];
    if (targetType === 'doc' && doc) {
      items = buildDocMenuItems(doc);
    } else {
      items = buildFolderMenuItems(targetPath, targetType === 'folder');
    }
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Apply client-side stage filter
  const docStageOf = (doc: Document) => (doc as Document & { stage?: string | null }).stage ?? null;
  const filteredDocs = (documents ?? []).filter((doc) => {
    if (stageFilter === 'all') return true;
    if (stageFilter === 'none') return !docStageOf(doc);
    return docStageOf(doc) === stageFilter;
  });

  const nodes: ExplorerNode<unknown>[] = useMemo(
    () =>
      viewMode === 'stages'
        ? buildStageTree(
            filteredDocs.map((d) => ({ id: d.id, title: d.title, path: d.path, stage: docStageOf(d), doc: d })),
            activeStages.map((st) => ({ id: st.id, label: st.label })),
          )
        : buildFolderTree(
            filteredDocs.map((d) => ({ id: d.id, title: d.title, path: d.path, stage: docStageOf(d), doc: d })),
            // While filtering, only folders that still contain a match are shown.
            stageFilter === 'all' ? folders : [],
          ),
    [viewMode, documents, stageFilter, folders, activeStages],
  );

  const docOf = (node: ExplorerNode<unknown>): Document | undefined =>
    node.kind === 'doc' ? (node.data as { doc?: Document } | undefined)?.doc : undefined;

  const expandedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of expandedFolders) ids.add(folderId(p));
    if (viewMode === 'stages') {
      for (const st of activeStages) if (!collapsedStages.has(st.id)) ids.add(stageNodeId(st.id));
      if (!collapsedStages.has(NO_STAGE)) ids.add(stageNodeId(NO_STAGE));
    }
    return ids;
  }, [expandedFolders, collapsedStages, viewMode, activeStages]);

  const handleToggleNode = (id: string) => {
    if (id.startsWith('folder:')) toggleFolder(id.slice('folder:'.length));
    else if (id.startsWith('stage:')) {
      const sid = id.slice('stage:'.length);
      setCollapsedStages((prev) => {
        const next = new Set(prev);
        if (next.has(sid)) next.delete(sid);
        else next.add(sid);
        return next;
      });
    }
  };

  const handleMove = (source: DragPayload, target: ExplorerNode<unknown> | null) => {
    if (target?.kind === 'group') {
      if (source.kind !== 'doc') return;
      const sid = target.id.slice('stage:'.length);
      updateStageMutation.mutate({ id: source.id, stage: sid === NO_STAGE ? null : sid });
      return;
    }
    if (viewMode === 'stages') return; // folder moves are only meaningful in the folder view
    const targetPath = target ? target.path : '/';
    if (source.kind === 'doc') handleDropDoc(source.id, targetPath);
    else handleDropFolder(source.path, targetPath);
  };

  const handleDeleteNode = (node: ExplorerNode<unknown>) => {
    const doc = docOf(node);
    if (doc) {
      handleDocRenameSubmit(doc.id, '__DELETE__');
      return;
    }
    if (node.kind !== 'folder') return;
    const contained = (documents ?? []).filter((d) => {
      const p = d.path || '/';
      return p === node.path || p.startsWith(`${node.path}/`);
    }).length;
    if (
      contained > 0 &&
      typeof window.confirm === 'function' &&
      !window.confirm(`Delete "${node.label}" and its ${contained} document${contained === 1 ? '' : 's'}?`)
    ) {
      return;
    }
    handleDeleteFolder(node.path);
  };

  const handleTreeContextMenu = (pos: { x: number; y: number }, node: ExplorerNode<unknown> | null) => {
    const fake = { clientX: pos.x, clientY: pos.y } as React.MouseEvent;
    if (!node) {
      if (viewMode === 'folders') handleContextMenu(fake, '/', 'root');
      return;
    }
    const doc = docOf(node);
    if (doc) handleContextMenu(fake, doc.id, 'doc', doc);
    else if (node.kind === 'folder') handleContextMenu(fake, node.path, 'folder');
  };

  const selectedNodeId = (() => {
    const m = /^\/app\/documents\/([^/]+)/.exec(location.pathname);
    return m ? docNodeId(m[1]) : null;
  })();

  const hasContent = (documents?.length ?? 0) > 0 || folders.length > 0 || !!creatingFolderAt;
  const emptyState = isLoading ? (
    <p className="px-4 py-3 text-xs text-slate-400">Loading...</p>
  ) : !hasContent ? (
    <div className="px-4 py-6 text-center">
      <p className="text-xs text-slate-400 mb-3">No documents yet</p>
      <button
        type="button"
        onClick={() => handleCreateDoc('/')}
        disabled={createMutation.isPending}
        className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        <svg className="h-3 w-3" aria-hidden="true" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        New Document
      </button>
    </div>
  ) : (
    <div className="px-4 py-6 text-center">
      <p className="text-xs text-slate-400 mb-3">No documents in this stage</p>
      <button
        type="button"
        onClick={() => setStageFilter('all')}
        className="text-xs font-medium text-blue-600 hover:underline"
      >
        Show all stages
      </button>
    </div>
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Seeding overlay — blocks interaction while seed definition is loading */}
      {seeding && (
        <div
          data-testid="seed-loading-overlay"
          className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm"
        >
          <svg
            className="h-6 w-6 animate-spin text-blue-600"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="mt-2 text-xs font-medium text-slate-500">
            Seeding next stage...
          </span>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Explorer
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="New from template"
            aria-label="New from template"
            onClick={() => setShowTemplatePicker(true)}
            className="rounded p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
            </svg>
          </button>
          <button
            type="button"
            title="New document"
            aria-label="New document"
            onClick={() => handleCreateDoc('/')}
            className="rounded p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          </button>
          <button
            type="button"
            title="New folder"
            aria-label="New folder"
            disabled={viewMode === 'stages'}
            onClick={() => handleCreateFolder('/')}
            className="rounded p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-40"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
            </svg>
          </button>
        </div>
      </div>

      {createError && (
        <div role="alert" className="mx-4 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {createError}
        </div>
      )}

      {/* View mode: by folder or grouped by lifecycle stage */}
      <div className="px-4 pb-2" role="group" aria-label="Explorer view">
        <div className="flex rounded-md border border-slate-200 p-0.5 text-[11px]">
          {(['folders', 'stages'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => {
                setViewMode(mode);
                try {
                  localStorage.setItem(VIEW_KEY, mode);
                } catch {
                  /* storage unavailable */
                }
              }}
              className={`flex-1 rounded px-2 py-0.5 ${
                viewMode === mode ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {mode === 'folders' ? 'Folders' : 'Stages'}
            </button>
          ))}
        </div>
      </div>

      {/* Stage filter (stages of the active pipeline) */}
      <div className="px-4 pb-2">
        <select
          aria-label="Filter by stage"
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-100"
        >
          <option value="all">All stages</option>
          {activeStages.map((st) => (
            <option key={st.id} value={st.id}>
              {st.label}
            </option>
          ))}
          <option value="none">No stage</option>
        </select>
      </div>

      <ExplorerTree
        nodes={nodes}
        expanded={expandedIds}
        onToggle={handleToggleNode}
        ariaLabel={viewMode === 'stages' ? 'Documents by stage' : 'Documents and folders'}
        selectedId={selectedNodeId}
        onActivate={(node) => {
          const doc = docOf(node);
          if (doc) navigate(`/app/documents/${doc.id}`);
        }}
        onRename={(node) => {
          const doc = docOf(node);
          if (doc) setRenamingDocId(doc.id);
          else if (node.kind === 'folder') setRenamingFolderPath(node.path);
        }}
        onDelete={handleDeleteNode}
        onContextMenu={handleTreeContextMenu}
        onMove={handleMove}
        canDrop={(source, target) => {
          // Folders only move in the folder view; stage groups only take documents.
          if (viewMode === 'stages') return source.kind === 'doc' && target?.kind === 'group';
          return target?.kind !== 'group';
        }}
        renamingId={
          renamingDocId ? docNodeId(renamingDocId) : renamingFolderPath ? folderId(renamingFolderPath) : null
        }
        onRenameSubmit={(node, value) => {
          const doc = docOf(node);
          if (doc) handleDocRenameSubmit(doc.id, value);
          else handleFolderRenameSubmit(node.path, value);
        }}
        onRenameCancel={() => {
          setRenamingDocId(null);
          setRenamingFolderPath(null);
        }}
        creating={
          creatingFolderAt !== null && viewMode === 'folders'
            ? {
                parentId: creatingFolderAt === '/' ? null : folderId(creatingFolderAt),
                onSubmit: (name) => handleFolderNameSubmit(creatingFolderAt, name),
                onCancel: handleFolderNameCancel,
              }
            : null
        }
        renderBadge={(node) => {
          const doc = docOf(node);
          const sid = doc ? docStageOf(doc) : null;
          const info = sid ? (STAGE_MAP[sid] ?? getStageInfo(sid, activeLifecycleSlug)) : undefined;
          return info ? (
            <span
              className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none ${info.color} ${info.textColor}`}
            >
              {info.abbreviation}
            </span>
          ) : null;
        }}
        renderActions={(node) =>
          node.kind === 'folder' ? (
            <>
              <button
                type="button"
                tabIndex={-1}
                title="New document"
                aria-label={`New document in ${node.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCreateDoc(node.path);
                }}
                className="rounded px-1 text-xs text-slate-400 hover:text-blue-600 hover:bg-blue-50"
              >
                <svg className="h-3.5 w-3.5" aria-hidden="true" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>              </button>
              <button
                type="button"
                tabIndex={-1}
                title="New subfolder"
                aria-label={`New subfolder in ${node.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCreateFolder(node.path);
                }}
                className="rounded px-1 text-xs text-slate-400 hover:text-blue-600 hover:bg-blue-50"
              >
                <svg className="h-3.5 w-3.5" aria-hidden="true" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>              </button>
            </>
          ) : null
        }
        emptyState={emptyState}
      />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      )}

      {/* Template picker modal */}
      {showTemplatePicker && teamId && (
        <TemplatePicker
          teamId={teamId}
          onClose={() => setShowTemplatePicker(false)}
          onCreate={(data) => {
            createMutation.mutate({ ...data, teamId, path: '/' });
            setShowTemplatePicker(false);
          }}
        />
      )}

      {/* Folder ticket suggestions modal (BulkTicketReview) */}
      {bulkTicketFolderPath !== null && teamId && (
        <BulkTicketReview
          documentId={`folder:${bulkTicketFolderPath}`}
          teamId={teamId}
          open={true}
          onClose={() => setBulkTicketFolderPath(null)}
          folderPath={bulkTicketFolderPath}
        />
      )}
    </div>
  );
}
