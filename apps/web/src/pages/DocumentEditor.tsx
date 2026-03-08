import { useState, useEffect, useRef, useCallback, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document, DocumentVersion } from '@syncdocs/shared';

import { fetchDocument, updateDocument, createVersion } from '../lib/api';

import { Modal } from '../components/Modal';
import { AIEditReview } from '../components/AIEditReview';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { DocDrawer, DocDrawerToggle, type DrawerPanel } from '../components/DocDrawer';
import { MarkdownToolbar } from '../components/MarkdownToolbar';

type SaveState = 'saved' | 'saving' | 'unsaved';

export function DocumentEditor() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [versionMessage, setVersionMessage] = useState('');
  const [aiProposedContent, setAiProposedContent] = useState<string | null>(null);
  const [editorLayout, setEditorLayout] = useState<'split' | 'editor' | 'preview'>('split');
  const [splitPercent, setSplitPercent] = useState(50);
  const [drawerPanel, setDrawerPanel] = useState<DrawerPanel | null>(null);
  const [viewingVersion, setViewingVersion] = useState<DocumentVersion | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialised = useRef(false);

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ['document', id],
    queryFn: () => fetchDocument(id!),
    enabled: !!id,
  });

  // Seed local state from fetched document (once)
  useEffect(() => {
    if (doc && !initialised.current) {
      setTitle(doc.title);
      setContent(doc.content);
      initialised.current = true;
    }
  }, [doc]);

  // Reset initialised flag when navigating to a different document
  useEffect(() => {
    initialised.current = false;
  }, [id]);

  const saveMutation = useMutation({
    mutationFn: (data: { title?: string; content?: string }) =>
      updateDocument(id!, data),
    onMutate: () => setSaveState('saving'),
    onSuccess: (updated) => {
      setSaveState('saved');
      queryClient.setQueryData(['document', id], updated);
      // Keep the file tree's document list in sync (title, path, status changes)
      queryClient.setQueriesData<Document[]>(
        { queryKey: ['documents'] },
        (old) => old?.map((d) => (d.id === updated.id ? updated : d)),
      );
    },
    onError: () => setSaveState('unsaved'),
  });

  const versionMutation = useMutation({
    mutationFn: (message: string) =>
      createVersion(id!, { message: message || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['versions', id] });
      setVersionModalOpen(false);
      setVersionMessage('');
    },
  });

  const scheduleSave = useCallback(
    (updates: { title?: string; content?: string }) => {
      setSaveState('unsaved');
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        saveMutation.mutate(updates);
      }, 500);
    },
    // saveMutation is stable via useMutation; we only depend on id changing
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    scheduleSave({ title: newTitle, content });
  };

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    scheduleSave({ title, content: newContent });
  };

  const handleApproveAIEdit = () => {
    if (aiProposedContent !== null) {
      setContent(aiProposedContent);
      scheduleSave({ title, content: aiProposedContent });
      setAiProposedContent(null);
    }
  };

  const handleRejectAIEdit = () => {
    setAiProposedContent(null);
  };

  const handleAIGenerate = (result: { title: string; content: string }) => {
    setTitle(result.title);
    setContent(result.content);
    scheduleSave({ title: result.title, content: result.content });
  };

  const handleDrawerToggle = useCallback((panel: DrawerPanel) => {
    setDrawerPanel((prev) => (prev === panel ? null : panel));
  }, []);

  const handleSelectVersion = useCallback((version: DocumentVersion | null) => {
    setViewingVersion(version);
  }, []);

  const handleSwitchToHistory = useCallback((_versionId: string) => {
    setDrawerPanel('history');
  }, []);

  const handleSplitDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const onMove = (ev: globalThis.PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Loading document...
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Document not found.
      </div>
    );
  }

  const saveIndicator: Record<SaveState, { label: string; color: string }> = {
    saved: { label: 'Saved', color: 'text-green-600' },
    saving: { label: 'Saving...', color: 'text-amber-600' },
    unsaved: { label: 'Unsaved changes', color: 'text-red-500' },
  };

  const { label: saveLabel, color: saveColor } = saveIndicator[saveState];

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable content area */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="mb-4 flex flex-shrink-0 items-center gap-4">
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-lg font-semibold text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            placeholder="Document title"
          />

          <span className={`text-xs font-medium ${saveColor}`}>{saveLabel}</span>

          <button
            type="button"
            onClick={() => setVersionModalOpen(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Save Version
          </button>

          {/* Drawer panel toggles */}
          <div className="h-5 w-px bg-slate-200" />
          <DocDrawerToggle activePanel={drawerPanel} onToggle={handleDrawerToggle} />
        </div>

        {/* Editor + Preview + Drawer */}
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {viewingVersion !== null ? (
            /* ── Read-only past version view ─────────────────── */
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex flex-shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2">
                <svg className="h-4 w-4 flex-shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
                <span className="text-xs font-medium text-amber-800">
                  Viewing version {viewingVersion.version}
                  {viewingVersion.message && <span className="font-normal text-amber-600"> — {viewingVersion.message}</span>}
                </span>
                <span className="text-[10px] text-amber-500">
                  {new Date(viewingVersion.createdAt).toLocaleString()}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setContent(viewingVersion.content);
                      scheduleSave({ title, content: viewingVersion.content });
                      setViewingVersion(null);
                    }}
                    className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700 transition-colors"
                  >
                    Restore this version
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewingVersion(null)}
                    className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-50 transition-colors"
                  >
                    Back to current
                  </button>
                </div>
              </div>

              {/* Version content — split view (read-only markdown + preview) */}
              <div className="flex min-h-0 flex-1">
                <div className="flex flex-1 flex-col overflow-hidden border-r border-slate-100">
                  <div className="flex-shrink-0 border-b border-slate-100 px-4 py-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Markdown</span>
                  </div>
                  <pre className="flex-1 overflow-y-auto whitespace-pre-wrap p-4 font-mono text-sm leading-relaxed text-slate-600">
                    {viewingVersion.content}
                  </pre>
                </div>
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="flex-shrink-0 border-b border-slate-100 px-4 py-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Preview</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    <MarkdownPreview content={viewingVersion.content} />
                  </div>
                </div>
              </div>
            </div>
          ) : aiProposedContent !== null ? (
            <AIEditReview
              originalContent={content}
              proposedContent={aiProposedContent}
              onApprove={handleApproveAIEdit}
              onReject={handleRejectAIEdit}
            />
          ) : (
            <div ref={splitContainerRef} className="flex flex-1 flex-col overflow-hidden">
              {/* Editor/Preview tab bar */}
              <div className="flex flex-shrink-0 items-center border-b border-slate-200">
                <button
                  type="button"
                  onClick={() => setEditorLayout('editor')}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${
                    editorLayout === 'editor'
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  Markdown
                </button>
                <button
                  type="button"
                  onClick={() => setEditorLayout('split')}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${
                    editorLayout === 'split'
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  Split
                </button>
                <button
                  type="button"
                  onClick={() => setEditorLayout('preview')}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${
                    editorLayout === 'preview'
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  Preview
                </button>
              </div>

              {/* Markdown formatting toolbar */}
              {editorLayout !== 'preview' && (
                <MarkdownToolbar
                  textareaRef={textareaRef as RefObject<HTMLTextAreaElement>}
                  value={content}
                  onChange={handleContentChange}
                />
              )}

              {/* Content area */}
              <div className="flex min-h-0 flex-1">
                {/* Editor pane */}
                {editorLayout !== 'preview' && (
                  <div
                    className="flex flex-col overflow-hidden"
                    style={{ width: editorLayout === 'split' ? `${splitPercent}%` : '100%' }}
                  >
                    <MarkdownEditor
                      ref={textareaRef}
                      value={content}
                      onChange={handleContentChange}
                      placeholder="Start writing your document..."
                    />
                  </div>
                )}

                {/* Resizable drag handle */}
                {editorLayout === 'split' && (
                  <div
                    onPointerDown={handleSplitDragStart}
                    className="group relative z-10 flex w-3 flex-shrink-0 cursor-col-resize items-center justify-center border-x border-slate-100 bg-slate-50/80 transition-colors hover:bg-blue-50"
                  >
                    <div className="h-10 w-1 rounded-full bg-slate-300 transition-colors group-hover:bg-blue-400 group-active:bg-blue-500" />
                  </div>
                )}

                {/* Preview pane */}
                {editorLayout !== 'editor' && (
                  <div
                    className="flex flex-col overflow-hidden"
                    style={{ width: editorLayout === 'split' ? `${100 - splitPercent}%` : '100%' }}
                  >
                    <div className="flex-1 overflow-y-auto p-4">
                      <MarkdownPreview content={content} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Right-side drawer for History / Timeline / Proposals / Audit */}
          {id && (
            <DocDrawer
              documentId={id}
              teamId={doc.teamId}
              activePanel={drawerPanel}
              onClose={() => setDrawerPanel(null)}
              onSelectVersion={handleSelectVersion}
              activeVersionId={viewingVersion?.id ?? null}
              onSwitchToHistory={handleSwitchToHistory}
              aiChat={{
                content,
                onProposedEdit: setAiProposedContent,
                isNewDocument: !content.trim(),
                onGenerate: handleAIGenerate,
                isReviewMode: aiProposedContent !== null,
              }}
            />
          )}
        </div>
      </div>

      {/* Save Version modal */}
      <Modal
        open={versionModalOpen}
        onClose={() => setVersionModalOpen(false)}
        title="Save Version"
      >
        <p className="mb-3 text-sm text-slate-500">
          Create a snapshot of the current document state with an optional
          message.
        </p>
        <input
          type="text"
          value={versionMessage}
          onChange={(e) => setVersionMessage(e.target.value)}
          placeholder="Version message (optional)"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setVersionModalOpen(false)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => versionMutation.mutate(versionMessage)}
            disabled={versionMutation.isPending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {versionMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
