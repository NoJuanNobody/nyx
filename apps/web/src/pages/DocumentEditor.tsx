import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Document, DocumentVersion } from '@syncdocs/shared';
import { fetchDocument, updateDocument, createVersion, fetchDiff } from '../lib/api';
import { VersionHistory } from '../components/VersionHistory';
import { Timeline } from '../components/Timeline';
import { DiffView } from '../components/DiffView';
import { Modal } from '../components/Modal';
import { AIQualityPanel } from '../components/AIQualityPanel';

type SaveState = 'saved' | 'saving' | 'unsaved';

export function DocumentEditor() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [versionMessage, setVersionMessage] = useState('');
  const [showHistory, setShowHistory] = useState(true);
  const [diffData, setDiffData] = useState<{ a: DocumentVersion; b: DocumentVersion } | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'history' | 'timeline'>('history');

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

  const handleCompare = async (versionA: DocumentVersion, versionB: DocumentVersion) => {
    try {
      const result = await fetchDiff(versionA.id, versionB.id);
      setDiffData(result);
    } catch {
      // If fetch fails, use the versions directly
      setDiffData({ a: versionA, b: versionB });
    }
  };

  const handleExitCompare = () => {
    setDiffData(null);
  };

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
    <>
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-4">
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

        <button
          type="button"
          onClick={() => setShowHistory((h) => !h)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          {showHistory ? 'Hide Sidebar' : 'Show Sidebar'}
        </button>
      </div>

      {/* Editor + Preview + History */}
      <div className="flex flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {diffData ? (
          <div className="flex-1">
            <DiffView
              oldText={diffData.a.content}
              newText={diffData.b.content}
              oldLabel={`v${diffData.a.version}`}
              newLabel={`v${diffData.b.version}`}
            />
          </div>
        ) : (
          <>
            {/* Markdown editor */}
            <div className="flex flex-1 flex-col border-r border-slate-200">
              <div className="border-b border-slate-100 px-4 py-2 text-xs font-medium text-slate-400">
                Markdown
              </div>
              <textarea
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                className="flex-1 resize-none p-4 font-mono text-sm leading-relaxed text-slate-800 outline-none"
                placeholder="Start writing your document..."
              />
            </div>
            {/* Preview */}
            <div className="flex flex-1 flex-col">
              <div className="border-b border-slate-100 px-4 py-2 text-xs font-medium text-slate-400">
                Preview
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700">
                  {content || (
                    <span className="italic text-slate-300">
                      Nothing to preview yet.
                    </span>
                  )}
                </pre>
              </div>
            </div>
          </>
        )}

        {/* Sidebar: History / Timeline */}
        {showHistory && (
          <div className="w-64 flex-shrink-0 flex flex-col border-l border-slate-200">
            {/* Tab toggle */}
            <div className="flex border-b border-slate-200">
              <button
                type="button"
                onClick={() => setSidebarTab('history')}
                className={`flex-1 px-3 py-2 text-xs font-medium ${
                  sidebarTab === 'history'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                History
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('timeline')}
                className={`flex-1 px-3 py-2 text-xs font-medium ${
                  sidebarTab === 'timeline'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Timeline
              </button>
            </div>
            {/* Tab content */}
            <div className="flex-1 overflow-hidden">
              {sidebarTab === 'history' ? (
                <VersionHistory
                  documentId={id!}
                  onCompare={handleCompare}
                  onExitCompare={handleExitCompare}
                />
              ) : (
                <Timeline documentId={id!} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* AI Quality Panel */}
      <AIQualityPanel content={content} />

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
    </>
  );
}
