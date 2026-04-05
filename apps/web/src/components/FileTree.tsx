import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document, DocumentTemplate } from '@nyx/shared';
import {
  fetchDocuments,
  fetchArchivedDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  restoreDocument,
  fetchTeams,
  fetchTemplates,
  generateFolderTicketSuggestions,
  bulkApproveSuggestions,
  dismissTicketSuggestion,
  type TicketSuggestion,
} from '../lib/api';
import { STAGE_MAP, STAGES, type DocumentStage } from '../lib/stages';
import { getLifecycle, getStageInfo, type StageInfo } from '../lib/lifecycles';
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

// ── Tree data structures ──────────────────────────────

interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}

interface DocNode {
  type: 'doc';
  doc: Document;
}

type TreeNode = FolderNode | DocNode;

function ensureFolder(root: FolderNode, folderPath: string) {
  const segments = folderPath.split('/').filter(Boolean);
  let current = root;
  let builtPath = '';
  for (const seg of segments) {
    builtPath += `/${seg}`;
    let child = current.children.find(
      (c): c is FolderNode => c.type === 'folder' && c.name === seg,
    );
    if (!child) {
      child = { type: 'folder', name: seg, path: builtPath, children: [] };
      current.children.push(child);
    }
    current = child;
  }
  return current;
}

function buildTree(docs: Document[], emptyFolders: string[]): TreeNode[] {
  const root: FolderNode = { type: 'folder', name: '', path: '/', children: [] };

  for (const folderPath of emptyFolders) {
    ensureFolder(root, folderPath);
  }

  for (const doc of docs) {
    const docPath = doc.path || '/';
    const parent = ensureFolder(root, docPath);
    parent.children.push({ type: 'doc', doc });
  }

  function sortChildren(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        const nameA = a.type === 'folder' ? a.name : a.doc.title;
        const nameB = b.type === 'folder' ? b.name : b.doc.title;
        return nameA.localeCompare(nameB);
      })
      .map((n) => {
        if (n.type === 'folder') return { ...n, children: sortChildren(n.children) };
        return n;
      });
  }

  return sortChildren(root.children);
}

/** Collect all folder paths that are descendants of the given path */
function getDescendantFolders(folders: string[], parentPath: string): string[] {
  const prefix = parentPath === '/' ? '/' : `${parentPath}/`;
  return folders.filter((f) => f === parentPath || f.startsWith(prefix));
}

// ── Inline input ──────────────────────────────────────

function InlineInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onSubmit(value.trim());
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => {
        if (value.trim()) onSubmit(value.trim());
        else onCancel();
      }}
      className="w-full bg-transparent text-xs text-slate-800 outline-none border-b border-blue-400 py-0.5"
      spellCheck={false}
    />
  );
}

// ── Folder inline input row ───────────────────────────

function NewFolderRow({
  depth,
  onSubmit,
  onCancel,
}: {
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-1"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <span className="h-3 w-3 flex-shrink-0" />
      <svg
        className="h-4 w-4 flex-shrink-0 text-blue-500"
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
      <InlineInput initial="" onSubmit={onSubmit} onCancel={onCancel} />
    </div>
  );
}

// ── Folder component ──────────────────────────────────

