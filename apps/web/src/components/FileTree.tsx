import { useState, useRef, useEffect, useCallback } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document } from '@syncdocs/shared';
import {
  fetchDocuments,
  fetchArchivedDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  restoreDocument,
  fetchTeams,
} from '../lib/api';
import { STAGE_MAP, type DocumentStage } from '../lib/stages';
import { TemplatePicker } from './TemplatePicker';

// ── Folder persistence (localStorage) ─────────────────

const FOLDERS_KEY = 'syncdocs:folders';

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

// ── Context menu ──────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  items: { label: string; danger?: boolean; action: () => void }[];
}

function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[140px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={() => {
            item.action();
            onClose();
          }}
          className={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${
            item.danger
              ? 'text-red-600 hover:bg-red-50'
              : 'text-slate-700 hover:bg-slate-50'
          }`}
        >
          {item.label}
        </button>
      ))}
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
  onContextMenu: (e: React.MouseEvent, items: ContextMenuState['items']) => void;
  onRenameDoc: (docId: string) => void;
  renamingDocId: string | null;
  onDocRenameSubmit: (docId: string, newTitle: string) => void;
  onDocRenameCancel: () => void;
  renamingFolderPath: string | null;
  onFolderRenameSubmit: (oldPath: string, newName: string) => void;
  onFolderRenameCancel: () => void;
  onDeleteFolder: (path: string) => void;
}) {
  const isOpen = expandedFolders.has(node.path);
  const [showActions, setShowActions] = useState(false);
  const isRenaming = renamingFolderPath === node.path;

  return (
    <div>
      <div
        className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-slate-100/60 rounded-md transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => !isRenaming && toggleFolder(node.path)}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, [
            { label: 'New document', action: () => onCreateDoc(node.path) },
            { label: 'New subfolder', action: () => onCreateFolder(node.path) },
            { label: 'Rename folder', action: () => onFolderRenameSubmit(node.path, '') },
            { label: 'Delete folder', danger: true, action: () => onDeleteFolder(node.path) },
          ]);
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
  onContextMenu: (e: React.MouseEvent, items: ContextMenuState['items']) => void;
  onRenameDoc: (docId: string) => void;
  isRenaming: boolean;
  onRenameSubmit: (docId: string, newTitle: string) => void;
  onRenameCancel: () => void;
}) {
  const statusDot: Record<string, string> = {
    draft: 'bg-amber-400',
    published: 'bg-green-400',
    archived: 'bg-slate-300',
  };

  const [showActions, setShowActions] = useState(false);

  return (
    <div
      className="relative"
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
          onContextMenu(e, [
            { label: 'Rename', action: () => onRenameDoc(doc.id) },
            { label: 'Delete', danger: true, action: () => onRenameSubmit(doc.id, '__DELETE__') },
          ]);
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
        {(doc as Document & { stage?: DocumentStage | null }).stage && STAGE_MAP[(doc as Document & { stage: DocumentStage }).stage] && (
          <span
            className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none ${STAGE_MAP[(doc as Document & { stage: DocumentStage }).stage].color} ${STAGE_MAP[(doc as Document & { stage: DocumentStage }).stage].textColor}`}
          >
            {STAGE_MAP[(doc as Document & { stage: DocumentStage }).stage].abbreviation}
          </span>
        )}
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

  const handleContextMenu = (e: React.MouseEvent, items: ContextMenuState['items']) => {
    setContextMenu({ x: e.clientX, y: e.clientY, items });
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
    <div className="flex h-full flex-col">
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
      <div className="flex-1 overflow-y-auto px-1 pb-4">
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
          onClose={() => setShowTemplatePicker(false)}
          onCreate={(data) => {
            createMutation.mutate({ ...data, teamId, path: '/' });
            setShowTemplatePicker(false);
          }}
        />
      )}
    </div>
  );
}
