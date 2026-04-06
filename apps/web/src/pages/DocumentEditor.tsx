import { useState, useEffect, useRef, useCallback, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document, DocumentVersion } from '@nyx/shared';

import { fetchDocument, updateDocument, createVersion, createDocument, seedNextStage, exportJupyterNotebook, exportPlainText, exportDocx, exportPdf } from '../lib/api';
import { STAGE_MAP, STAGES, STAGE_ORDER, type DocumentStage } from '../lib/stages';
import { getLifecycle, getNextStage as lifecycleGetNextStage, getStageInfo } from '../lib/lifecycles';
import { useUIStore } from '../stores/ui.store';

import { Modal } from '../components/Modal';
import { AIEditReview } from '../components/AIEditReview';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { DocDrawer, DocDrawerToggle, type DrawerPanel } from '../components/DocDrawer';
import { MarkdownToolbar } from '../components/MarkdownToolbar';
import { AIAdvisor } from '../components/AIAdvisor';
import { CreateTicketModal } from '../components/CreateTicketModal';
import { BulkTicketReview } from '../components/BulkTicketReview';
import { JSXPreviewPanel } from '../components/JSXPreviewPanel';
import { SaveAsTemplateButton } from '../components/SaveAsTemplateButton';
import { MeetingNoteQuality } from '../components/MeetingNoteQuality';

type SaveState = 'saved' | 'saving' | 'unsaved';