function Folder({
  node,
  depth,
  onCreateDoc,
  onCreateFolder,
  creatingFolderAt,
  onFolderNameSubmit,
  onFolderNameCancel,
  expandedFolders,
  toggleFolder,
  onContextMenu,
  onRenameDoc,
  renamingDocId,
  onDocRenameSubmit,
  onDocRenameCancel,
  renamingFolderPath,
  onFolderRenameSubmit,
  onFolderRenameCancel,
  onDropDoc,
}: {
  node: FolderNode;
  depth: number;
  onCreateDoc: (path: string) => void;
  onCreateFolder: (parentPath: string) => void;
  creatingFolderAt: string | null;
  onFolderNameSubmit: (parentPath: string, name: string) => void;
  onFolderNameCancel: () => void;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  onContextMenu: (
    e: React.MouseEvent,
    targetPath: string,
    targetType: 'folder' | 'doc' | 'root',
    doc?: Document,
  ) => void;
  onRenameDoc: (docId: string) => void;
  renamingDocId: string | null;
  onDocRenameSubmit: (docId: string, newTitle: string) => void;
  onDocRenameCancel: () => void;
  renamingFolderPath: string | null;
  onFolderRenameSubmit: (oldPath: string, newName: string) => void;
  onFolderRenameCancel: () => void;
  onDeleteFolder: (path: string) => void;
  onDropDoc: (docId: string, targetPath: string) => void;
}) {
  const isOpen = expandedFolders.has(node.path);
  const [showActions, setShowActions] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const isRenaming = renamingFolderPath === node.path;

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/nyx-doc-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the folder element itself, not entering a child
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const docId = e.dataTransfer.getData('application/nyx-doc-id');
    if (docId) {
      onDropDoc(docId, node.path);
    }
  };

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1 cursor-pointer rounded-md transition-colors ${
          dragOver
            ? 'bg-blue-100 ring-1 ring-blue-300'
            : 'hover:bg-slate-100/60'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => !isRenaming && toggleFolder(node.path)}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, node.path, 'folder');
        }}
      >
        {/* Chevron */}
        <svg
          className={`h-3 w-3 flex-shrink-0 text-slate-400 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>

        {/* Folder icon */}
        <svg
          className={`h-4 w-4 flex-shrink-0 ${isOpen ? 'text-blue-500' : 'text-slate-400'}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          {isOpen ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
            />
          )}
        </svg>

        {isRenaming ? (
          <InlineInput
            initial={node.name}
            onSubmit={(name) => onFolderRenameSubmit(node.path, name)}
            onCancel={onFolderRenameCancel}
          />
        ) : (
          <span className="flex-1 truncate text-xs font-medium text-slate-700">
            {node.name}
          </span>
        )}

        {/* Quick actions */}
        {showActions && !isRenaming && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              title="New document"
              onClick={(e) => {
                e.stopPropagation();
                onCreateDoc(node.path);
              }}
              className="rounded p-0.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </button>
            <button
              type="button"
              title="New subfolder"
              onClick={(e) => {
                e.stopPropagation();
                onCreateFolder(node.path);
              }}
              className="rounded p-0.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {isOpen && (
        <div>
          {node.children.map((child) =>
            child.type === 'folder' ? (
              <Folder
                key={child.path}
                node={child}
                depth={depth + 1}
                onCreateDoc={onCreateDoc}
                onCreateFolder={onCreateFolder}
                creatingFolderAt={creatingFolderAt}
                onFolderNameSubmit={onFolderNameSubmit}
                onFolderNameCancel={onFolderNameCancel}
                expandedFolders={expandedFolders}
                toggleFolder={toggleFolder}
                onContextMenu={onContextMenu}
                onRenameDoc={onRenameDoc}
                renamingDocId={renamingDocId}
                onDocRenameSubmit={onDocRenameSubmit}
                onDocRenameCancel={onDocRenameCancel}
                renamingFolderPath={renamingFolderPath}
                onFolderRenameSubmit={onFolderRenameSubmit}
                onFolderRenameCancel={onFolderRenameCancel}
                onDeleteFolder={onDeleteFolder}
                onDropDoc={onDropDoc}
              />
            ) : (
              <DocItem
                key={child.doc.id}
                doc={child.doc}
                depth={depth + 1}
                onContextMenu={onContextMenu}
                onRenameDoc={onRenameDoc}
                isRenaming={renamingDocId === child.doc.id}
                onRenameSubmit={onDocRenameSubmit}
                onRenameCancel={onDocRenameCancel}
              />
            ),
          )}

          {creatingFolderAt === node.path && (
            <NewFolderRow
              depth={depth + 1}
              onSubmit={(name) => onFolderNameSubmit(node.path, name)}
              onCancel={onFolderNameCancel}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── JSX Preview virtual file item ─────────────────────

function _JSXPreviewItem({ docId, depth }: { docId: string; depth: number }) {
  return (
    <NavLink
      to={`/documents/${docId}?layout=jsx-preview`}
      className={({ isActive }) =>
        `group/preview flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-all duration-150 ${
          isActive
            ? 'bg-gradient-to-r from-amber-50 to-orange-50 ring-1 ring-amber-200/60'
            : 'hover:bg-slate-50'
        }`
      }
      style={{ paddingLeft: `${(depth + 2) * 12 + 8}px` }}
    >
      <span
        className={`inline-flex items-center justify-center h-4 w-4 rounded flex-shrink-0 transition-colors duration-150 ${
          'bg-gradient-to-br from-amber-400 to-orange-500 group-hover/preview:from-amber-500 group-hover/preview:to-orange-600'
        }`}
      >
        <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
        </svg>
      </span>
      <span className="text-[10px] font-semibold tracking-wide uppercase text-slate-400 group-hover/preview:text-amber-700 transition-colors duration-150">
        Preview
      </span>
    </NavLink>
  );
}

// ── Document item ─────────────────────────────────────

function DocItem({
  doc,
  depth,
  onContextMenu,
  onRenameDoc,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
}: {
  doc: Document;
  depth: number;
  onContextMenu: (
    e: React.MouseEvent,
    targetPath: string,
    targetType: 'folder' | 'doc' | 'root',
    doc?: Document,
  ) => void;
  onRenameDoc: (docId: string) => void;
  isRenaming: boolean;
  onRenameSubmit: (docId: string, newTitle: string) => void;
  onRenameCancel: () => void;
}) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/nyx-doc-id', doc.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const statusDot: Record<string, string> = {
    draft: 'bg-amber-400',
    published: 'bg-green-400',
    archived: 'bg-slate-300',
  };

  const activeLifecycleSlug = useUIStore((s) => s.activeLifecycleSlug);
  const [showActions, setShowActions] = useState(false);

  return (
    <>
    <div
      className="relative"
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <NavLink
        to={`/documents/${doc.id}`}
        className={({ isActive }) =>
          `group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
            isActive
              ? 'bg-blue-50 text-blue-700'
              : 'text-slate-600 hover:bg-slate-100/60 hover:text-slate-900'
          }`
        }
        style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        onDoubleClick={(e) => {
          e.preventDefault();
          onRenameDoc(doc.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, doc.id, 'doc', doc);
        }}
      >
        <svg className="h-3.5 w-3.5 flex-shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
        {isRenaming ? (
          <div className="flex-1" onClick={(e) => e.preventDefault()}>
            <InlineInput
              initial={doc.title || 'Untitled'}
              onSubmit={(name) => onRenameSubmit(doc.id, name)}
              onCancel={onRenameCancel}
            />
          </div>
        ) : (
          <span className="flex-1 truncate text-xs">{doc.title || 'Untitled'}</span>
        )}
        {(() => {
          const stageId = (doc as Document & { stage?: string | null }).stage;
          const info = stageId ? (STAGE_MAP[stageId] ?? getStageInfo(stageId, activeLifecycleSlug)) : undefined;
          return info ? (
            <span
              className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none ${info.color} ${info.textColor}`}
            >
              {info.abbreviation}
            </span>
          ) : null;
        })()}
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusDot[doc.status] ?? 'bg-slate-300'}`} />
      </NavLink>

      {/* Hover action buttons */}
      {showActions && !isRenaming && (
        <div
          className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
        >
          <button
            type="button"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onRenameDoc(doc.id);
            }}
            className="rounded p-0.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
            </svg>
          </button>
          <button
            type="button"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onRenameSubmit(doc.id, '__DELETE__');
            }}
            className="rounded p-0.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>
        </div>
      )}
    </div>
    </>
  );
}

// ── Trash item ────────────────────────────────────────

function TrashItem({
  doc,
  onRestore,
}: {
  doc: Document;
  onRestore: (id: string) => void;
}) {
  const [showActions, setShowActions] = useState(false);

  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-slate-400 hover:bg-slate-100/60 transition-colors"
      style={{ paddingLeft: '20px' }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <svg className="h-3.5 w-3.5 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
      <span className="flex-1 truncate text-xs line-through">{doc.title || 'Untitled'}</span>
      {showActions && (
        <button
          type="button"
          title="Restore"
          onClick={() => onRestore(doc.id)}
          className="rounded p-0.5 text-slate-400 hover:text-green-600 hover:bg-green-50"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
          </svg>
        </button>
      )}
    </div>
  );
}

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
  const [showTrash, setShowTrash] = useState(false);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [bulkTicketFolderPath, setBulkTicketFolderPath] = useState<string | null>(null);
  const [folderSuggestions, setFolderSuggestions] = useState<TicketSuggestion[] | null>(null);
  const [folderSuggestionsLoading, setFolderSuggestionsLoading] = useState(false);
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const seeding = useUIStore((s) => s.seeding);
  const activeLifecycleSlug = useUIStore((s) => s.activeLifecycleSlug);
  const activeLifecycle = getLifecycle(activeLifecycleSlug);
  const activeStages = activeLifecycle.stages;

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const teamId = teams?.[0]?.id;

  const { data: documents, isLoading } = useQuery<Document[]>({
    queryKey: ['documents', teamId],
    queryFn: () => fetchDocuments(teamId!),
    enabled: !!teamId,
  });

  const { data: archivedDocs } = useQuery<Document[]>({
    queryKey: ['documents', teamId, 'archived'],
    queryFn: () => fetchArchivedDocuments(teamId!),
    enabled: !!teamId && showTrash,
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
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      navigate(`/documents/${doc.id}`);
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
      if (location.pathname === `/documents/${deletedId}`) {
        navigate('/');
      }
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
      queryClient.invalidateQueries({ queryKey: ['documents', teamId, 'archived'] });
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
      navigate(`/documents/${newDoc.id}`);
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
    if (!teamId) return;
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

    // Rename in folders list: update all descendants
    const updated = folders.map((f) => {
      if (f === oldPath) return newPath;
      if (f.startsWith(`${oldPath}/`)) return newPath + f.substring(oldPath.length);
      return f;
    });
    setFolders(updated);
    saveFolders(updated);

    // Update expanded folders
    setExpandedFolders((prev) => {
      const next = new Set<string>();
      for (const p of prev) {
        if (p === oldPath) next.add(newPath);
        else if (p.startsWith(`${oldPath}/`)) next.add(newPath + p.substring(oldPath.length));
        else next.add(p);
      }
      return next;
    });

    // Update doc paths for documents in the renamed folder
    if (documents) {
      for (const doc of documents) {
        const docPath = doc.path || '/';
        if (docPath === oldPath) {
          updateDocument(doc.id, { path: newPath });
        } else if (docPath.startsWith(`${oldPath}/`)) {
          updateDocument(doc.id, { path: newPath + docPath.substring(oldPath.length) });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
    }

    setRenamingFolderPath(null);
  };

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
  const handleGenerateFolderSuggestions = async (folderPath: string) => {
    if (!teamId || folderSuggestionsLoading) return;
    setFolderSuggestionsLoading(true);
    setApprovedIds(new Set());
    setDismissedIds(new Set());
    try {
      const suggestions = await generateFolderTicketSuggestions(teamId, folderPath);
      setFolderSuggestions(suggestions);
    } catch (err) {
      console.error('Failed to generate folder suggestions:', err);
      setFolderSuggestions([]);
    } finally {
      setFolderSuggestionsLoading(false);
    }
  };

  const handleApproveSuggestion = async (suggestionId: string) => {
    setApprovingIds((prev) => new Set(prev).add(suggestionId));
    try {
      await bulkApproveSuggestions([suggestionId], 'github');
      setApprovedIds((prev) => new Set(prev).add(suggestionId));
    } catch (err) {
      console.error('Failed to approve suggestion:', err);
    } finally {
      setApprovingIds((prev) => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });
    }
  };

  const handleDismissSuggestion = async (suggestionId: string) => {
    try {
      await dismissTicketSuggestion(suggestionId);
      setDismissedIds((prev) => new Set(prev).add(suggestionId));
    } catch (err) {
      console.error('Failed to dismiss suggestion:', err);
    }
  };

  const handleApproveAll = async () => {
    if (!folderSuggestions) return;
    const pendingIds = folderSuggestions
      .filter((s) => !approvedIds.has(s.id) && !dismissedIds.has(s.id))
      .map((s) => s.id);
    if (pendingIds.length === 0) return;
    setBulkApproving(true);
    try {
      await bulkApproveSuggestions(pendingIds, 'github');
      setApprovedIds((prev) => {
        const next = new Set(prev);
        pendingIds.forEach((id) => next.add(id));
        return next;
      });
    } catch (err) {
      console.error('Failed to bulk approve:', err);
    } finally {
      setBulkApproving(false);
    }
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
      items.push(
        { type: 'separator' },
        {
          label: 'Generate ticket suggestions',
          action: () => handleOpenFolderSuggestions(path),
        },
        { type: 'separator' },
        { label: 'Rename folder', action: () => setRenamingFolderPath(path) },
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
  const filteredDocs = (documents ?? []).filter((doc) => {
    if (stageFilter === 'all') return true;
    if (stageFilter === 'none') return !(doc as Document & { stage?: string | null }).stage;
    return (doc as Document & { stage?: string | null }).stage === stageFilter;
  });

  const tree = buildTree(filteredDocs, folders);

  const rootDocs = tree.filter((n): n is DocNode => n.type === 'doc');
  const rootFolders = tree.filter((n): n is FolderNode => n.type === 'folder');

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
            onClick={() => handleCreateFolder('/')}
            className="rounded p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Stage filter */}
      <div className="px-4 pb-2">
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-100"
        >
          <option value="all">All stages</option>
          <option value="conception">Conception</option>
          <option value="definition">Definition</option>
          <option value="architecture">Architecture</option>
          <option value="implementation">Implementation</option>
          <option value="execution">Execution</option>
          <option value="none">No stage</option>
        </select>
      </div>

      {/* Tree */}
      <div
        className="flex-1 overflow-y-auto px-1 pb-4"
        onContextMenu={(e) => {
          // Only trigger on the root scroll area itself, not on child elements
          if (e.target === e.currentTarget) {
            e.preventDefault();
            handleContextMenu(e, '/', 'root');
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/nyx-doc-id')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const docId = e.dataTransfer.getData('application/nyx-doc-id');
          if (docId) handleDropDoc(docId, '/');
        }}
      >
        {isLoading && (
          <p className="px-4 py-3 text-xs text-slate-400">Loading...</p>
        )}

        {!isLoading && (!documents || documents.length === 0) && folders.length === 0 && !creatingFolderAt && (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-slate-400 mb-3">No documents yet</p>
            <button
              type="button"
              onClick={() => handleCreateDoc('/')}
              disabled={createMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              New Document
            </button>
          </div>
        )}

        {/* Folders */}
        {rootFolders.map((folder) => (
          <Folder
            key={folder.path}
            node={folder}
            depth={0}
            onCreateDoc={handleCreateDoc}
            onCreateFolder={handleCreateFolder}
            creatingFolderAt={creatingFolderAt}
            onFolderNameSubmit={handleFolderNameSubmit}
            onFolderNameCancel={handleFolderNameCancel}
            expandedFolders={expandedFolders}
            toggleFolder={toggleFolder}
            onContextMenu={handleContextMenu}
            onRenameDoc={(docId) => setRenamingDocId(docId)}
            renamingDocId={renamingDocId}
            onDocRenameSubmit={handleDocRenameSubmit}
            onDocRenameCancel={() => setRenamingDocId(null)}
            renamingFolderPath={renamingFolderPath}
            onFolderRenameSubmit={handleFolderRenameSubmit}
            onFolderRenameCancel={() => setRenamingFolderPath(null)}
            onDeleteFolder={handleDeleteFolder}
            onDropDoc={handleDropDoc}
          />
        ))}

        {/* Inline input for new folder at root level */}
        {creatingFolderAt === '/' && (
          <NewFolderRow
            depth={0}
            onSubmit={(name) => handleFolderNameSubmit('/', name)}
            onCancel={handleFolderNameCancel}
          />
        )}

        {/* Root-level documents */}
        {rootDocs.map((node) => (
          <DocItem
            key={node.doc.id}
            doc={node.doc}
            depth={0}
            onContextMenu={handleContextMenu}
            onRenameDoc={(docId) => setRenamingDocId(docId)}
            isRenaming={renamingDocId === node.doc.id}
            onRenameSubmit={handleDocRenameSubmit}
            onRenameCancel={() => setRenamingDocId(null)}
          />
        ))}
      </div>

      {/* Trash section */}
      <div className="border-t border-slate-200">
        <button
          type="button"
          onClick={() => setShowTrash((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-2 text-xs text-slate-400 hover:bg-slate-50 transition-colors"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
          </svg>
          <span className="font-medium">Trash</span>
          {archivedDocs && archivedDocs.length > 0 && (
            <span className="ml-auto rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              {archivedDocs.length}
            </span>
          )}
          <svg
            className={`h-3 w-3 ml-auto transition-transform ${showTrash ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
        </button>

        {showTrash && (
          <div className="max-h-48 overflow-y-auto pb-2">
            {!archivedDocs || archivedDocs.length === 0 ? (
              <p className="px-4 py-2 text-[10px] text-slate-300">Trash is empty</p>
            ) : (
              archivedDocs.map((doc) => (
                <TrashItem
                  key={doc.id}
                  doc={doc}
                  onRestore={(id) => restoreMutation.mutate(id)}
                />
              ))
            )}
          </div>
        )}
      </div>

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
      {/* Folder ticket suggestions loading indicator */}
      {folderSuggestionsLoading && (
        <div
          data-testid="folder-suggestions-loading"
          className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm"
        >
          <svg
            className="h-6 w-6 animate-spin text-blue-600"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="mt-2 text-xs font-medium text-slate-500">
            Generating ticket suggestions...
          </span>
        </div>
      )}

      {/* Folder ticket suggestions panel */}
      {folderSuggestions !== null && !folderSuggestionsLoading && (
        <div
          data-testid="folder-suggestions-panel"
          className="absolute inset-0 z-30 flex flex-col bg-white"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <span className="text-xs font-semibold text-slate-700">
              Ticket Suggestions ({folderSuggestions.length})
            </span>
            <div className="flex items-center gap-1">
              {folderSuggestions.length > 0 && (
                <button
                  type="button"
                  data-testid="approve-all-suggestions"
                  onClick={handleApproveAll}
                  disabled={bulkApproving || folderSuggestions.every((s) => approvedIds.has(s.id) || dismissedIds.has(s.id))}
                  className="rounded px-2 py-1 text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {bulkApproving ? 'Creating...' : 'Create All'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setFolderSuggestions(null)}
                className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {approveError && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
                <p className="text-[10px] text-red-700">{approveError}</p>
              </div>
            )}
            {folderSuggestions.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">
                No suggestions generated.
              </p>
            ) : (
              folderSuggestions.filter((s) => !dismissedIds.has(s.id)).map((suggestion) => (
                <div
                  key={suggestion.id}
                  className={`rounded-md border p-3 transition-colors ${
                    approvedIds.has(suggestion.id)
                      ? 'border-green-200 bg-green-50'
                      : 'border-slate-200 hover:border-blue-200'
                  }`}
                >
                  <p className="text-xs font-medium text-slate-800">{suggestion.title}</p>
                  <p className="mt-1 text-[11px] text-slate-500 line-clamp-2">
                    {suggestion.description}
                  </p>
                  {suggestion.labels && suggestion.labels.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {suggestion.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                  {approvedIds.has(suggestion.id) ? (
                    <p className="mt-2 text-[10px] font-medium text-green-600">Created as GitHub Issue</p>
                  ) : (
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        data-testid={`approve-suggestion-${suggestion.id}`}
                        onClick={() => handleApproveSuggestion(suggestion.id)}
                        disabled={approvingIds.has(suggestion.id)}
                        className="rounded px-2 py-0.5 text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors"
                      >
                        {approvingIds.has(suggestion.id) ? 'Creating...' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        data-testid={`dismiss-suggestion-${suggestion.id}`}
                        onClick={() => handleDismissSuggestion(suggestion.id)}
                        className="rounded px-2 py-0.5 text-[10px] font-medium text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