export function DocumentEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [versionMessage, setVersionMessage] = useState('');
  const [aiProposedContent, setAiProposedContent] = useState<string | null>(null);
  const [editorLayout, setEditorLayout] = useState<'split' | 'editor' | 'preview' | 'jsx-preview'>('split');
  const { seeding, setSeeding } = useUIStore();
  const [splitPercent, setSplitPercent] = useState(50);
  const [drawerPanel, setDrawerPanel] = useState<DrawerPanel | null>(null);
  const [viewingVersion, setViewingVersion] = useState<DocumentVersion | null>(null);
  const [ticketModalOpen, setTicketModalOpen] = useState(false);
  const [bulkTicketOpen, setBulkTicketOpen] = useState(false);
  const [jupyterExporting, setJupyterExporting] = useState(false);
  const [txtExporting, setTxtExporting] = useState(false);
  const [docxExporting, setDocxExporting] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [currentMockupJsx, setCurrentMockupJsx] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
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

  // Read layout from query param (for FileTree JSX preview link)
  useEffect(() => {
    if (searchParams.get('layout') === 'jsx-preview') {
      setEditorLayout('jsx-preview');
    }
  }, [searchParams]);

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

  const handleApproveAIEdit = (editedContent?: string) => {
    const finalContent = editedContent ?? aiProposedContent;
    if (finalContent !== null) {
      setContent(finalContent);
      scheduleSave({ title, content: finalContent });
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

  const docStage = (doc as Document & { stage?: DocumentStage | null })?.stage ?? null;
  const isMeetingSourced = content.trimStart().startsWith('# Meeting Notes:');
  const activeLifecycleSlug = useUIStore((s) => s.activeLifecycleSlug);
  const editorLifecycle = getLifecycle(activeLifecycleSlug);
  const editorStages = editorLifecycle.stages;
  const editorStageMap: Record<string, typeof editorStages[0]> = Object.fromEntries(
    editorStages.map((s) => [s.id, s]),
  );

  const handleStageChange = (newStage: DocumentStage | null) => {
    saveMutation.mutate({ stage: newStage } as Parameters<typeof saveMutation.mutate>[0]);
  };

  const handleSeedNextStage = async () => {
    if (!docStage || !doc) return;
    const next = lifecycleGetNextStage(docStage, activeLifecycleSlug);
    if (!next) return;

    setSeeding(true);
    try {
      const result = await seedNextStage(content, docStage, next);
      const seededContent = `<!-- Seeded from: ${doc.id} -->\n\n${result.content}`;
      // Use AI title, or extract from first markdown heading, or fall back to stage label
      let seedTitle = result.title;
      if (!seedTitle || seedTitle === 'Untitled Document') {
        const heading = result.content.match(/^#\s+(.+)$/m);
        seedTitle = heading ? heading[1].trim() : `${next.charAt(0).toUpperCase() + next.slice(1)} Document`;
      }
      const newDoc = await createDocument({
        title: seedTitle,
        content: seededContent,
        teamId: doc.teamId,
        stage: next,
      });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/documents/${newDoc.id}`);
    } catch (err) {
      console.error('Seeding failed:', err);
    } finally {
      setSeeding(false);
    }
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
    <div className="flex h-full flex-col overflow-hidden">
      {/* Main content area — editor fills all space, advisor is fixed at bottom */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Toolbar — row 1: title + stage + save state */}
        <div className="mb-2 flex flex-shrink-0 items-center gap-2 sm:gap-3 md:mb-4">
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:px-3 sm:py-2 sm:text-base md:text-lg"
            placeholder="Document title"
          />

          {/* Stage selector */}
          <div className="relative flex-shrink-0">
            <select
              value={docStage ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                handleStageChange(val ? (val as DocumentStage) : null);
              }}
              className={`rounded-md border px-1.5 py-1 text-[11px] font-medium outline-none transition-colors sm:px-2 sm:py-1.5 sm:text-xs ${
                docStage && editorStageMap[docStage]
                  ? `${editorStageMap[docStage].color} ${editorStageMap[docStage].textColor} ${editorStageMap[docStage].borderColor}`
                  : 'border-slate-200 bg-white text-slate-500'
              }`}
            >
              <option value="">No stage</option>
              {editorStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.abbreviation} {s.label}
                </option>
              ))}
            </select>
          </div>

          <span className={`hidden text-xs font-medium sm:inline ${saveColor}`}>{saveLabel}</span>
        </div>

        {/* Toolbar — row 2: action buttons + drawer toggles (icon style) */}
        <div className="mb-2 flex flex-shrink-0 items-center gap-0.5 overflow-x-auto sm:gap-1 md:mb-3">
          {/* Seed next stage */}
          {docStage && lifecycleGetNextStage(docStage, activeLifecycleSlug) && (
            <button
              type="button"
              onClick={handleSeedNextStage}
              disabled={seeding}
              title={seeding ? 'Seeding...' : `Seed ${editorStageMap[lifecycleGetNextStage(docStage, activeLifecycleSlug)!]?.label ?? 'Next'}`}
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
              </svg>
            </button>
          )}

          {/* Trace */}
          <Link
            to={`/documents/${id}/trace`}
            title="Trace"
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
          </Link>

          {/* Create Ticket */}
          <button
            type="button"
            onClick={() => setTicketModalOpen(true)}
            title="Create Ticket"
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z" />
            </svg>
          </button>

          {/* Bulk Tickets */}
          <button
            type="button"
            data-testid="bulk-generate-tickets"
            onClick={() => setBulkTicketOpen(true)}
            title="Bulk Tickets"
            className="rounded-md p-1.5 text-blue-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75 2.25 12l4.179 2.25m0-4.5 5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0 4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0-5.571 3-5.571-3" />
            </svg>
          </button>

          {/* Export */}
          <div className="relative">
            <button
              type="button"
              data-testid="export-menu-button"
              onClick={() => setExportMenuOpen((prev) => !prev)}
              title="Export"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
            </button>
            {exportMenuOpen && (
              <div
                data-testid="export-menu-dropdown"
                className="absolute left-0 top-full z-20 mt-1 min-w-[160px] rounded-md border border-slate-200 bg-white py-1 shadow-lg"
              >
                <button
                  type="button"
                  data-testid="export-pdf"
                  onClick={async () => {
                    if (!id) return;
                    setPdfExporting(true);
                    setExportMenuOpen(false);
                    try {
                      await exportPdf(id);
                    } catch (err) {
                      console.error('PDF export failed:', err);
                    } finally {
                      setPdfExporting(false);
                    }
                  }}
                  disabled={pdfExporting}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {pdfExporting ? 'Exporting...' : 'PDF (.pdf)'}
                </button>
                <button
                  type="button"
                  data-testid="export-txt"
                  onClick={async () => {
                    if (!id) return;
                    setTxtExporting(true);
                    setExportMenuOpen(false);
                    try {
                      await exportPlainText(id);
                    } catch (err) {
                      console.error('TXT export failed:', err);
                    } finally {
                      setTxtExporting(false);
                    }
                  }}
                  disabled={txtExporting}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {txtExporting ? 'Exporting...' : 'Plain Text (.txt)'}
                </button>
                <button
                  type="button"
                  data-testid="export-docx"
                  onClick={async () => {
                    if (!id) return;
                    setDocxExporting(true);
                    setExportMenuOpen(false);
                    try {
                      await exportDocx(id);
                    } catch (err) {
                      console.error('DOCX export failed:', err);
                    } finally {
                      setDocxExporting(false);
                    }
                  }}
                  disabled={docxExporting}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {docxExporting ? 'Exporting...' : 'Word (.docx)'}
                </button>
                <button
                  type="button"
                  data-testid="export-jupyter"
                  onClick={async () => {
                    if (!id) return;
                    setJupyterExporting(true);
                    setExportMenuOpen(false);
                    try {
                      await exportJupyterNotebook(id);
                    } catch (err) {
                      console.error('Jupyter export failed:', err);
                    } finally {
                      setJupyterExporting(false);
                    }
                  }}
                  disabled={jupyterExporting}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {jupyterExporting ? 'Exporting...' : 'Jupyter (.ipynb)'}
                </button>
              </div>
            )}
          </div>

          {/* Save Version */}
          <button
            type="button"
            onClick={() => setVersionModalOpen(true)}
            title="Save Version"
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" />
            </svg>
          </button>

          <SaveAsTemplateButton content={content} stage={docStage} teamId={doc.teamId} />

          {/* Separator + drawer panel toggles */}
          <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
            <div className="mx-1 h-5 w-px bg-slate-200" />
            <DocDrawerToggle activePanel={drawerPanel} onToggle={handleDrawerToggle} />
          </div>
        </div>

        {/* Editor + Preview + Drawer — fills all remaining space */}
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
                <button
                  type="button"
                  onClick={() => setEditorLayout('jsx-preview')}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${
                    editorLayout === 'jsx-preview'
                      ? 'border-b-2 border-violet-600 text-violet-600'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  JSX Preview
                </button>
              </div>

              {/* Markdown formatting toolbar */}
              {editorLayout !== 'preview' && editorLayout !== 'jsx-preview' && (
                <MarkdownToolbar
                  textareaRef={textareaRef as RefObject<HTMLTextAreaElement>}
                  value={content}
                  onChange={handleContentChange}
                />
              )}

              {/* Content area */}
              <div className="flex min-h-0 flex-1">
                {editorLayout === 'jsx-preview' ? (
                  <>
                    {/* Editor pane */}
                    <div
                      className="flex flex-col overflow-hidden"
                      style={{ width: `${splitPercent}%` }}
                    >
                      <MarkdownToolbar
                        textareaRef={textareaRef as RefObject<HTMLTextAreaElement>}
                        value={content}
                        onChange={handleContentChange}
                      />
                      <MarkdownEditor
                        ref={textareaRef}
                        value={content}
                        onChange={handleContentChange}
                        placeholder="Start writing your document..."
                      />
                    </div>
                    {/* Drag handle */}
                    <div
                      onPointerDown={handleSplitDragStart}
                      className="group relative z-10 flex w-3 flex-shrink-0 cursor-col-resize items-center justify-center border-x border-slate-100 bg-slate-50/80 transition-colors hover:bg-violet-50"
                    >
                      <div className="h-10 w-1 rounded-full bg-slate-300 transition-colors group-hover:bg-violet-400 group-active:bg-violet-500" />
                    </div>
                    {/* JSX Preview pane */}
                    <div
                      className="flex flex-col overflow-hidden border-l border-slate-100"
                      style={{ width: `${100 - splitPercent}%` }}
                    >
                      <JSXPreviewPanel
                        specContext={content}
                        onMockupReady={setCurrentMockupJsx}
                      />
                    </div>
                  </>
                ) : (
                  <>
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
                  </>
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
              onMockupReady={setCurrentMockupJsx}
              aiChat={{
                content,
                onProposedEdit: setAiProposedContent,
                isNewDocument: !content.trim(),
                onGenerate: handleAIGenerate,
                isReviewMode: aiProposedContent !== null,
                stage: docStage,
              }}
              stage={docStage}
            />
          )}
        </div>

        {/* AI Advisor — unified AI notification panel */}
        <AIAdvisor
          content={content}
          stage={docStage}
          documentId={id}
          onApplyEdit={setAiProposedContent}
          onStageChange={handleStageChange}
        />

        {/* Meeting Note Quality — shown for meeting-sourced documents */}
        {isMeetingSourced && id && (
          <MeetingNoteQuality
            documentId={id}
            content={content}
            onApply={(newContent) => {
              setContent(newContent);
              scheduleSave({ title, content: newContent });
            }}
          />
        )}
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

      <CreateTicketModal
        open={ticketModalOpen}
        onClose={() => setTicketModalOpen(false)}
        documentId={id!}
        teamId={doc.teamId}
        documentTitle={title}
        documentContent={content}
        mockupJsx={currentMockupJsx}
      />

      <BulkTicketReview
        documentId={id!}
        teamId={doc.teamId}
        open={bulkTicketOpen}
        onClose={() => setBulkTicketOpen(false)}
      />
    </div>
  );
}
